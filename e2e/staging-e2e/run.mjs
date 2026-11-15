// 跑测试环境验收用例：node e2e/staging-e2e/run.mjs [用例文件 ...]（不写文件就跑这个目录下全部 *.test.mjs）
// 由 .github/workflows/staging-e2e.yml 运行；地址和令牌从环境变量来（STAGING_URL、STAGING_TEST_ADMIN_TOKEN），不打印。
// 先确认连的是测试环境、测试管理员开着，否则一个用例都不跑。结果只在屏幕上逐条（spec），不另存报告：仓库公开，日志和报告谁都能看，
// 所以不输出接口返回的内容。用例进程只拿到它要的环境变量（地址、令牌、商户 Key），不继承整个环境；令牌由 lib.mjs 读进去后从环境里删掉。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const base = String(process.env.STAGING_URL || '').replace(/\/+$/, '');
if (!base || !process.env.STAGING_TEST_ADMIN_TOKEN) fail('需要 STAGING_URL 和 STAGING_TEST_ADMIN_TOKEN（GitHub 环境 staging-e2e 的密钥）');
let u;
try { u = new URL(base); } catch { fail('STAGING_URL 不是有效的地址'); }
const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
if (u.protocol !== 'https:' && !local) fail('STAGING_URL 要是 https:// 开头（本机 127.0.0.1 除外）');

// 只认这个目录里的用例文件（名字只能是小写字母、数字、连字符）
const NAME = /^[a-z0-9-]+\.test\.mjs$/;
const args = process.argv.slice(2).map((f) => relative(DIR, join(ROOT, f)).replace(/\\/g, '/'));
for (const f of args) if (!NAME.test(f)) fail(`只能跑 e2e/staging-e2e/ 里的 *.test.mjs：${f}`);
const files = (args.length ? args : readdirSync(DIR).filter((f) => NAME.test(f)).sort()).map((f) => join(DIR, f));
if (!files.length) fail('没有用例文件');

// 先确认是测试环境、测试管理员开着（生产的健康检查 env 是 production，也没有 test_admin）
let h = null;
try { h = await (await fetch(`${base}/api/health/`, { signal: AbortSignal.timeout(20_000) })).json(); } catch { h = null; }
if (h?.env !== 'staging') fail(`健康检查的 env 不是 staging（${h?.env ?? '没有响应'}），停止：只对测试环境跑`);
if (h?.test_admin !== true) fail('测试环境的测试管理员没开：服务器上运行 sudo topup gen-test-admin，把显示的令牌填进 GitHub 环境 staging-e2e');
console.log(`✓ 测试环境（提交 ${h.commit || '未知'}），测试管理员已开；跑 ${files.length} 个文件`);

// GITHUB_RUN_ID、GITHUB_RUN_ATTEMPT 是运行号（不是密钥）：lib.mjs 拿它给 Idempotency-Key 和造的数据打标记
const PASS = ['PATH', 'HOME', 'TMPDIR', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'STAGING_URL', 'STAGING_TEST_ADMIN_TOKEN', 'STAGING_E2E_MERCHANT_KEY', 'STAGING_E2E_MERCHANT_SECRET'];
const env = Object.fromEntries(PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
