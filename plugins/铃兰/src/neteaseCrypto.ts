/// <reference path="../global.d.ts" />

import CryptoJS from 'crypto-js';

// 网易云 weapi/eapi 加密层（纯前端实现）
// weapi：两次 AES-128-CBC(base64 输出) + 一次 RSA(手写 BigInt) 生成 encSecKey
// eapi：MD5 签名 + AES-128-ECB(PKCS7, hex 大写) 生成 params（对齐 CloudMusicAPI / MusicStorm）
// 全部经 crypto-js 实现（插件沙箱已加载），不依赖 Web Crypto

const IV = '0102030405060708';
const SECOND_KEY = '0CoJUm6Qyw8W8jud';

// 网易云 RSA 公钥
const RSA_N =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const RSA_E = '010001';

// 对齐 MusicStorm：secretKey 用 16 位 base62 字符（AES-128 密钥，熵更足）
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomKey(len = 16): string {
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62.charAt(Math.floor(Math.random() * 62));
  return s;
}

// 网易云 weapi 的 AES-CBC 密文必须 base64 输出（对齐 CloudMusicAPI / MusicStorm crypto.ts）。
// 之前误用 Web Crypto 输出 hex：服务端按 base64 解码失败 → 所有 weapi 写接口（红心/每日推荐/用户资料）
// 静默返回空 body 假成功。这是红心反复失败的真正根因，与 csrf / cookie 无关。
async function aesCbc(text: string, key: string): Promise<string> {
  return CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text),
    CryptoJS.enc.Utf8.parse(key),
    { iv: CryptoJS.enc.Utf8.parse(IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
  ).toString();
}

// text 反转后按字节转 hex，pow(mod, e, n) -> 256 hex 字符
function rsaEncrypt(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = '';
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  const m = BigInt('0x' + hex);
  const n = BigInt('0x' + RSA_N);
  const e = BigInt('0x' + RSA_E);
  let c = 1n;
  let base = m % n;
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) c = (c * base) % n;
    base = (base * base) % n;
    exp >>= 1n;
  }
  let out = c.toString(16);
  out = out.padStart(256, '0');
  return out.slice(-256);
}

// 生成 weapi 请求体 { params, encSecKey }
// 标准流程（对齐 CloudMusicAPI / MusicStorm crypto.ts）：
//   1) 固定密钥 SECOND_KEY 加密明文 JSON → 内层密文 first（base64）
//   2) 随机密钥 b 直接加密 first（注意：外层加密的是内层密文本身，不是 JSON 包裹对象）
//   3) encSecKey = RSA(b 反转)
// 之前外层误加密 JSON.stringify({params,encSecKey})，服务端解密后拿到的不是合法内层密文 → 静默空 body。
export async function weapi(obj: Record<string, any>, csrfToken = ''): Promise<{ params: string; encSecKey: string }> {
  // csrf_token 字段必须存在（值等于 cookie 里的 __csrf，游客态为空字符串）
  const text = JSON.stringify({ ...obj, csrf_token: csrfToken });
  const b = randomKey(16);
  const first = await aesCbc(text, SECOND_KEY);
  const encSecKey = rsaEncrypt(b);
  const params = await aesCbc(first, b);
  return { params, encSecKey };
}

// eapi 通道（用于游客注册回落 / 登录），对齐 CloudMusicAPI / MusicStorm：
// 1) 对 `nobody${url}use${text}md5forencrypt` 取 MD5 得到签名 digest
// 2) data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
// 3) params = AES-128-ECB(PKCS7, EAPI_KEY) 加密 data，结果 hex 大写
const EAPI_KEY = 'e82ckenh8dichen8';

// 网易云 eapi 使用 AES-128-ECB(PKCS7)。
// Web Crypto SubtleCrypto 没有 AES-ECB，但 crypto-js 原生支持，且插件沙箱已加载 crypto-js。
function aesEcb(text: string, key: string): string {
  const k = CryptoJS.enc.Utf8.parse(key);
  const ct = CryptoJS.AES.encrypt(text, k, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
  return ct.ciphertext.toString(CryptoJS.enc.Hex).toUpperCase();
}

export async function eapi(
  url: string,
  obj: Record<string, any>,
  header?: Record<string, string>,
): Promise<{ params: string }> {
  // 对齐 MusicStorm/CloudMusicAPI：eapi 不单独塞 csrf_token 字段；
  // __csrf / MUSIC_U / MUSIC_A 以明文作为 header 字段参与 MD5 签名（见 buildEapiHeader）。
  const text = JSON.stringify({ ...obj, header });
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = CryptoJS.MD5(message).toString();
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const params = aesEcb(data, EAPI_KEY);
  return { params };
}
