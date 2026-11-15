// 运营后台的登录检查：沿用开户后台的管理员账号（保存在 Redis 的 topup:admin），
// 所以管理员只有一套密码和验证器。签名前的验证码也用这一个验证器，并且同一个码不能用两次。
// 测试环境另有一个测试管理员（server/pay/test-admin.js）：请求头带测试令牌，只在 testAdminHash 非空（APP_ENV=staging 且配了哈希）时认；
// 它调用的要动态码的动作免动态码（能调用哪些动作由 wallet-api.js 按白名单拦）。
import { readSession } from '../kyb/auth.js';
import { matchTestAdmin, isTestAdmin } from './test-admin.js';
import { decryptJson } from '../kyb/crypto.js';
import { totpStep } from '../kyb/totp.js';

export function createAdminGate({ redis, kybKeys, testAdminHash = '', testnetCheck = null, now = () => Date.now() }) {
  const getAdmin = async () => { const raw = await redis.get('topup:admin'); return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; };
  return {
    /** 返回 { testAdmin }：管理员会话 → false；测试环境带对了测试令牌 → true。带了测试令牌请求头但不对（或这个环境没开）一律 401，不再看 Cookie */
    async requireAdmin(request) {
      const t = matchTestAdmin(request, testAdminHash);
      if (t === true) {
        // 节点是主网或查不到：这次不认（testnetCheck 见 test-admin.js）
        if (testnetCheck && !(await testnetCheck())) throw Object.assign(new Error('unauthorized'), { status: 401 });
        return { testAdmin: true };
      }
      if (t === false) throw Object.assign(new Error('unauthorized'), { status: 401 });
      const admin = await getAdmin();
      if (!admin || !readSession(kybKeys.session, request.headers.get('cookie'), admin.version, now())) throw Object.assign(new Error('unauthorized'), { status: 401 });
      return { testAdmin: false };
    },
    async verifyAdminCode(code) {
      if (testAdminHash && isTestAdmin()) return true; // 测试管理员的请求（只在白名单动作里）免动态码
      const admin = await getAdmin();
      if (!admin) return false;
      const step = totpStep(decryptJson(kybKeys.enc, admin.totp), code, now());
      if (step < 0 || step <= Number((await redis.get('topup:admin:totp-last')) || 0)) return false;
      await redis.set('topup:admin:totp-last', String(step), { ex: 180 });
      return true;
    },
  };
}
