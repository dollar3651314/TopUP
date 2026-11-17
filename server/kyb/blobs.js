// 开户文件的存储接口：
//   mode                'local'
//   head(pathname)      → { size, contentType } 或 null
//   read(pathname)      → { stream, contentType, size } 或 null
//   put(pathname, bytes, contentType)
//   del(pathnames[])
// 文件放在服务器本地目录（浏览器上传走 onboarding 的 local-upload 接口）。
// 传了 key（32 字节）时，文件内容用 AES-256-GCM 加密后再写盘：磁盘和备份里只有密文；size 仍是原文件的大小。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('TUB1');

export function sealBytes(key, bytes) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function openBytes(key, data) {
  if (!data.subarray(0, 4).equals(MAGIC)) throw new Error('not_sealed');
  const d = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  d.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([d.update(data.subarray(32)), d.final()]);
}

export function createLocalBlobs(dir, { key } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = resolve(dir);
  // 只能读写存储目录里面的文件：按"目录 + 分隔符"判断，名字以存储目录开头的相邻目录（例如 blobs-old）也不行
  const p = (pathname) => {
    const full = resolve(root, String(pathname));
    const rel = relative(root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('bad pathname');
    return full;
  };
  const meta = (f) => (existsSync(f + '.meta') ? JSON.parse(readFileSync(f + '.meta', 'utf8')) : {});
  const bytesOf = (f) => (key ? openBytes(key, readFileSync(f)) : readFileSync(f));
  return {
    mode: 'local',
    dir,
    encrypted: Boolean(key),
    async head(pathname) {
      const f = p(pathname);
      if (!existsSync(f)) return null;
      const m = meta(f);
      return { size: m.size ?? bytesOf(f).length, contentType: m.contentType || 'application/octet-stream' };
    },
    async read(pathname) {
      const f = p(pathname);
      if (!existsSync(f)) return null;
      const bytes = bytesOf(f);
      return { stream: new Blob([bytes]).stream(), contentType: meta(f).contentType || 'application/octet-stream', size: bytes.length };
    },
    async put(pathname, bytes, contentType) {
      const f = p(pathname);
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      const raw = Buffer.from(bytes);
      writeFileSync(f, key ? sealBytes(key, raw) : raw, { mode: 0o600 });
      writeFileSync(f + '.meta', JSON.stringify({ contentType, size: raw.length }), { mode: 0o600 });
    },
    async del(pathnames) {
      const fs = pathnames.map(p); // 先全部检查，有一个不合法就一个都不删
      for (const f of fs) { rmSync(f, { force: true }); rmSync(f + '.meta', { force: true }); }
    },
  };
}
