/// <reference path="../global.d.ts" />

import { weapi } from './neteaseCrypto';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };

let guestCookie: string | null = null;

// 匿名注册用户名（来自 NeteaseCloudMusicApi 4.8.0 的硬编码游客账号）
const ANONYMOUS_USERNAME = 'MzEwMjcwYmY0Y2Y0ODcwMzU0ZDFkZmIxMmMzMGYyMTkgVlBaanMwNmtrb1BYMGxOVzVUMUJ3Zz09';

export async function ensureGuest(): Promise<void> {
  if (guestCookie) return;
  try {
    const { params, encSecKey } = await weapi({ username: ANONYMOUS_USERNAME });
    const url = 'https://music.163.com/api/register/anonimous';
    const body = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`;
    const cookie: string = await hostApi.invoke('netease_register_guest', { url, body });
    if (cookie) guestCookie = cookie;
  } catch (e) {
    console.warn('[netease] 游客注册失败', e);
  }
}

async function post(endpoint: string, data: Record<string, any>): Promise<any> {
  await ensureGuest();
  const { params, encSecKey } = await weapi(data);
  const res = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url: `https://music.163.com${endpoint}`,
    body: `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`,
    cookie: guestCookie || '',
  });
  if (typeof res === 'string') {
    try { return JSON.parse(res); } catch { return { raw: res }; }
  }
  return res || {};
}

export interface NeteaseTrack {
  id: number;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover?: string;
  url?: string;
}

function mapTrack(s: any): NeteaseTrack {
  const artists = s.artists || s.ar || [];
  const album = s.album || s.al || {};
  return {
    id: s.id,
    name: s.name,
    artist: artists.map((a: any) => a.name).join('/') || '未知歌手',
    album: album.name || '',
    duration: s.duration || s.dt || 0,
    cover: album.picUrl || album.cover || '',
  };
}

// 搜索歌曲（type=1 单曲）
export async function searchSongs(keyword: string, limit = 30): Promise<NeteaseTrack[]> {
  const r = await post('/weapi/cloudsearch/get/web', { s: keyword, type: 1, limit, offset: 0 });
  const list = r?.result?.songs || [];
  return list.map(mapTrack);
}

// 「现在就听」：优先每日推荐，失败回落到飙升榜
export async function getListenNow(limit = 20): Promise<NeteaseTrack[]> {
  try {
    const r = await post('/weapi/v1/discovery/recommend/songs', { limit });
    const list = r?.data?.dailySongs || [];
    if (list.length) return list.map(mapTrack);
  } catch (e) {
    console.warn('[netease] 每日推荐失败，回落榜单', e);
  }
  return getTopList(19723756); // 飙升榜
}

// 榜单详情（id 来自 /weapi/toplist）
export async function getTopList(id: number, limit = 20): Promise<NeteaseTrack[]> {
  const r = await post('/weapi/v3/playlist/detail', { id, n: limit, s: 0 });
  const list = r?.playlist?.tracks || [];
  return list.slice(0, limit).map(mapTrack);
}

// 获取播放地址（游客态标准音质）
export async function getSongUrl(id: number): Promise<string | null> {
  try {
    const r = await post('/weapi/song/enhance/player/url/v1', {
      ids: JSON.stringify([id]),
      level: 'standard',
      encodeType: 'aac',
    });
    const list = r?.data || [];
    return list[0]?.url || null;
  } catch {
    return null;
  }
}
