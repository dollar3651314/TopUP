// 服务器磁盘用量（数据库、开户文件、日志都在这台服务器的磁盘上）。读不到时返回 null。
import { statfsSync } from 'node:fs';

export const DISK_ALERT = 0.7; // 用量超过 70% 时每日检查发邮件提醒

/** { used_mb, total_mb }：单位是 MB（整数） */
export function diskUsage(path) {
  if (!path) return null;
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    if (!total) return null;
    return { used_mb: Math.round((total - free) / 1048576), total_mb: Math.round(total / 1048576) };
  } catch { return null; }
}
