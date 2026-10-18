// Phase 3 真机验证（游客注册端点修正版）：用 /weapi/register/anonimous 拿 MUSIC_A 再搜索
import CryptoJS from 'crypto-js';

const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const PUBKEY = '010001';
const NONCE = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';

function randomHex(len, upper = false) {
  const chars = upper ? '0123456789ABCDEF' : '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function aesCbc(text, key, iv) {
  return CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(text), CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse(iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
  }).toString();
}
function rsaEncrypt(text) {
  const bt = CryptoJS.enc.Utf8.parse(text).toString(CryptoJS.enc.Hex);
  const e = BigInt('0x' + PUBKEY), n = BigInt('0x' + MODULUS), m = BigInt('0x' + bt);
  let hex = (m ** e % n).toString(16);
  while (hex.length < 256) hex = '0' + hex;
  return hex;
}
function weapi(text) {
  const secKey = randomHex(16);
  const first = aesCbc(text, NONCE, IV);
  return { params: aesCbc(first, secKey, IV), encSecKey: rsaEncrypt(secKey) };
}

const deviceId = randomHex(52, true);
const BASE = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 1) 游客匿名注册（当前可用端点 /weapi/register/anonimous）
const regData = { csrf_token: '' };
const regEnc = weapi(JSON.stringify(regData));
const regResp = await fetch(`${BASE}/weapi/register/anonimous`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Referer': BASE + '/' },
  body: `params=${encodeURIComponent(regEnc.params)}&encSecKey=${encodeURIComponent(regEnc.encSecKey)}`,
});
console.log('REG STATUS:', regResp.status);
const regRaw = await regResp.text();
console.log('REG RAW:', regRaw.slice(0, 600));
const regJson = (() => { try { return JSON.parse(regRaw); } catch { return null; } })();
console.log('REG JSON:', JSON.stringify(regJson).slice(0, 500));

// 2) 提取 MUSIC_A（典型：regJson.cookie 含 MUSIC_A，或 regJson.data.MUSIC_A）
let musicA = null;
if (regJson?.cookie) {
  const m = regJson.cookie.match(/MUSIC_A=([^;]+)/);
  if (m) musicA = m[1];
}
if (!musicA) musicA = regJson?.data?.MUSIC_A || regJson?.MUSIC_A;
console.log('MUSIC_A:', musicA ? musicA.slice(0, 24) + '...' : '(none)');

// 3) 带 MUSIC_A 搜索
const cookie = [
  musicA ? `MUSIC_A=${musicA}` : '',
  `deviceId=${deviceId}`,
  `_ntes_nuid=${randomHex(32)}`,
  `os=pc`,
  `appver=3.1.17.204416`,
].filter(Boolean).join('; ');

const searchData = { csrf_token: '', hlposttag: '</span>', hlpretag: '<span class="s-fc7">', limit: 30, offset: 0, s: '周杰伦', type: 1 };
const sEnc = weapi(JSON.stringify(searchData));
const searchResp = await fetch(`${BASE}/weapi/cloudsearch/get`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Referer': BASE + '/', 'Cookie': cookie },
  body: `params=${encodeURIComponent(sEnc.params)}&encSecKey=${encodeURIComponent(sEnc.encSecKey)}`,
});
console.log('SEARCH STATUS:', searchResp.status);
const sJson = await searchResp.json().catch(() => null);
const songs = sJson?.result?.songs ?? [];
console.log('SONG COUNT:', songs.length);
console.log('FIRST 3:', songs.slice(0, 3).map(s => `${s.name} - ${(s.artists||[]).map(a=>a.name).join('/')}`));
