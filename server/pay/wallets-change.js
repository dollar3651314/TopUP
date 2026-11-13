// config/wallets.json 一有改动就发邮件给管理员（K2：这份文件决定钱进哪个冷钱包、签名页面认哪些地址）。
// 做法：服务启动时算这份文件的 sha256，和数据库里记的上一次（pay_meta 的 wallets_config_hash）比较；不一样就发一封邮件
// （写明环境、前后哈希、这个环境现在的公开地址）。不需要任何外部服务。
//   - web、worker 同时启动也只发一封：先用一条带条件的 upsert"认领"这次改动（value.notified = false），只有认领到的进程发信
//   - 邮件发成功才记 notified = true；发信失败就把记录恢复成上一次的，下次启动重试
//   - 第一次运行（数据库里还没有记录）发一封"开始记录"，之后只在改动时发
//   - 没配收件人（notify 为空，MAIL_TO 没填）：只记录（mail = 'not_configured'），之后补配收件人也不补发这一次；
//     这时健康检查的 mail 本来就是 false（整体 503），wallet.config_watch 也标出没通知
// notify 要在发信失败时抛出（deps.js 传的是不吞错误的发信函数）。
import { createHash } from 'node:crypto';

const KEY = 'wallets_config_hash';

/** raw：文件原文；section：这个环境的那一节（公开地址）；返回 { changed, first, sha, notified } */
export async function checkWalletsChange(db, { raw, appEnv, section, notify, now = Date.now() }) {
  const sha = createHash('sha256').update(raw).digest('hex');
  const [prev] = await db.query(`select value from pay_meta where key = $1`, [KEY]);
  const before = prev?.value?.sha || null;
  if (before === sha) return { changed: false, first: false, sha, notified: false };
  const at = new Date(now).toISOString();
  const claim = notify ? { sha, at, notified: false } : { sha, at, notified: false, mail: 'not_configured' };
  const rows = await db.query(`insert into pay_meta (key, value) values ('wallets_config_hash', $1::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now() where pay_meta.value->>'sha' is distinct from $2
    returning key`, [JSON.stringify(claim), sha]);
  if (!rows.length) return { changed: false, first: false, sha, notified: false }; // 另一个进程刚认领了这次改动
  if (!notify) return { changed: true, first: !before, sha, notified: false };
  const lines = JSON.stringify(section ?? {}, null, 2);
  try {
    await notify(before ? `钱包配置 config/wallets.json 已更改（${appEnv}）` : `钱包配置 config/wallets.json 开始记录（${appEnv}）`,
      `${before ? '这次启动的服务用的 config/wallets.json 和上次不一样' : '第一次记录这份配置；以后它一有改动就会发邮件'}。\n`
      + `${before ? `上次 sha256：${before}\n` : ''}这次 sha256：${sha}\n\n这个环境（${appEnv}）现在的地址（公开地址，不是密钥）：\n${lines}\n\n`
      + '这份文件决定归集的钱进哪个冷钱包、签名页面认哪些地址。如果不是你合并的 PR 改的，请马上停用服务并核对。');
  } catch (e) {
    // 发信失败：恢复成上一次的记录，下次启动重试
    if (prev) await db.query(`update pay_meta set value = $2::jsonb, updated_at = now() where key = $1 and value->>'sha' = $3`, [KEY, JSON.stringify(prev.value), sha]).catch(() => {});
    else await db.query(`delete from pay_meta where key = $1 and value->>'sha' = $2`, [KEY, sha]).catch(() => {});
    throw Object.assign(new Error(`wallets.json change mail failed: ${e?.message || e}`), { cause: e });
  }
  await db.query(`update pay_meta set value = value || '{"notified": true}'::jsonb, updated_at = now() where key = $1 and value->>'sha' = $2`, [KEY, sha]);
  return { changed: true, first: !before, sha, notified: true };
}

/** 健康检查用：{ mail（收件人配没配）, sha 前 12 位, notified, at }；没有记录时 notified 为 null */
export async function walletsWatchStatus(db, { mailConfigured }) {
  const [r] = await db.query(`select value from pay_meta where key = $1`, [KEY]);
  const v = r?.value || null;
  return { mail: Boolean(mailConfigured), notified: v ? Boolean(v.notified) : null, sha: v?.sha ? v.sha.slice(0, 12) : null, at: v?.at || null, ok: Boolean(mailConfigured) && Boolean(v?.notified) };
}
