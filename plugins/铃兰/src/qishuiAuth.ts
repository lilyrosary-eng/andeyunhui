// 汽水音乐登录认证（字节跳动统一登录系统）
//
// passport 域名已从 passport.douyin.com（DNS 不存在）改为 www.douyin.com
// API 路径更新为最新：get_qrcode / check_qrconnect / account/info
// 二维码登录流程：
//   1. POST /passport/web/get_qrcode/ → 获取 qrcode图片URL + token
//   2. 轮询 GET /passport/web/check_qrconnect/?token=xxx → 等待扫码
//   3. 扫码成功后返回 session_cookie + user info
//   4. 后续请求带 cookie 即可

import { qishuiRequest } from './qishuiApi';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };

const PASSPORT_HOST = 'https://www.douyin.com';
const PASSPORT_AID = '1606'; // music.douyin.com web 端 aid

export interface QishuiQrCode {
  qrcode: string;       // 二维码图片 URL
  token: string;        // 轮询用 token
  expired: boolean;
}

export interface QishuiAuth {
  userid: string;
  name: string;
  avatar?: string;
  cookie: string;
  vip?: boolean;
}

// 生成二维码
export async function qishuiQrCreate(): Promise<QishuiQrCode> {
  const raw: string = await hostApi.invoke('qishui_http_post', {
    method: 'POST',
    url: `${PASSPORT_HOST}/passport/web/get_qrcode/?aid=${PASSPORT_AID}&app_name=luna_music&device_platform=web&passport_sdk_version=4.1.0&language=zh`,
    body: JSON.stringify({}),
    referer: 'https://music.douyin.com/',
    origin: 'https://music.douyin.com',
    real_ip: '113.66.232.251',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    headers: {},
    content_type: 'application/json',
  });
  const parsed = JSON.parse(raw || '{}');
  const body = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : (parsed.body || {});
  if (body.message && body.message !== 'success') {
    throw new Error(body.data?.description || body.message || 'qrcode create failed');
  }
  const data = body.data || {};
  return {
    qrcode: data.qrcode || '',
    token: data.token || '',
    expired: !!data.expired,
  };
}

// 轮询二维码状态
export interface QishuiQrStatus {
  status: 'new' | 'scanned' | 'confirmed' | 'expired';
  cookie?: string;
  userid?: string;
  name?: string;
  avatar?: string;
}

export async function qishuiQrCheck(token: string): Promise<QishuiQrStatus> {
  const raw: string = await hostApi.invoke('qishui_http_post', {
    method: 'GET',
    url: `${PASSPORT_HOST}/passport/web/check_qrconnect/?aid=${PASSPORT_AID}&app_name=luna_music&device_platform=web&token=${encodeURIComponent(token)}&passport_sdk_version=4.1.0&language=zh`,
    body: '',
    referer: 'https://music.douyin.com/',
    origin: 'https://music.douyin.com',
    real_ip: '113.66.232.251',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    headers: {},
  });
  const parsed = JSON.parse(raw || '{}');
  const cookies: string[] = parsed.cookies || [];
  const body = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : (parsed.body || {});
  const errorCode = body.data?.error_code;
  const redirectUrl: string = body.data?.redirect_url || '';

  // error_code: 0=新二维码, 1=已扫码, 2=确认登录, 3=过期
  if (errorCode === 0 || (!errorCode && body.message === 'success' && !redirectUrl)) {
    return { status: 'new' };
  }
  if (errorCode === 1) {
    return { status: 'scanned' };
  }
  if (errorCode === 2 || (redirectUrl && redirectUrl.includes('login'))) {
    // 登录成功，从 cookies 中提取 session
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    // 从 redirect_url 提取 uid
    const uidMatch = redirectUrl.match(/uid=([^&]+)/);
    const nameMatch = redirectUrl.match(/name=([^&]+)/);
    return {
      status: 'confirmed',
      cookie: cookieStr,
      userid: uidMatch ? uidMatch[1] : '',
      name: nameMatch ? decodeURIComponent(nameMatch[1]) : '汽水用户',
    };
  }
  if (errorCode === 3) {
    return { status: 'expired' };
  }
  return { status: 'new' };
}

// 获取用户信息
export async function qishuiGetUserInfo(cookie: string): Promise<{ userid: string; name: string; avatar?: string } | null> {
  try {
    const r = await qishuiRequest('/pc/user/info', {
      method: 'GET',
      cookie,
    });
    const info = r?.data?.user || r?.data || {};
    if (!info.userid && !info.uid) return null;
    return {
      userid: String(info.userid || info.uid || ''),
      name: info.name || info.nickname || '汽水用户',
      avatar: info.avatar?.url || info.avatar_url,
    };
  } catch {
    return null;
  }
}

// 退出登录
export async function qishuiLogout(cookie: string): Promise<void> {
  try {
    await hostApi.invoke('qishui_http_post', {
      method: 'GET',
      url: `${PASSPORT_HOST}/passport/web/account/logout/?aid=${PASSPORT_AID}&app_name=luna_music&device_platform=web`,
      body: '',
      cookie,
      referer: 'https://music.douyin.com/',
      origin: 'https://music.douyin.com',
      real_ip: '113.66.232.251',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      headers: {},
    });
  } catch {}
}

// 本地持久化
const AUTH_KEY = 'qishui-auth';

export function loadQishuiAuth(): QishuiAuth | null {
  try {
    const s = localStorage.getItem(AUTH_KEY);
    if (!s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function saveQishuiAuth(auth: QishuiAuth): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function clearQishuiAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}
