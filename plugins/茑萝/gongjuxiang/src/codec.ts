// codec.ts — 任意编码的「字节 <-> 字符串」转换
// 浏览器原生 TextDecoder 已支持 gbk/gb18030/big5/shift_jis/euc-kr/koi8-r/
// utf-16le/utf-16be/windows-1252/iso-8859-1/utf-8 等，仅 cp437 需自定义码表。
// 不再引入 iconv-lite，避免浏览器端 Buffer 依赖带来的打包风险。

export const COMMON_ENCODINGS = [
  'utf-8', 'gbk', 'gb18030', 'big5', 'shift-jis', 'euc-kr',
  'utf-16-le', 'utf-16-be', 'iso-8859-1', 'windows-1252',
  'cp437', 'koi8-r', 'tis-620',
];

const DECODE_LABELS: Record<string, string> = {
  'shift-jis': 'shift_jis',
  'utf-16-le': 'utf-16le',
  'utf-16-be': 'utf-16be',
};

// CP437 (0x80-0xFF) 解码表
const CP437: Record<number, string> = {
  0x80: 'À', 0x81: 'Á', 0x82: 'Â', 0x83: 'Ã', 0x84: 'Ä', 0x85: 'Å', 0x86: 'Æ', 0x87: 'Ç',
  0x88: 'È', 0x89: 'É', 0x8a: 'Ê', 0x8b: 'Ë', 0x8c: 'Ì', 0x8d: 'Í', 0x8e: 'Î', 0x8f: 'Ï',
  0x90: 'Ð', 0x91: 'Ñ', 0x92: 'Ò', 0x93: 'Ó', 0x94: 'Ô', 0x95: 'Õ', 0x96: 'Ö', 0x97: '×',
  0x98: 'Ø', 0x99: 'Ù', 0x9a: 'Ú', 0x9b: 'Û', 0x9c: 'Ü', 0x9d: 'Ý', 0x9e: 'Þ', 0x9f: 'ß',
  0xa0: 'à', 0xa1: 'á', 0xa2: 'â', 0xa3: 'ã', 0xa4: 'ä', 0xa5: 'å', 0xa6: 'æ', 0xa7: 'ç',
  0xa8: 'è', 0xa9: 'é', 0xaa: 'ê', 0xab: 'ë', 0xac: 'ì', 0xad: 'í', 0xae: 'î', 0xaf: 'ï',
  0xb0: 'ð', 0xb1: 'ñ', 0xb2: 'ò', 0xb3: 'ó', 0xb4: 'ô', 0xb5: 'õ', 0xb6: 'ö', 0xb7: '÷',
  0xb8: 'ø', 0xb9: 'ù', 0xba: 'ú', 0xbb: 'û', 0xbc: 'ü', 0xbd: 'ý', 0xbe: 'þ', 0xbf: 'ÿ',
  0xc0: 'Ā', 0xc1: 'ā', 0xc2: 'Ă', 0xc3: 'ă', 0xc4: 'Ą', 0xc5: 'ą', 0xc6: 'Ć', 0xc7: 'ć',
  0xc8: 'Č', 0xc9: 'č', 0xca: 'Ď', 0xcb: 'ď', 0xcc: 'Đ', 0xcd: 'đ', 0xce: 'Ē', 0xcf: 'ē',
  0xd0: 'Ĕ', 0xd1: 'ĕ', 0xd2: 'Ė', 0xd3: 'ė', 0xd4: 'Ę', 0xd5: 'ę', 0xd6: 'Ě', 0xd7: 'ě',
  0xd8: 'Ĝ', 0xd9: 'ĝ', 0xda: 'Ğ', 0xdb: 'ğ', 0xdc: 'Ġ', 0xdd: 'ġ', 0xde: 'Ģ', 0xdf: 'ģ',
  0xe0: 'Ĥ', 0xe1: 'ĥ', 0xe2: 'Ħ', 0xe3: 'ħ', 0xe4: 'Ĩ', 0xe5: 'ĩ', 0xe6: 'Ī', 0xe7: 'ī',
  0xe8: 'Ĭ', 0xe9: 'ĭ', 0xea: 'Į', 0xeb: 'į', 0xec: 'İ', 0xed: 'ı', 0xee: 'Ĳ', 0xef: 'ĳ',
  0xf0: 'Ĵ', 0xf1: 'ĵ', 0xf2: 'Ķ', 0xf3: 'ķ', 0xf4: 'ĸ', 0xf5: 'Ĺ', 0xf6: 'ĺ', 0xf7: 'Ļ',
  0xf8: 'ļ', 0xf9: 'Ľ', 0xfa: 'ľ', 0xfb: 'Ŀ', 0xfc: 'ŀ', 0xfd: 'Ł', 0xfe: 'ł', 0xff: 'ſ',
};

// 将字节按指定编码解码为字符串
export function decodeBytes(bytes: Uint8Array, enc: string, fatal = false): string {
  if (enc === 'cp437') {
    let out = '';
    for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437[b] || '�';
    return out;
  }
  const label = DECODE_LABELS[enc] || enc;
  try {
    const dec = new TextDecoder(label, { fatal });
    return dec.decode(bytes);
  } catch {
    // 浏览器不支持该标签（如 tis-620）→ 返回空串，扫描时自然被过滤
    return '';
  }
}

// 将字符串按「from」编码还原为字节（仅乱码字符串路径需要：单字节家族 + utf-16）
export function encodeStringToBytes(text: string, enc: string): Uint8Array | null {
  if (enc === 'utf-16-le' || enc === 'utf-16-be') {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (enc === 'utf-16-le') {
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = (c >> 8) & 0xff;
      } else {
        out[i * 2] = (c >> 8) & 0xff;
        out[i * 2 + 1] = c & 0xff;
      }
    }
    return out;
  }
  // 单字节：latin-1 / cp1252 / windows-1252 / iso-8859-1 等
  const singleByte =
    enc === 'latin-1' || enc === 'iso-8859-1' || enc === 'cp1252' ||
    enc === 'windows-1252' || enc === 'cp437' || enc === 'koi8-r' || enc === 'tis-620';
  if (!singleByte) return null; // gbk/big5/shift-jis/euc-kr 作为「from」在字符串路径无意义
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

// 自动探测解码：在常见编码中挑选「替换符最少」的结果
export function autoDecode(bytes: Uint8Array): string {
  const cands = [
    'utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr',
    'windows-1252', 'iso-8859-1', 'utf-16le',
  ];
  let best = '';
  let bestScore = -1;
  for (const c of cands) {
    const s = decodeBytes(bytes, c, false);
    const repl = (s.match(/�/g) || []).length;
    const score = s.length - repl * 10;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
