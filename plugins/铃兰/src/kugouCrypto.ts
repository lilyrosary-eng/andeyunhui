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
//
// 签名 MD5 直接使用 crypto-js（与 neteaseCrypto 同一依赖，插件沙箱已加载），
// 不自造 MD5：此前自造的 MD5 实现算出的哈希与标准不符，导致酷狗校验签名失败（20006/20010）。

import CryptoJS from 'crypto-js';

const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

// Android 客户端签名参数（社区逆向稳定值），用于登录态「我的歌单」等私有接口。
export const KUGOU_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';
export const KUGOU_ANDROID_APPID = '1005';
export const KUGOU_ANDROID_CLIENTVER = '20489';

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
  // 诊断：输出实际签名原料，便于核对是否与酷狗网关一致（sign 失败时贴此行）
  console.log('[kugou-diag] sign raw=', raw, '=>', CryptoJS.MD5(raw).toString().toUpperCase());
  return CryptoJS.MD5(raw).toString().toUpperCase();
}

/**
 * 生成酷狗游客态所需的设备标识（dfid / mid / uuid）。
 * 酷狗对 dfid 格式要求宽松（字母数字即可），这里用稳定随机串，session 内保持一致。
 */
export function makeKugouDevice(): { dfid: string; mid: string; uuid: string; clienttime: number } {
  const rand = () => Math.random().toString(36).slice(2, 10);
  // dfid 与 mid 必须为不同串（真实客户端 dfid 来自独立生成，与 mid 不同）。
  // 酷狗对 dfid 格式宽松（字母数字即可），这里生成独立随机串。
  const dfid = (rand() + rand()).slice(0, 32);
  const mid = (rand() + rand()).slice(0, 32);
  const uuid = mid;
  return { dfid, mid, uuid, clienttime: Date.now() };
}

/**
 * Android 端签名（登录态私有接口使用）。
 * 算法与网页端相同，但：
 *   - 盐值不同（见 KUGOU_ANDROID_SALT）
 *   - 结果为小写 32 位 hex（社区实践）
 *   - 需要把 POST body 的 JSON 字符串参与签名（放在参数串之后）
 */
export function kugouAndroidSign(
  params: Record<string, any>,
  data: Record<string, any> = {},
): string {
  const filtered: Record<string, any> = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    filtered[k] = v;
  }
  const keys = Object.keys(filtered).sort();
  const paramsString = keys.map((k) => `${k}=${filtered[k]}`).join('');
  const dataString = JSON.stringify(data);
  const raw = `${KUGOU_ANDROID_SALT}${paramsString}${dataString}${KUGOU_ANDROID_SALT}`;
  return CryptoJS.MD5(raw).toString();
}

export const KUGOU_WEB_SALT = WEB_SALT;
