/**
 * 封面留底的文件名解读（纯函数，单独可测）
 *
 * 留底名是 `{路径哈希}_{10位秒级时间戳}_{内容哈希}.{扩展名}`（写侧见
 * `music_service.rs` 的 `write_cover_backup`）。界面上直接给这一串没意义，
 * 所以取中间那段时间戳换成日期；对不上格式就退回原文件名，不猜。
 */

const TS_RE = /_(\d{10})_/;

/** 留底完整路径 → 列表上给人看的那一行 */
export function coverBackupLabel(path: string): string {
  const name = String(path).split(/[\\/]/).pop() || String(path);
  const m = TS_RE.exec(name);
  if (!m) return name;
  const secs = Number(m[1]);
  // 只认 10 位（秒）。毫秒级时间戳也是 13 位数字，正则已经把长度钉死了，
  // 再算一次上界，防止把 9999999999 这种未来时间换成看不懂的年份。
  if (!Number.isFinite(secs) || secs < 1_000_000_000 || secs > 4_000_000_000) return name;
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return name;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
