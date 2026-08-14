// 酷狗音乐请求签名（MD5 盐签名）
//
// 酷狗网页端 / 移动端接口签名算法（逆向自官方客户端，社区已稳定多年）：
//   1) 把业务参数按「固定顺序」拼成 key=value 数组；
//   2) 在数组「头尾各包裹一次盐值」；
//   3) 整体拼成字符串后做 MD5（小写 32 位 hex），即为 signature。
//
// 网页端盐值：NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt
// Android 端盐值：OIlwieks（纯 Java 层 MD5，本模块直接用网页端盐，足够覆盖只读接口）
//
// 参数顺序：酷狗对 params 的「键名排序」敏感。社区实践（MakcRe/KuGouMusicApi）表明
// 需按 key 字典序升序排列后再拼，否则 signature 校验失败。故本模块统一按 key 排序。

const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

// 轻量 MD5 实现（与 crypto-js 同结果，避免额外依赖；与 neteaseCrypto 的 weapi 需要保持独立）。
function md5(input: string): string {
  function rotl(x: number, c: number): number {
    return (x << c) | (x >>> (32 - c));
  }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
    a = (a + q + ((x & 0xffffffff) >>> 0) + (t & 0xffffffff)) >>> 0;
    a = rotl(a, s) + b;
    return a >>> 0;
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function md5cycle(x: number[], k: number[]): number[] {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922620);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x = [a, b, c, d];
    return x;
  }
  function md5blk(s: string): number[] {
    const md5blks: number[] = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] =
        s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
  function md51(s: string): number[] {
    let n = s.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i: number;
    for (i = 64; i <= s.length; i += 64) {
      const blk = md5blk(s.substring(i - 64, i));
      state[0] = md5cycle(state, blk)[0];
      state[1] = md5cycle(state, blk)[1];
      state[2] = md5cycle(state, blk)[2];
      state[3] = md5cycle(state, blk)[3];
    }
    s = s.substring(i - 64);
    n = s.length;
    const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < n; j++) tail[j >> 2] |= s.charCodeAt(j) << ((j % 4) << 3);
    tail[n >> 2] |= 0x80 << ((n % 4) << 3);
    if (n > 55) {
      const blk = md5blk(String.fromCharCode.apply(null, tail as unknown as number[]) + '');
      state[0] = md5cycle(state, blk)[0];
      state[1] = md5cycle(state, blk)[1];
      state[2] = md5cycle(state, blk)[2];
      state[3] = md5cycle(state, blk)[3];
      for (let k = 0; k < 16; k++) tail[k] = 0;
    }
    tail[14] = n * 8;
    const lastBlk = md5blk(String.fromCharCode.apply(null, tail as unknown as number[]) + '');
    state[0] = md5cycle(state, lastBlk)[0];
    state[1] = md5cycle(state, lastBlk)[1];
    state[2] = md5cycle(state, lastBlk)[2];
    state[3] = md5cycle(state, lastBlk)[3];
    return state;
  }
  function rhex(n: number): string {
    const hexCh = '0123456789abcdef'.split('');
    let s = '';
    for (let j = 0; j < 4; j++) {
      s += hexCh[(n >> (j * 8 + 4)) & 0x0f] + hexCh[(n >> (j * 8)) & 0x0f];
    }
    return s;
  }
  function hex(x: number[]): string {
    return x.map(rhex).join('');
  }
  return hex(md51(input));
}

/**
 * 计算酷狗请求签名 signature。
 * @param params 业务参数对象（不含 signature / 空值可省略）
 * @param salt 盐值，默认网页端盐
 */
export function kugouSign(params: Record<string, any>, salt: string = WEB_SALT): string {
  // 过滤掉空值（酷狗不参与签名），按 key 字典序升序排列
  const filtered: Record<string, any> = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    filtered[k] = v;
  }
  const keys = Object.keys(filtered).sort();
  const arr = keys.map((k) => `${k}=${filtered[k]}`);
  const raw = `${salt}${arr.join('')}${salt}`;
  return md5(raw);
}

/**
 * 生成酷狗游客态所需的设备标识（dfid / mid / uuid）。
 * 酷狗对 dfid 格式要求宽松（字母数字即可），这里用稳定随机串，session 内保持一致。
 */
export function makeKugouDevice(): { dfid: string; mid: string; uuid: string; clienttime: number } {
  const rand = () => Math.random().toString(36).slice(2, 10);
  const dfid = (rand() + rand()).slice(0, 32);
  const mid = dfid;
  const uuid = dfid;
  return { dfid, mid, uuid, clienttime: Date.now() };
}

export const KUGOU_WEB_SALT = WEB_SALT;
