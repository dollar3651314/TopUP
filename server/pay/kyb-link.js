// 收付款和开户的衔接：开户审核通过的企业，出现在运营后台"商户"页面的"待开通"列表里。
// 授权联系人邮箱：取人员里的授权联系人，及以前取开户表第 ③ 步；已登记的提现钱包取开户表第 ⑥ 步的钱包地址。
import { isValidAddress } from './tron.js';

/** 待审核的开户申请数量（运营后台"概览"的待处理） */
export function pendingKybCount(repo) {
  return async () => (await repo.list()).filter((a) => repo.effectiveStatus(a) === 'submitted').length;
}

export function approvedFromKyb(repo) {
  return async function listApproved() {
    const apps = await repo.list();
    const out = [];
    for (const a of apps) {
      if (repo.effectiveStatus(a) !== 'approved') continue;
      let p = {}; try { p = repo.open(a); } catch { continue; }
      const form = p.form || {};
      const wallet = form.wallet?.address && isValidAddress(form.wallet.address) ? [form.wallet.address] : [];
      const contact = (form.people || []).find((x) => (x.roles || []).includes('contact'));
      out.push({ ref: a.ref, company: a.company, email: contact?.email || form.rep?.email || p.email || '', cashout_wallets: wallet });
    }
    return out;
  };
}
