// config/wallets.json 一有改动就发邮件给管理员（K2：这份文件决定钱进哪个冷钱包、签名页面认哪些地址）。
// 做法：服务启动时算这份文件的 sha256，和数据库里记的上一次比较；不一样就记下新的、发一封邮件（写明环境、前后哈希、这个环境现在的公开地址）。
// web 和 worker 同时启动也只发一封：用一条带条件的 upsert，只有真正把哈希改掉的那个进程发信。不需要任何外部服务。
// 第一次运行（数据库里还没有记录）也发一封"开始记录"，之后只在改动时发。没配收件人（MAIL_TO）时只记录不发。
import { createHash } from 'node:crypto';

const KEY = 'wallets_config_hash';

/** raw：文件原文；section：这个环境的那一节（公开地址）；返回 { changed, first, sha } */
export async function checkWalletsChange(db, { raw, appEnv, section, notify, now = Date.now() }) {
  const sha = createHash('sha256').update(raw).digest('hex');
  const [prev] = await db.query(`select value from pay_meta where key = $1`, [KEY]);
  const before = prev?.value?.sha || null;
  if (before === sha) return { changed: false, first: false, sha };
  const rows = await db.query(`insert into pay_meta (key, value) values ('wallets_config_hash', $1::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now() where pay_meta.value->>'sha' is distinct from $2
    returning key`, [JSON.stringify({ sha, at: new Date(now).toISOString() }), sha]);
  if (!rows.length) return { changed: false, first: false, sha }; // 另一个进程刚记过、发过
  if (notify) {
    const lines = JSON.stringify(section ?? {}, null, 2);
    await notify(before ? `钱包配置 config/wallets.json 已更改（${appEnv}）` : `钱包配置 config/wallets.json 开始记录（${appEnv}）`,
      `${before ? '这次启动的服务用的 config/wallets.json 和上次不一样' : '第一次记录这份配置；以后它一有改动就会发邮件'}。\n`
      + `${before ? `上次 sha256：${before}\n` : ''}这次 sha256：${sha}\n\n这个环境（${appEnv}）现在的地址（公开地址，不是密钥）：\n${lines}\n\n`
      + '这份文件决定归集的钱进哪个冷钱包、签名页面认哪些地址。如果不是你合并的 PR 改的，请马上停用服务并核对。');
  }
  return { changed: true, first: !before, sha };
}
