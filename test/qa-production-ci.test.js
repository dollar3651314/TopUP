// 测试先写（测试经理）：生产镜像和发布的 CI（.github/workflows/ci.yml）静态检查。开发不要改这个文件，有异议找测试经理改。
// 这里定下的约定（接口）：
//   - 生产镜像 job（名字不限；认法：run 里 docker build 带 --build-arg APP_ENV=production）：只在 push 到 main 时运行、needs 有 ci-ok；
//     只打、只推 <镜像>:prod-<提交号> 标签，不碰 :staging、:production、也不打不带前缀的 :<提交号>（那是测试环境镜像用的）
//   - promote-production：environment: production（管理员在 GitHub 上批准）；needs 生产镜像 job；只在 push 到 main 时；不重新构建，
//     把 :production 指到刚推的那个镜像（第 2 轮起按摘要，见文件末尾）；不碰 :staging
//   - production-smoke：needs promote-production；运行 bash e2e/smoke.sh <地址> <提交号> production；地址从 env 来（仓库密钥），不写在仓库里
//   - 这三个 job 的 run: 里没有 ${{ … }}（值一律经 env: 传进去）
//   - ci.yml 里所有 uses: 都钉在 40 位提交号上
//   - 测试环境的 image job 照旧：只在 push 到 staging，APP_ENV=staging，不碰生产的标签
// 附带（不在这里测）：现有的 ci-ok 汇总 job 的 run: 里有 ${{ toJSON(needs) }}，值不来自外部输入，这次不要求改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** 按两格缩进切出 jobs 下的每个 job（名字 → 文本） */
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'ci.yml 有 jobs:');
  const out = {}; let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(l);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
}
/** job 里所有 run: 的内容（单行和 | 多行） */
function runs(body) {
  const lines = body.split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    const indent = lines[i].search(/\S/);
    if (/^[|>][-+]?\s*$/.test(m[2])) {
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') { block.push(''); continue; }
        if (lines[j].search(/\S/) <= indent) break;
        block.push(lines[j]);
      }
      out.push(block.join('\n'));
    } else out.push(m[2]);
  }
  return out;
}
const needsOf = (body) => {
  const m = body.match(/^\s{4}needs:\s*(.+)$/m);
  if (!m) return [];
  return m[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
};
const ifOf = (body) => (body.match(/^\s{4}if:\s*(.+)$/m) || [])[1] || '';
/** run 里 docker 打的标签、推的目标（-t X、docker push X、docker tag A B 的 B、imagetools create -t X） */
function targets(script) {
  const t = [];
  const s = script.replace(/\\\n/g, ' ');
  for (const m of s.matchAll(/(?:^|\s)(?:-t|--tag)\s+("?)([^\s"]+)\1/g)) t.push(m[2]);
  for (const m of s.matchAll(/docker\s+push\s+(?:-q\s+|--quiet\s+)?("?)([^\s"]+)\1/g)) t.push(m[2]);
  for (const m of s.matchAll(/docker\s+tag\s+("?)[^\s"]+\1\s+("?)([^\s"]+)\2/g)) t.push(m[3]);
  return t;
}

const J = jobs(CI);
const prodImageName = Object.keys(J).find((k) => runs(J[k]).some((r) => /docker\s+build/.test(r) && /APP_ENV=production\b/.test(r)));

test('有生产镜像 job（docker build --build-arg APP_ENV=production）：只在 push 到 main、needs ci-ok', () => {
  assert.ok(prodImageName, `ci.yml 里找不到 docker build --build-arg APP_ENV=production 的 job（现在的 job：${Object.keys(J).join(', ')}）`);
  const b = J[prodImageName];
  assert.ok(needsOf(b).includes('ci-ok'), `${prodImageName} needs 有 ci-ok`);
  const cond = ifOf(b);
  assert.match(cond, /github\.event_name\s*==\s*'push'/, `只在 push：${cond}`);
  assert.match(cond, /github\.ref\s*==\s*'refs\/heads\/main'/, `只在 main：${cond}`);
  assert.doesNotMatch(cond, /staging|pull_request|\|\|/, `条件里没有别的分支或"或"：${cond}`);
  const script = runs(b).join('\n');
  assert.match(script, /--build-arg\s+APP_ENV=production\b/);
  assert.doesNotMatch(script, /APP_ENV=staging/);
  assert.match(b, /packages:\s*write/, '推镜像要 packages: write');
});

test('生产镜像 job 只打 / 只推 :prod-<提交号>，不碰 :staging、:production、不带前缀的 :<提交号>', () => {
  assert.ok(prodImageName, '先要有生产镜像 job');
  const script = runs(J[prodImageName]).join('\n');
  const t = targets(script);
  assert.ok(t.length > 0, `找到打标签 / 推送的目标：${script}`);
  for (const x of t) {
    assert.match(x, /:prod-\$\{?GITHUB_SHA\}?$/, `只用 :prod-$GITHUB_SHA 标签：${x}`);
  }
  assert.doesNotMatch(script, /:staging\b/);
  assert.doesNotMatch(script, /:production\b/, '移动 :production 是 promote-production 的事');
});

test('promote-production：environment: production、needs 生产镜像 job、只在 push 到 main；不重新构建，只改 :production；不碰 :staging', () => {
  const b = J['promote-production'];
  assert.ok(b, `有 promote-production job（现在的 job：${Object.keys(J).join(', ')}）`);
  assert.ok(/^\s{4}environment:\s*production\s*$/m.test(b) || /^\s{4}environment:\s*\n\s{6}name:\s*production\s*$/m.test(b), 'environment: production（管理员批准）');
  assert.ok(prodImageName && needsOf(b).includes(prodImageName), `needs 生产镜像 job（${prodImageName}）`);
  const cond = ifOf(b);
  assert.match(cond, /github\.event_name\s*==\s*'push'/); assert.match(cond, /github\.ref\s*==\s*'refs\/heads\/main'/);
  const script = runs(b).join('\n');
  assert.doesNotMatch(script, /docker\s+build\s/, '不重新构建');
  // 第 2 轮：来源改为按摘要（见文件末尾"按摘要"一条），不再要求 :prod-$GITHUB_SHA 作来源
  assert.match(script, /:production\b/, '移动 :production');
  assert.doesNotMatch(script, /:staging\b/);
  for (const x of targets(script)) assert.match(x, /:production$/, `只改 :production 这一个标签：${x}`);
  assert.match(b, /packages:\s*write/);
});

test('production-smoke：needs promote-production，运行 e2e/smoke.sh <地址> <提交号> production，地址从 env 来', () => {
  const b = J['production-smoke'];
  assert.ok(b, `有 production-smoke job（现在的 job：${Object.keys(J).join(', ')}）`);
  assert.ok(needsOf(b).includes('promote-production'), 'needs promote-production');
  const script = runs(b).join('\n');
  const m = script.match(/bash\s+e2e\/smoke\.sh\s+"?\$(\w+)"?\s+(\S+)\s+"?production"?/);
  assert.ok(m, `运行 bash e2e/smoke.sh "$地址" <提交号> production：${script}`);
  assert.match(b, new RegExp(`^\\s+${m[1]}:\\s*\\$\\{\\{\\s*secrets\\.\\w+\\s*\\}\\}`, 'm'), `${m[1]} 来自仓库密钥（env:）`);
  assert.match(m[2], /GITHUB_SHA/, '提交号来自 GITHUB_SHA');
});

test('三个生产 job 的 run: 里没有 ${{ … }}（值经 env: 传）', () => {
  for (const name of [prodImageName, 'promote-production', 'production-smoke']) {
    assert.ok(name && J[name], `有 ${name || '生产镜像'} job`);
    for (const r of runs(J[name])) assert.ok(!r.includes('${{'), `${name} 的 run: 里有 \${{：${r}`);
  }
});

test('ci.yml 里所有 uses: 都钉在 40 位提交号上', () => {
  const uses = [...CI.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `没钉提交号：${u}`);
});

test('测试环境的 image job 照旧：只在 push 到 staging、APP_ENV=staging、打 :<提交号> 和 :staging，不碰生产标签', () => {
  const b = J.image;
  assert.ok(b, '有 image job');
  assert.match(ifOf(b), /refs\/heads\/staging/);
  assert.doesNotMatch(ifOf(b), /main/);
  const script = runs(b).join('\n');
  assert.match(script, /APP_ENV=staging/);
  assert.doesNotMatch(script, /APP_ENV=production|:prod-|:production\b/);
});

// ---------- 第 2 轮（复核意见）----------
// 约定（接口）：
//   - promote-production 先检查只放在 GitHub 环境 production 里的密钥 PRODUCTION_PROMOTE_GUARD（经 env: 传进来，变量名也叫 PRODUCTION_PROMOTE_GUARD）：
//     读不到（空）就 exit 1，在改 :production 标签之前。这样环境 production 没建好（GitHub 自动建出一个没有保护的同名环境）时不能上生产
//   - 生产镜像 job 有 outputs.digest（推送后的镜像摘要，写进 $GITHUB_OUTPUT 的 digest=…）；promote-production 经 env: 拿
//     needs.<生产镜像 job>.outputs.digest，先核对格式（sha256: 加 64 位十六进制，不对就 exit 1），再用 <镜像>@<摘要> 作为来源改 :production，
//     不再用 :prod-<提交号> 标签作来源
//   - deploy/README.md 写明：第一次合并到 main 之前先建好环境 production（含 PRODUCTION_PROMOTE_GUARD）
const scriptOf = (body) => runs(body).join('\n');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
/** env: 里值是 ${{ <expr> }} 的那个变量名 */
const envVarFor = (body, expr) => {
  const m = body.match(new RegExp(`^\\s+(\\w+):\\s*\\$\\{\\{\\s*${esc(expr)}\\s*\\}\\}`, 'm'));
  return m ? m[1] : null;
};

test('promote-production：改标签之前先检查环境 production 专有的密钥 PRODUCTION_PROMOTE_GUARD，读不到就失败', () => {
  const b = J['promote-production'];
  assert.ok(b, '有 promote-production');
  assert.equal(envVarFor(b, 'secrets.PRODUCTION_PROMOTE_GUARD'), 'PRODUCTION_PROMOTE_GUARD', 'env: PRODUCTION_PROMOTE_GUARD: ${{ secrets.PRODUCTION_PROMOTE_GUARD }}');
  const script = scriptOf(b);
  const v = '"\\$\\{?PRODUCTION_PROMOTE_GUARD\\}?"';
  const guard = script.search(new RegExp(`(\\[\\s+-z\\s+${v}\\s+\\][^\\n]*exit 1|\\[\\s+-n\\s+${v}\\s+\\]\\s*\\|\\|[^\\n]*exit 1)`));
  assert.ok(guard >= 0, `run 里有 [ -z "$PRODUCTION_PROMOTE_GUARD" ] … exit 1（或 [ -n … ] || … exit 1）：\n${script}`);
  const move = script.search(/:production\b/);
  assert.ok(move >= 0 && guard < move, '检查在改 :production 之前');
  for (const l of script.split('\n')) {
    if (/PRODUCTION_PROMOTE_GUARD/.test(l) && /\b(echo|printf)\b/.test(l)) assert.ok(/\[\s+-[zn]\s/.test(l), `不打印这个密钥：${l}`);
  }
});

test('生产镜像 job 输出镜像摘要（outputs.digest）；promote-production 按摘要改 :production，先核对摘要格式', () => {
  assert.ok(prodImageName, '有生产镜像 job');
  const img = J[prodImageName];
  assert.match(img, /^\s{4}outputs:\s*\n\s{6}digest:\s*\$\{\{\s*steps\.[\w-]+\.outputs\.digest\s*\}\}/m, `${prodImageName} 有 outputs.digest（来自某一步的 outputs.digest）`);
  assert.match(scriptOf(img), /digest=[^\n]*>>\s*"?\$GITHUB_OUTPUT"?/, '推送后把 digest=… 写进 $GITHUB_OUTPUT');
  const b = J['promote-production'];
  assert.ok(b, '有 promote-production');
  const v = envVarFor(b, `needs.${prodImageName}.outputs.digest`);
  assert.ok(v, `promote-production 经 env: 拿 needs.${prodImageName}.outputs.digest`);
  const script = scriptOf(b);
  const ref = `\\$\\{?${v}\\}?`;
  assert.ok(script.split('\n').some((l) => new RegExp(ref).test(l) && /sha256:\[0-9a-f\]\{64\}/.test(l) && /exit 1|\|\|/.test(l)),
    `核对 $${v} 是 sha256:[0-9a-f]{64}，不对就失败：\n${script}`);
  const create = script.split('\n').find((l) => /imagetools\s+create|docker\s+tag|docker\s+push/.test(l) && /:production\b/.test(l));
  assert.ok(create, `有改 :production 的那一行：\n${script}`);
  assert.match(create, new RegExp(`@"?${ref}`), `来源是 <镜像>@$${v}：${create}`);
  assert.doesNotMatch(create, /:prod-/, `来源不再是 :prod-<提交号> 标签：${create}`);
});

test('deploy/README.md 写明：第一次合并到 main 之前先建好环境 production（含 PRODUCTION_PROMOTE_GUARD）', () => {
  const md = readFileSync(join(ROOT, 'deploy/README.md'), 'utf8');
  const paras = md.split(/\n\s*\n/);
  assert.ok(paras.some((p) => /PRODUCTION_PROMOTE_GUARD/.test(p) && /production/.test(p) && /main/.test(p) && /(之前|以前)/.test(p)),
    'README 有一段同时写了 PRODUCTION_PROMOTE_GUARD、环境 production、main 和"之前"');
});
