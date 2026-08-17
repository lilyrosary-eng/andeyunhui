// 酷狗扫码登录（真实账号登录）
//
// 走 kugou.com/kmobile/user/* 移动端接口：返回明文 token/userid，无需解密网页端
// AES/RSA 加密的 secu_params（这是桌面端逆向登录最大的障碍，移动端接口已绕过）。
// 所有请求经 Rust 代理 kugou_http_post 转发（已对 kugou.com 登录路径放白名单）。

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };
import { getDevice } from './kugouApi';
import { kugouSign } from './kugouCrypto';
import {
  type KugouAuth,
  getKugouAuth,
  setKugouAuth,
  getUserInfo,
  type KugouProfile,
} from './kugouApi';

const BASE = 'https://login-user.kugou.com';
const CLIENTVER = '20489';
const SRCAPPID = '2919';
const PLAT = 4;

// 走 Rust 代理发起 GET（自动算 signature），返回 parsed JSON body
async function proxyGet(path: string, params: Record<string, any>): Promise<any> {
  const dev = getDevice();
  // 设备相关公共参数（当前客户端：uuid 固定 '-'，dfid/mid 独立）
  const full: Record<string, any> = {
    appid: '1001',
    clientver: CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    mid: dev.mid,
    uuid: dev.uuid,
    dfid: dev.dfid,
    plat: PLAT,
    srcappid: SRCAPPID,
    ...params,
  };
  // 计算酷狗 MD5 盐签名（网页端盐），与真实请求 signature 字段一致
  full.signature = kugouSign(full);
  const query = Object.keys(full)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(full[k])}`)
    .join('&');
  const url = `${BASE}${path}?${query}`;
  console.log('[kugou-auth] REQ', path, '->', url.slice(0, 500));
  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: 'GET',
    url,
    body: '',
    cookie: `kg_mid=${dev.mid}; kg_dfid=${dev.dfid}`,
    referer: 'https://login-user.kugou.com/login/?appid=1014&ref=https://www.kugou.com/reg/web/&redirect_uri=https://staticssl.kugou.com/common/html/login/regok.html&callback=UsLoginCallback',
    origin: undefined,
    real_ip: '106.37.199.10',
    user_agent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    headers: {},
  });
  console.log('[kugou-auth] GET', path, '-> raw', String(raw).slice(0, 400));
  const parsed = JSON.parse(raw || '{}');
  if (typeof parsed.body === 'string') {
    try {
      return JSON.parse(parsed.body);
    } catch {
      return {};
    }
  }
  return parsed.body || {};
}

export interface KugouQrState {
  qrcode: string;   // 轮询用的 key（data.qrcode）
  img?: string;     // 二维码图片（data.qrcode_img，base64 data URI，直接渲染）
}

// 1) 获取登录二维码（真实接口：login-user.kugou.com/v2/qrcode）
// 真实请求带 type=1 与 qrcode_txt（扫码后跳转的 H5 登录页地址），缺任一都会返回 20010。
// 真实返回：{"data":{"qrcode":"...","qrcode_img":"data:image/png;base64,..."},"status":1,"error_code":0}
export async function kugouQrCreate(): Promise<KugouQrState> {
  const body = await proxyGet('/v2/qrcode', {
    type: 1,
    qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&',
  });
  if (body?.error_code || body?.status === 0) {
    const ec = body?.error_code ?? body?.status;
    throw new Error(`获取二维码失败[code=${ec}]: ` + JSON.stringify(body).slice(0, 200));
  }
  const data = body?.data || {};
  const qrcode = String(data.qrcode || data.qrcode_key || data.key || '');
  const img = data.qrcode_img || '';
  if (!qrcode) throw new Error('获取二维码失败：' + JSON.stringify(body).slice(0, 200));
  return { qrcode, img };
}

// 2) 轮询扫码状态（真实接口：login-user.kugou.com/v2/get_userinfo_qrcode?qrcode=key）
// 顶层 status：0=过期 1=等待扫码 2=已扫描待确认 4=授权成功（无 3）
export async function kugouQrCheck(qrcode: string): Promise<{ status: string; auth?: KugouAuth }> {
  const body = await proxyGet('/v2/get_userinfo_qrcode', {
    qrcode,
    appid: '1005',
    plat: PLAT,
    srcappid: SRCAPPID,
  });
  // 注意：接口顶层 status 只是「接口成功标志」(恒为 1)，真正的扫码状态在 body.data.status
  // （0=过期 1=等待 2=已扫待确认 4=授权成功）。务必优先取 data.status，否则会永远读到顶层 1 卡在 wait。
  const code = Number(body?.data?.status ?? body?.status ?? -1);
  const data = body?.data || {};
  if (code === 4) {
    const userid = String(data.userid || body?.userid || '');
    const token = String(data.token || body?.token || '');
    if (userid && token) {
      const auth: KugouAuth = {
        userid,
        token,
        nickname: data.nickname || data.username || undefined,
        avatar: data.pic || data.avatar || data.face || undefined,
      };
      setKugouAuth(auth);
      try {
        window.dispatchEvent(new CustomEvent('kugou-auth-changed', { detail: auth }));
      } catch { /* ignore */ }
      return { status: 'ok', auth };
    }
    return { status: 'wait' };
  }
  if (code === 0) return { status: 'expired' };
  if (code === 2) return { status: 'scanned' };
  if (code === 1) return { status: 'wait' };
  return { status: 'wait' };
}

// 将扫码获得的 userid+token 组装为酷狗网页端登录态 Cookie（KuGoo=...&... 形态），
// 供后续需登录态的接口（收藏/歌单/用户信息）复用。
export function assembleKugouCookie(auth: KugouAuth): string {
  const dev = getDevice();
  const ct = Math.floor(Date.now() / 1000);
  const KuGoo = [
    `KugooID=${auth.userid}`,
    `KugooPwd=${auth.token}`,
    auth.nickname ? `NickName=${encodeURIComponent(auth.nickname)}` : '',
    auth.avatar ? `Pic=${encodeURIComponent(auth.avatar)}` : '',
    auth.username ? `UserName=${encodeURIComponent(auth.username)}` : '',
    `t=${auth.token}`,
    'a_id=1014',
    `ct=${ct}`,
  ].filter(Boolean).join('&');
  return `KuGoo=${KuGoo}; kg_mid=${dev.mid}; kg_dfid=${dev.dfid}; userid=${auth.userid}; token=${auth.token}`;
}

// 读取本地登录态
export function readKugouAuth(): KugouAuth | null {
  return getKugouAuth();
}

// 退出登录（清除本地态）
export function logoutKugou(): void {
  setKugouAuth(null);
}

// 拉取用户信息并补全 auth.nickname/avatar
export async function fetchKugouProfile(auth: KugouAuth): Promise<{ profile: KugouProfile; auth: KugouAuth }> {
  const profile = await getUserInfo(auth);
  const next: KugouAuth = { ...auth, nickname: profile.nickname, avatar: profile.avatar, vipType: profile.vipType };
  setKugouAuth(next);
  return { profile, auth: next };
}
