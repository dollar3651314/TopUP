// 测试先写（测试经理）：生产镜像和发布的 CI（.github/workflows/ci.yml）静态检查。开发不要改这个文件，有异议找测试经理改。
// 这里定下的约定（接口）：
//   - 生产镜像 job（名字不限；认法：run 里 docker build 带 --build-arg APP_ENV=production）：只在 push 到 main 时运行、needs 有 ci-ok；
//     只打、只推 <镜像>:prod-<提交号> 标签，不碰 :staging、:production、也不打不带前缀的 :<提交号>（那是测试环境镜像用的）
//   - promote-production：environment: production（管理员在 GitHub 上批准）；needs 生产镜像 job；只在 push 到 main 时；不重新构建，
//     把 :production 指到 :prod-<提交号>；不碰 :staging
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

test('promote-production：environment: production、needs 生产镜像 job、只在 push 到 main；不重新构建，把 :production 指到 :prod-<提交号>；不碰 :staging', () => {
  const b = J['promote-production'];
  assert.ok(b, `有 promote-production job（现在的 job：${Object.keys(J).join(', ')}）`);
  assert.ok(/^\s{4}environment:\s*production\s*$/m.test(b) || /^\s{4}environment:\s*\n\s{6}name:\s*production\s*$/m.test(b), 'environment: production（管理员批准）');
  assert.ok(prodImageName && needsOf(b).includes(prodImageName), `needs 生产镜像 job（${prodImageName}）`);
  const cond = ifOf(b);
  assert.match(cond, /github\.event_name\s*==\s*'push'/); assert.match(cond, /github\.ref\s*==\s*'refs\/heads\/main'/);
  const script = runs(b).join('\n');
  assert.doesNotMatch(script, /docker\s+build\s/, '不重新构建');
  assert.match(script, /:prod-\$\{?GITHUB_SHA\}?/, '来源是 :prod-$GITHUB_SHA');
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
