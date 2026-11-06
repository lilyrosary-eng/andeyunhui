// RFC 4648 base32 解码 + RFC 6238 TOTP（HMAC-SHA1 / 30s / 6 位）。
// 只用于「库内条目展示动态码」，不作为库本身的解锁门禁：
// 本地 TOTP 种子必须存在库里，而库又是主密码可解的 —— 拿文件+主密码的人一样能算出码，
// 所以把它当解锁第二因子是安全剧场。解锁第二因子应走 WebAuthn/平台认证器（见 P0-bio 探针）。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`base32 含非法字符「${ch}」`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

/** 一个 TOTP 周期内的进度（0 = 刚出码，1 = 即将过期）。 */
export function totpProgress(timestampMs = Date.now(), period = 30): number {
  return (timestampMs % (period * 1000)) / (period * 1000);
}

export function totpRemainingSec(timestampMs = Date.now(), period = 30): number {
  return Math.ceil((period * 1000 - (timestampMs % (period * 1000))) / 1000);
}

/** 计算某个时间点的 TOTP。时间戳默认当前时间；返回纯数字串。 */
export async function totp(
  secret: string,
  timestampMs: number = Date.now(),
  period = 30,
  digits = 6,
): Promise<string> {
  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) throw new Error('TOTP 种子为空');

  const counter = Math.floor(timestampMs / 1000 / period);
  const message = new Uint8Array(8);
  let rest = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, message as unknown as BufferSource),
  );
  const offset = raw[raw.length - 1] & 0x0f;
  const binary =
    ((raw[offset] & 0x7f) << 24) |
    ((raw[offset + 1] & 0xff) << 16) |
    ((raw[offset + 2] & 0xff) << 8) |
    (raw[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}
