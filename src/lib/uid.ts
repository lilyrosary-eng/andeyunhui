/** 生成带前缀的唯一 id：前缀 + base36 时间戳 + 4 位随机。原三处拷贝归一。 */
export function uid(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}