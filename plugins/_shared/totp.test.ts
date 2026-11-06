// TOTP 单测：用 RFC 6238 附录 B 的标准测试向量（SHA-1, 8 位），
// 以及 base32 编解码往返，确认截断与字节序没写反。
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totp, totpProgress, totpRemainingSec } from './totp';

// ASCII "12345678901234567890"
const SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('解码已知向量', () => {
    const raw = new TextDecoder().decode(base32Decode(SEED_B32));
    expect(raw).toBe('12345678901234567890');
  });

  it('编解码往返（含无填充长度）', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0x7f]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('容忍空格/连字符/小写/填充', () => {
    expect(base32Decode('gezd gnbv-gy3t qojq')).toEqual(base32Decode('GEZDGNBVGY3TQOJQ'));
    expect(base32Decode('GEZDGNBVGY3TQOJQ====')).toEqual(base32Decode('GEZDGNBVGY3TQOJQ'));
  });

  it('非法字符抛错', () => {
    expect(() => base32Decode('AB1D')).toThrow();
  });
});

describe('totp', () => {
  it('RFC 6238 标准向量（SHA-1, 8 位）', async () => {
    expect(await totp(SEED_B32, 59_000, 30, 8)).toBe('94287082');
    expect(await totp(SEED_B32, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(await totp(SEED_B32, 1_111_111_111_000, 30, 8)).toBe('14050471');
    expect(await totp(SEED_B32, 2_000_000_000_000, 30, 8)).toBe('69279037');
  });

  it('6 位输出是 8 位向量的后 6 位', async () => {
    expect(await totp(SEED_B32, 59_000, 30, 6)).toBe('287082');
  });

  it('同一周期内稳定，跨周期变化', async () => {
    const a = await totp(SEED_B32, 30_000);
    const b = await totp(SEED_B32, 59_999);
    const c = await totp(SEED_B32, 60_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('进度与剩余秒数一致', () => {
    expect(totpProgress(0)).toBe(0);
    expect(totpRemainingSec(0)).toBe(30);
    expect(totpProgress(15_000)).toBeCloseTo(0.5);
    expect(totpRemainingSec(29_500)).toBe(1);
  });
});
