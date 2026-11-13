// 运营后台的登录检查：沿用开户后台的管理员账号（保存在 Redis 的 topup:admin），
// 所以管理员只有一套密码和验证器。签名前的验证码也用这一个验证器，并且同一个码不能用两次。
import { readSession } from '../kyb/auth.js';
import { decryptJson } from '../kyb/crypto.js';
import { totpStep } from '../kyb/totp.js';

export function createAdminGate({ redis, kybKeys, now = () => Date.now() }) {
  const getAdmin = async () => { const raw = await redis.get('topup:admin'); return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; };
  return {
    async requireAdmin(request) {
      const admin = await getAdmin();
      if (!admin || !readSession(kybKeys.session, request.headers.get('cookie'), admin.version, now())) throw Object.assign(new Error('unauthorized'), { status: 401 });
    },
    async verifyAdminCode(code) {
      const admin = await getAdmin();
      if (!admin) return false;
      const step = totpStep(decryptJson(kybKeys.enc, admin.totp), code, now());
      if (step < 0 || step <= Number((await redis.get('topup:admin:totp-last')) || 0)) return false;
      await redis.set('topup:admin:totp-last', String(step), { ex: 180 });
      return true;
    },
  };
}
