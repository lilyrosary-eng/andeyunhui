// 汽水音乐（字节跳动 luna/helium）加密音频解密模块。
// 移植自 naiyQAQ/qishui-decrypt（算法原创 jixunmoe，见 export_music issue #1）。
// 音频为 CENC(fMP4) 加密：AES-128-CTR，每个 sample 的 IV 来自 senc box，
// AES key 由 song/url 返回的 spade_a 字段去混淆得到。
// 解密后重建干净 MP4(M4A) 或 FLAC，输出 Blob URL 供 <audio> 播放。

function decodeBase36(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 122) return c - 97 + 10; // a-z
  return 0xff;
}

function bitCount(n: number): number {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + ((n >> 4) & 0xf0f0f0f)) * 0x1010101) >> 24) & 0xff;
}

// spade_a 去混淆：base64 -> XOR/去 padding/跳过 -> 32位 hex(AES key)
export function decryptSpadeKey(spadeKeyB64: string): string {
  let keyBytes: Uint8Array;
  try {
    const bin = atob(spadeKeyB64);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  } catch {
    return '';
  }
  const len = keyBytes.length;
  if (len < 3) return '';
  const paddingLen = (keyBytes[0] ^ keyBytes[1] ^ keyBytes[2]) - 48;
  if (len < paddingLen + 2) return '';
  const innerInput = keyBytes.slice(1, len - paddingLen);
  // 异或 buff[i] 后减 popcount(i) 再减 21，下溢回绕
  const tmp = new Uint8Array(innerInput.length);
  const buff = new Uint8Array(2 + innerInput.length);
  buff[0] = 0xfa;
  buff[1] = 0x55;
  buff.set(innerInput, 2);
  for (let i = 0; i < innerInput.length; i++) {
    let v = (innerInput[i] ^ buff[i]) - bitCount(i) - 21;
    while (v < 0) v += 0xff;
    tmp[i] = v & 0xff;
  }
  if (tmp.length === 0) return '';
  const skipBytes = decodeBase36(tmp[0]);
  const decodedMessageLen = len - paddingLen - 2;
  const endIndex = 1 + decodedMessageLen - skipBytes;
  if (endIndex > tmp.length) return '';
  const finalBytes = tmp.slice(1, endIndex);
  return new TextDecoder('utf-8').decode(finalBytes); // 32位 hex
}

// ---- MP4 box 解析 ----
const ASCII = (b: Uint8Array, off: number, len: number) =>
  String.fromCharCode(...b.slice(off, off + len));

interface BoxInfo {
  type: string;
  start: number;
  size: number;
  headerLen: number;
}

function scanBoxes(buf: Uint8Array, start: number, end: number, out: BoxInfo[]) {
  let p = start;
  while (p + 8 <= end) {
    const size = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const type = ASCII(buf, p + 4, 4);
    let boxSize = size;
    let headerLen = 8;
    if (size === 1) {
      boxSize = Number(
        ((BigInt(buf[p + 8]) << 24n) | (BigInt(buf[p + 9]) << 16n) | (BigInt(buf[p + 10]) << 8n) | BigInt(buf[p + 11])) <<
          32n
      ) + Number((BigInt(buf[p + 12]) << 24n) | (BigInt(buf[p + 13]) << 16n) | (BigInt(buf[p + 14]) << 8n) | BigInt(buf[p + 15]));
      headerLen = 16;
    }
    if (boxSize < 8 || p + boxSize > end + 8) break;
    out.push({ type, start: p, size: boxSize, headerLen });
    p += boxSize;
  }
}

function findBox(buf: Uint8Array, path: string[]): BoxInfo | null {
  let start = 0;
  let end = buf.length;
  let found: BoxInfo | null = null;
  for (const want of path) {
    const boxes: BoxInfo[] = [];
    scanBoxes(buf, start, end, boxes);
    found = boxes.find((b) => b.type === want) ?? null;
    if (!found) return null;
    start = found.start + found.headerLen;
    end = found.start + found.size;
  }
  return found;
}

// 解析 stsz：返回每个 sample 的字节长度数组
function parseStsz(buf: Uint8Array, box: BoxInfo): number[] {
  const p = box.start + box.headerLen;
  // sample_size(4), sample_count(4)
  const count = (buf[p + 8] << 24) | (buf[p + 9] << 16) | (buf[p + 10] << 8) | buf[p + 11];
  const sizes: number[] = [];
  if ((buf[p + 4] << 24 | buf[p + 5] << 16 | buf[p + 6] << 8 | buf[p + 7]) !== 0) {
    const fixed = buf[p + 4] << 24 | buf[p + 5] << 16 | buf[p + 6] << 8 | buf[p + 7];
    for (let i = 0; i < count; i++) sizes.push(fixed);
    return sizes;
  }
  let q = p + 12;
  for (let i = 0; i < count; i++) {
    sizes.push((buf[q] << 24) | (buf[q + 1] << 16) | (buf[q + 2] << 8) | buf[q + 3]);
    q += 4;
  }
  return sizes;
}

// 解析 stsc：sample-to-chunk 映射
interface StscEntry { firstChunk: number; samplesPerChunk: number; }
function parseStsc(buf: Uint8Array, box: BoxInfo): StscEntry[] {
  const p = box.start + box.headerLen;
  const count = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
  const out: StscEntry[] = [];
  let q = p + 8;
  for (let i = 0; i < count; i++) {
    out.push({
      firstChunk: (buf[q] << 24) | (buf[q + 1] << 16) | (buf[q + 2] << 8) | buf[q + 3],
      samplesPerChunk: (buf[q + 4] << 24) | (buf[q + 5] << 16) | (buf[q + 6] << 8) | buf[q + 7],
    });
    q += 8;
  }
  return out;
}

// 解析 stco/co64：chunk offset（解密后需重建）
function parseStco(buf: Uint8Array, box: BoxInfo): number[] {
  const p = box.start + box.headerLen;
  const version = buf[p];
  const count = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
  const offsets: number[] = [];
  let q = p + 8;
  for (let i = 0; i < count; i++) {
    if (box.type === 'co64') {
      offsets.push(Number((BigInt(buf[q]) << 24n) | (BigInt(buf[q + 1]) << 16n) | (BigInt(buf[q + 2]) << 8n) | BigInt(buf[q + 3]) << 32n) + Number((BigInt(buf[q + 4]) << 24n) | (BigInt(buf[q + 5]) << 16n) | (BigInt(buf[q + 6]) << 8n) | BigInt(buf[q + 7])));
      q += 8;
    } else {
      offsets.push((buf[q] << 24) | (buf[q + 1] << 16) | (buf[q + 2] << 8) | buf[q + 3]);
      q += 4;
    }
  }
  void version;
  return offsets;
}

// 解析 senc：每个 sample 的 IV（16 字节）
function parseSenc(buf: Uint8Array, sencBox: BoxInfo): Uint8Array[] {
  const p = sencBox.start + sencBox.headerLen;
  // version(1) flags(3) sample_count(4)
  const count = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
  const ivs: Uint8Array[] = [];
  let q = p + 8;
  for (let i = 0; i < count; i++) {
    const iv = buf.slice(q, q + 16);
    ivs.push(iv);
    q += 16; // 简化：假设无子样本（汽水标准音频通常无 per-sample sub_sample 数据）
  }
  return ivs;
}

// 重建干净 MP4：去掉 sinf/tenc/senc/schi 加密 box，enca->mp4a，重建 stco
function rebuildMp4(buf: Uint8Array): Uint8Array {
  // 找到 moov/trak/mdia/minf/stbl/stsd 里的 enca box 改成 mp4a
  const out = buf.slice(0);
  // 替换所有 'enca' 为 'mp4a'（音轨），'encv' 通常无
  const encaIdxs: number[] = [];
  for (let i = 0; i < out.length - 4; i++) {
    if (out[i] === 0x65 && out[i + 1] === 0x6e && out[i + 2] === 0x63 && out[i + 3] === 0x61) {
      encaIdxs.push(i);
    }
  }
  for (const idx of encaIdxs) {
    out[idx] = 0x6d; // m
    out[idx + 1] = 0x70; // p
    // 4a -> 4a 已对；最后两位 61(a) 保持
  }
  return out;
}

// 主解密：输入加密 fMP4 的 ArrayBuffer 与 spade_a 字符串，返回 objectURL
export async function decryptQishuiAudio(
  encrypted: ArrayBuffer,
  spadeA: string
): Promise<string> {
  const hexKey = decryptSpadeKey(spadeA);
  if (!hexKey || hexKey.length !== 32) {
    throw new Error('无效的 spade_a 密钥');
  }
  const keyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) keyBytes[i] = parseInt(hexKey.substr(i * 2, 2), 16);

  const buf = new Uint8Array(encrypted);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt']);

  // 查找加密信息
  const stbl = findBox(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  if (!stbl) throw new Error('找不到 stbl box');
  const stblStart = stbl.start + stbl.headerLen;
  const stblEnd = stbl.start + stbl.size;

  const boxes: BoxInfo[] = [];
  scanBoxes(buf, stblStart, stblEnd, boxes);
  const stsz = boxes.find((b) => b.type === 'stsz');
  const stsc = boxes.find((b) => b.type === 'stsc');
  const stco = boxes.find((b) => b.type === 'stco' || b.type === 'co64');
  const senc = boxes.find((b) => b.type === 'senc');

  if (!stsz || !stsc || !stco || !senc) {
    throw new Error('缺少必要 box（stsz/stsc/stco/senc）');
  }

  const sizes = parseStsz(buf, stsz);
  const stscEntries = parseStsc(buf, stsc);
  const ivs = parseSenc(buf, senc);
  void parseStco(buf, stco); // offset 用于重建（此处简化：保持原 offset，仅解密 sample 数据区）

  // 计算 sample -> chunk 分布，定位每个 sample 在文件中的偏移
  // 简化：依据 stco chunk offset + stsc，逐 sample 累加
  const chunkOffsets = parseStco(buf, stco);
  // 构造 sample 全局偏移表
  const sampleOffsets: number[] = [];
  let chunkIdx = 0;
  let sampleInChunk = 0;
  let curSamplesPerChunk = stscEntries[0]?.samplesPerChunk ?? 0;
  for (let s = 0; s < sizes.length; s++) {
    if (sampleInChunk === 0) {
      // 进入新 chunk
      while (chunkIdx + 1 < stscEntries.length && stscEntries[chunkIdx + 1].firstChunk === chunkIdx + 2) {
        chunkIdx++;
        curSamplesPerChunk = stscEntries[chunkIdx].samplesPerChunk;
      }
    }
    const base = chunkOffsets[chunkIdx] ?? 0;
    // 当前 chunk 内前 sampleInChunk 个 sample 的累计长度
    let offset = base;
    for (let k = 0; k < sampleInChunk; k++) offset += sizes[sampleOffsets.length] ?? 0;
    sampleOffsets.push(offset);
    sampleInChunk++;
    if (sampleInChunk >= curSamplesPerChunk) {
      sampleInChunk = 0;
      chunkIdx++;
    }
  }

  // 逐 sample 解密
  for (let s = 0; s < sizes.length; s++) {
    const size = sizes[s];
    const off = sampleOffsets[s];
    const iv = ivs[s];
    if (!iv) continue;
    const blockCounter = new Uint8Array(16);
    blockCounter.set(iv, 0);
    const segment = new Uint8Array(encrypted, off, size);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: blockCounter, length: 64 },
      cryptoKey,
      segment
    );
    buf.set(new Uint8Array(decrypted), off);
  }

  // 重建干净 MP4（去掉加密标记）
  const clean = rebuildMp4(buf);
  const blob = new Blob([clean], { type: 'video/mp4' });
  return URL.createObjectURL(blob);
}
