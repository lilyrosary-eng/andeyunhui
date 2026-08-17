// 酷狗音乐请求签名（MD5 盐签名）
//
// 酷狗当前 Android/Web API 都使用小写 32 位 hex MD5。
// Android 接口：按 key 字典序拼接 key=value，前后包 Android 盐；
// POST 请求还会把 JSON body 原文放在参数串之后参与签名。
// Web 登录接口：使用 Web 盐，同样返回小写 MD5。

import CryptoJS from 'crypto-js';

const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

// 标准 Android 客户端参数（当前公开客户端实现使用的值）。
export const KUGOU_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';
export const KUGOU_ANDROID_KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d';
export const KUGOU_ANDROID_APPID = '1005';
export const KUGOU_ANDROID_CLIENTVER = '20489';

function md5Lower(raw: string): string {
  return CryptoJS.MD5(raw).toString().toLowerCase();
}

function stringifySignValue(value: any): string {
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Web 端参数签名：过滤空值、按 key 排序、前后包 Web 盐。 */
export function kugouSign(params: Record<string, any>, salt: string = WEB_SALT): string {
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const raw = `${salt}${keys.map((k) => `${k}=${stringifySignValue(params[k])}`).join('')}${salt}`;
  return md5Lower(raw);
}

/** Android 参数签名。GET 不传 body；POST 传实际 JSON body 原文。 */
export function kugouAndroidSign(
  params: Record<string, any>,
  data?: Record<string, any> | string,
): string {
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const paramsString = keys.map((k) => `${k}=${stringifySignValue(params[k])}`).join('');
  const dataString = data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  return md5Lower(`${KUGOU_ANDROID_SALT}${paramsString}${dataString}${KUGOU_ANDROID_SALT}`);
}

/** Android /v5/url 的 key 参数签名。 */
export function kugouKeySign(
  hash: string,
  mid: string,
  userid: string | number = 0,
  appid: string | number = KUGOU_ANDROID_APPID,
): string {
  return md5Lower(`${hash.toLowerCase()}${KUGOU_ANDROID_KEY_SALT}${appid}${mid}${userid}`);
}

/** 生成酷狗游客态所需的设备标识。 */
export function makeKugouDevice(): { dfid: string; mid: string; uuid: string; clienttime: number } {
  const rand = () => Math.random().toString(36).slice(2, 10);
  const dfid = (rand() + rand()).slice(0, 32);
  const mid = (rand() + rand()).slice(0, 32);
  return { dfid, mid, uuid: '-', clienttime: Math.floor(Date.now() / 1000) };
}

export const KUGOU_WEB_SALT = WEB_SALT;
