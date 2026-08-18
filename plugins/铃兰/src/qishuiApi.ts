// 汽水音乐（字节跳动 luna/helium）API 层
//
// 设计对齐 kugouApi.ts 范式，接口路径/参数按真实抓包 + 开源实现（guowenye/qishui-api、
// SaKongA/PopDownloader、520Qiuyu/qishuiMusicAnalysis）修正：
//   - 域名：api3-lq.qishui.com（移动端网关）
//   - 推荐：POST /luna/discover/mix
//   - 榜单： discover 返回的 block 中解析，无独立 /rank
//   - 搜索：POST /luna/search/track
//   - 歌单详情：POST /luna/playlist/detail
//   - 歌词：GET /luna/h5/seo_track?track_id=...&device_platform=web
//   - 播放地址：POST /luna/media-player（拿到 player_infos 后再取真实音频 URL）
//   - 游客态只读接口仍需字节系签名头（x-helios/x-argus/x-gorgon/x-ladon/x-khronos 等）。
//     本层支持 window.__QISHUI_SIGN__ 外部注入完整签名头，便于抓包替换验证。
// 登录态（扫码）后续 Phase 补。

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };

// 允许外部注入完整签名头（抓包后 copy 进来做临时测试）
function getExternalSign(): Record<string, string> | undefined {
  try {
    const s = (window as any).__QISHUI_SIGN__;
    if (s && typeof s === 'object') return s as Record<string, string>;
  } catch {}
  return undefined;
}

// ============ 常量 ============
const API_HOST = 'https://api3-lq.qishui.com';
const API_BASE = `${API_HOST}/luna`;
const REFERER = 'https://music.douyin.com/';
const ORIGIN = 'https://music.douyin.com';
// 伪造国内出口 IP，避免非 CN 出口被拦（与 netease/kugou 同策略）
const REAL_IP = '113.66.232.251';
const UA_WEB =
  'Mozilla/5.0 (Linux; Android 13; 23013RK75C Build/TKQ1.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 com.luna.music/100197030 (Linux; U; Android 13; zh_CN; 23013RK75C; Build/TKQ1.220905.001; Cronet/TTNetVersion:120.0.0.0)';

// 移动端公共 query，与真实 App 对齐；version_code 等随官方更新可能需调整
function getCommonParams(): Record<string, string> {
  const did = getDeviceId();
  return {
    aid: '386088',
    app_name: 'luna',
    version_code: '100197030',
    version_name: '19.7.0',
    channel: 'official',
    device_id: did,
    iid: did.slice(0, 19).replace(/\D/g, '') || '4456749207173802',
    device_platform: 'android',
    device_type: '23013RK75C',
    device_brand: 'Redmi',
    os_version: '13',
    ac: 'wifi',
    tz_name: 'Asia/Shanghai',
    region: 'cn',
    geo_region: 'cn',
    os_region: 'cn',
    sim_region: 'cn',
  };
}

// ============ 类型 ============
export interface QishuiTrack {
  id: string;            // 汽水 songId 为字符串
  name: string;
  artist: string;
  album: string;
  duration: number;      // 秒
  cover?: string;
  url?: string;          // 解密后 objectURL（运行时填充）
  fee?: number;          // 0 免费 / 其他 付费/会员
  encryptUrl?: string;   // 加密流直链（song/url 返回）
  spadeA?: string;       // 解密密钥（song/url 返回）
  br?: number;           // 码率 bps
  artistId?: string;
  albumId?: string;
}

export interface QishuiPlaylistCard {
  id: string;
  name: string;
  coverImgUrl: string;
  trackCount: number;
  playCount: number;
  creator?: string;
}

// ============ 设备/游客标识 ============
function getDeviceId(): string {
  let id = localStorage.getItem('qishui-device-id');
  if (!id) {
    id = '1549681373527' + Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
    localStorage.setItem('qishui-device-id', id);
  }
  return id;
}

function toQs(obj: Record<string, any>): string {
  return new URLSearchParams(
    Object.entries(obj).map(([k, v]) => [k, String(v ?? '')])
  ).toString();
}

// ============ 字节系轻量签名（x-helios 占位） ============
// 完整 x-helios/x-argus/x-gorgon/x-ladon 为 JSVMP，前端无法稳定生成。
// 游客态只读接口校验相对较松，但仍需一组基本 header。
// 优先使用 window.__QISHUI_SIGN__ 外部注入的完整签名头；否则用占位方案。
function buildSignHeaders(): Record<string, string> {
  const external = getExternalSign();
  if (external) return external;

  const ts = Math.floor(Date.now() / 1000).toString();
  const did = getDeviceId();
  // 占位 helios：抓包后请覆盖 window.__QISHUI_SIGN__
  const helios = btoa(`${did}.${ts}`);
  return {
    'x-helios': helios,
    'x-argus': '',
    'x-gorgon': '',
    'x-ladon': '',
    'x-khronos': ts,
    'x-common-params-v2': '',
    'x-client-id': did,
  };
}

// ============ 请求 helper ============
interface QishuiRequestOpts {
  method?: 'GET' | 'POST';
  params?: Record<string, any>; // 会合并进 URL query（GET/POST 都拼）
  body?: Record<string, any>;   // POST 时作为 JSON body
  cookie?: string;
  referer?: string;
}

async function qishuiRequest(
  path: string,
  opts: QishuiRequestOpts = {},
): Promise<any> {
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const query = { ...getCommonParams(), ...(opts.params || {}) };
  const url = `${API_BASE}${path}?${toQs(query)}`;
  const extra = buildSignHeaders();

  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';

  const raw: string = await hostApi.invoke<string>('qishui_http_post', {
    method,
    url,
    body: bodyStr,
    cookie: opts.cookie || undefined,
    referer: opts.referer || REFERER,
    origin: ORIGIN,
    real_ip: REAL_IP,
    user_agent: UA_WEB,
    headers: extra,
    content_type: opts.body ? 'application/json' : undefined,
  });

  const parsed = JSON.parse(raw || '{}');
  if (parsed.status && parsed.status !== 200) {
    console.warn('[qishui]', path, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 400));
  }
  if (typeof parsed.body === 'string') {
    try { return JSON.parse(parsed.body); } catch { return { raw: parsed.body }; }
  }
  return parsed.body || {};
}

// ============ 业务函数 ============
function mapTrack(s: any): QishuiTrack {
  const artists = s.artists || s.artistInfos || [];
  const artist = Array.isArray(artists)
    ? artists.map((a: any) => a.name || a).join('/')
    : (s.artist || '');
  const album = s.album?.name || s.albumName || '';
  const id = String(s.id ?? s.songId ?? '') || `qishui-trk-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: s.name || s.title || '未知歌曲',
    artist,
    album,
    duration: (s.duration ? s.duration / 1000 : s.dt ? s.dt / 1000 : 0),
    cover: s.cover || s.coverUrl || s.album?.cover,
    fee: s.fee ?? s.payType ?? 0,
    artistId: s.artistId ? String(s.artistId) : undefined,
    albumId: s.albumId ? String(s.albumId) : undefined,
  };
}

// 搜索：search_type=track 为歌曲；playlist 为歌单
export async function qishuiSearch(keyword: string, type = 1, page = 1, pageSize = 30): Promise<QishuiTrack[]> {
  const r = await qishuiRequest('/search/track', {
    method: 'POST',
    body: {
      q: keyword,
      search_type: type === 2 ? 'playlist' : 'track',
      search_method: 'input',
      search_scene: 'main',
      scene_name: 'search_track_reco',
      cursor: String((page - 1) * pageSize),
      limited_free_scene: 1,
      ab_param: JSON.stringify({ enable_search_user: true, enable_search_video: 1 }),
    },
  });
  const list = r?.data?.result_groups
    ? r.data.result_groups.flatMap((g: any) => g.data || [])
    : (r?.data?.songList || r?.data?.list || r?.list || []);
  return list.map(mapTrack);
}

// 解析 discover/mix 返回的 block，提取歌单卡片
function extractPlaylistsFromDiscover(data: any): QishuiPlaylistCard[] {
  const blocks = data?.inner_block || data?.blocks || data?.data || [];
  const out: QishuiPlaylistCard[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const resources = b.resources || b.data || [];
    for (const res of Array.isArray(resources) ? resources : []) {
      const p = res.entity?.playlist || res.playlist || res;
      if (!p) continue;
      out.push({
        id: String(p.id ?? p.playlist_id ?? p.pid ?? '') || `qishui-disc-${out.length}`,
        name: p.name || p.title || '未知歌单',
        coverImgUrl: p.cover?.url || p.coverUrl || p.cover || '',
        trackCount: p.trackCount || p.songCount || p.track_count || 0,
        playCount: p.playCount || p.play_count || 0,
        creator: p.creator?.name || p.creator,
      });
    }
  }
  return out;
}

// 推荐歌单（discover/mix block_type=playlist）
export async function qishuiGetRecommendPlaylists(limit = 20): Promise<QishuiPlaylistCard[]> {
  const r = await qishuiRequest('/discover/mix', {
    method: 'POST',
    body: {
      block_type: 'playlist',
      sub_channel_id: 0,
      cursor: '',
      count: limit,
      session_id: '',
      ab_param: '',
    },
  });
  return extractPlaylistsFromDiscover(r?.data);
}

// 榜单：discover/mix 中 block_type=chart 或 discover_feed_radio 里的榜单块
export async function qishuiGetTopLists(): Promise<QishuiPlaylistCard[]> {
  const r = await qishuiRequest('/discover/mix', {
    method: 'POST',
    body: {
      block_type: 'chart',
      sub_channel_id: 0,
      cursor: '',
      count: 30,
      session_id: '',
      ab_param: '',
    },
  });
  const list = extractPlaylistsFromDiscover(r?.data);
  if (list.length) return list;
  // 兜底：尝试通用 discover
  const r2 = await qishuiRequest('/discover', {
    method: 'POST',
    body: { cursor: '', count: 30 },
  });
  return extractPlaylistsFromDiscover(r2?.data);
}

// 歌单详情（歌曲列表）
export async function qishuiGetPlaylistTracks(pid: string): Promise<QishuiTrack[]> {
  const r = await qishuiRequest('/playlist/detail', {
    method: 'POST',
    body: {
      playlist_id: pid,
      playlist_type: 0,
      cursor: '',
      count: 100,
    },
  });
  const list = r?.data?.media_resources
    ? r.data.media_resources.map((res: any) => res.entity?.track_wrapper?.track).filter(Boolean)
    : (r?.data?.songs || r?.data?.list || r?.list || []);
  return list.map(mapTrack);
}

// 歌词（LRC 文本）
export async function qishuiGetLyric(id: string): Promise<string> {
  const r = await qishuiRequest('/h5/seo_track', {
    method: 'GET',
    params: { track_id: id, device_platform: 'web' },
  });
  return r?.data?.lyric?.content || r?.data?.lyric || r?.lyric || '';
}

// 播放地址（加密流直链 + 解密密钥 spadeA）
export interface QishuiSongUrl {
  url?: string;
  spadeA?: string;
  br?: number;
}
export async function qishuiGetSongUrl(id: string, br = 320000): Promise<QishuiSongUrl> {
  const r = await qishuiRequest('/media-player', {
    method: 'POST',
    body: {
      media_id: id,
      media_type: 'track',
      queue_type: '',
      enable_refresh_api: false,
      enable_dash: true,
      scene_name: 'library',
      limited_free_param: {},
    },
  });
  const info = r?.data?.player_infos?.[0];
  const d = info?.url_player_info || info?.video_model || r?.data || r;
  return {
    url: d?.url || d?.playUrl || d?.file_id || d?.uri,
    spadeA: d?.spadeA || d?.key || info?.spade_a,
    br: d?.br || br,
  };
}
