// 汽水音乐（字节跳动 luna/helium）API 层
//
// 域名：api3-lq.qishui.com（移动端网关）
// 经实测：游客态只读接口无需签名头（x-helios/x-argus 等），直接 POST 即可。
//   - 推荐：POST /luna/discover/mix
//   - 搜索：POST /luna/search/track → result_groups[].data[].entity.track
//   - 歌单详情：POST /luna/playlist/detail → media_resources[].entity.track_wrapper.track
//   - 歌词：GET /luna/h5/seo_track?track_id=...&device_platform=web
//   - 播放地址：POST /luna/media-player → data.player_infos[].video_model.video_list[]
// 封面 URL 结构：url_cover.urls[0] + url_cover.uri，或直接用 url_cover.urls[0] + '/' + url_cover.uri

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
  'Mozilla/5.0 (Linux; Android 13; 23013RK75C Build/TKQ1.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 com.luna.music/100197030 (Linux; U; Android 13; zh_CN; 23013RK75C; Build:TKQ1.220905.001; Cronet/TTNetVersion:120.0.0.0)';

// 移动端公共 query，与真实 App 对齐
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
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;      // 秒
  cover?: string;
  url?: string;          // 解密后 objectURL（运行时填充）
  fee?: number;          // 0 免费 / 其他 付费/会员
  encryptUrl?: string;   // 加密流直链
  spadeA?: string;       // 解密密钥
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

// ============ 封面 URL 提取 ============
// 汽水封面结构多样，统一处理：
// 1. { uri: "tos-cn-xxx/xxx", urls: ["https://p3-luna.douyinpic.com/img/", ...] } → urls[0] + uri
// 2. { uri: "tos-cn-xxx/xxx" } → 用默认域名拼接
// 3. { url: "https://..." } → 直接用
// 4. 字符串 → 直接用
const DEFAULT_IMG_HOST = 'https://p3-luna.douyinpic.com/img/';
function extractCover(urlCover: any): string | undefined {
  if (!urlCover) return undefined;
  if (typeof urlCover === 'string') return urlCover;
  // 尝试 url 字段
  if (typeof urlCover.url === 'string' && urlCover.url) return urlCover.url;
  const uri = urlCover.uri;
  if (!uri) return undefined;
  const urls = urlCover.urls;
  if (urls && Array.isArray(urls) && urls.length > 0) {
    return `${urls[0]}${uri}`;
  }
  // 有 uri 但没有 urls，用默认域名拼接
  return `${DEFAULT_IMG_HOST}${uri}`;
}

// ============ 请求 helper ============
interface QishuiRequestOpts {
  method?: 'GET' | 'POST';
  params?: Record<string, any>;
  body?: Record<string, any>;
  cookie?: string;
  referer?: string;
}

export async function qishuiRequest(
  path: string,
  opts: QishuiRequestOpts = {},
): Promise<any> {
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const query = { ...getCommonParams(), ...(opts.params || {}) };
  const url = `${API_BASE}${path}?${toQs(query)}`;

  // 签名头：优先使用外部注入；否则不发（实测游客态无需签名）
  const extra = getExternalSign() || {};

  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';

  const raw: string = await hostApi.invoke('qishui_http_post', {
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
  return parsed.body || parsed;
}

// ============ 业务函数 ============

// 从 API 返回的 track 对象提取 QishuiTrack
// 真实结构: { id, name, album: { id, name, url_cover: { uri, urls } }, artists: [{ id, name }], duration, ... }
function mapTrack(s: any): QishuiTrack {
  const artists = s.artists || s.artistInfos || [];
  const artist = Array.isArray(artists)
    ? artists.map((a: any) => a.name || a).join('/')
    : (s.artist || '');
  const album = s.album?.name || s.albumName || '';
  const id = String(s.id ?? s.songId ?? '') || `qishui-trk-${Math.random().toString(36).slice(2, 8)}`;
  const cover = extractCover(s.url_cover || s.album?.url_cover) || s.cover || s.coverUrl;
  // 诊断：封面解析失败时打印原始结构
  if (!cover && s.url_cover) {
    console.warn('[qishui] 封面解析失败, url_cover=', JSON.stringify(s.url_cover).slice(0, 200));
  }
  return {
    id,
    name: s.name || s.title || '未知歌曲',
    artist,
    album,
    duration: (s.duration ? s.duration / 1000 : s.dt ? s.dt / 1000 : 0),
    cover,
    fee: s.fee ?? s.payType ?? 0,
    artistId: s.artists?.[0]?.id ? String(s.artists[0].id) : (s.artistId ? String(s.artistId) : undefined),
    albumId: s.album?.id ? String(s.album.id) : (s.albumId ? String(s.albumId) : undefined),
  };
}

// 搜索：POST /luna/search/track
// 返回结构: { result_groups: [{ id: "tracks", data: [{ meta: {item_type:"track"}, entity: { track: {...} } }] }] }
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
  // 解析: result_groups[].data[].entity.track
  const groups = r?.result_groups || [];
  const list: any[] = Array.isArray(groups)
    ? groups.flatMap((g: any) => {
        const items = g.data || g.tracks || g.songs || [];
        return items.map((item: any) => item?.entity?.track || item?.track || item).filter(Boolean);
      })
    : [];
  console.log('[qishui] search: groups=', groups.length, 'tracks=', list.length);
  return (Array.isArray(list) ? list : []).map(mapTrack).filter((t: QishuiTrack) => t.id);
}

// 解析 discover/mix 返回的 block，提取歌单卡片
// 真实结构: { inner_block: [{ type, title, resources: [{ entity: { playlist: { id, title, url_cover, count_tracks, ... } } }] }] }
function extractPlaylistsFromDiscover(data: any): QishuiPlaylistCard[] {
  const blocks = data?.inner_block || data?.blocks || data?.data?.inner_block || (Array.isArray(data?.data) ? data.data : []);
  const out: QishuiPlaylistCard[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const resources = b.resources || b.data || b.items || [];
    for (const res of Array.isArray(resources) ? resources : []) {
      const p = res.entity?.playlist || res.entity?.playlist_wrapper?.playlist || res.playlist || res;
      if (!p) continue;
      out.push({
        id: String(p.id ?? p.playlist_id ?? p.pid ?? '') || `qishui-disc-${out.length}`,
        name: p.name || p.title || p.public_title || '未知歌单',
        coverImgUrl: extractCover(p.url_cover) || p.coverUrl || p.cover || '',
        trackCount: p.trackCount || p.count_tracks || p.songCount || p.track_count || p.resource_cnt?.track_cnt || 0,
        playCount: p.playCount || p.play_count || p.stats?.count_collected || 0,
        creator: p.creator?.name || p.creator,
      });
    }
  }
  return out;
}

// 推荐歌单
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
  return extractPlaylistsFromDiscover(r);
}

// 榜单
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
  const list = extractPlaylistsFromDiscover(r);
  if (list.length) return list;
  // 兜底：通用 discover
  const r2 = await qishuiRequest('/discover', {
    method: 'POST',
    body: { cursor: '', count: 30 },
  });
  return extractPlaylistsFromDiscover(r2);
}

// 歌单详情（歌曲列表）
// 返回结构: { media_resources: [{ id, type:"track", entity: { track_wrapper: { track: {...} } } }], playlist: { title, ... } }
export async function qishuiGetPlaylistTracks(pid: string): Promise<QishuiTrack[]> {
  const r = await qishuiRequest('/playlist/detail', {
    method: 'POST',
    body: {
      playlist_id: pid,
      playlist_type: 0,
      cursor: '',
      count: 200,
    },
  });
  // 解析: media_resources[].entity.track_wrapper.track
  let list: any[] = [];
  if (r?.media_resources) {
    list = r.media_resources
      .map((res: any) => res.entity?.track_wrapper?.track || res.entity?.track || res.track)
      .filter(Boolean);
  } else if (r?.data?.media_resources) {
    list = r.data.media_resources
      .map((res: any) => res.entity?.track_wrapper?.track || res.entity?.track || res.track)
      .filter(Boolean);
  }
  console.log('[qishui] playlist detail: tracks=', list.length);
  return (Array.isArray(list) ? list : []).map(mapTrack).filter((t: QishuiTrack) => t.id);
}

// 获取歌单信息
export async function qishuiGetPlaylistInfo(pid: string): Promise<{ name: string; cover?: string; trackCount: number }> {
  const r = await qishuiRequest('/playlist/detail', {
    method: 'POST',
    body: {
      playlist_id: pid,
      playlist_type: 0,
      cursor: '',
      count: 1,
    },
  });
  const p = r?.playlist || r?.data?.playlist;
  return {
    name: p?.title || p?.name || p?.public_title || '歌单详情',
    cover: extractCover(p?.url_cover),
    trackCount: p?.count_tracks || p?.trackCount || p?.resource_cnt?.track_cnt || 0,
  };
}

// 歌词
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
  // 诊断：打印完整响应结构
  console.log('[qishui] media-player response keys:', Object.keys(r || {}).join(','));
  const info = r?.data?.player_infos?.[0] || r?.player_infos?.[0];
  console.log('[qishui] player_infos[0]:', info ? JSON.stringify(info).slice(0, 400) : 'EMPTY');
  const vmRaw = info?.video_model;
  const vm = typeof vmRaw === 'string' ? JSON.parse(vmRaw) : vmRaw;
  console.log('[qishui] video_model:', vm ? JSON.stringify(vm).slice(0, 400) : 'EMPTY');
  const v0 = vm?.video_list?.[0];
  const encryptInfo = v0?.encrypt_info || {};
  console.log('[qishui] video_list[0]:', v0 ? JSON.stringify(v0).slice(0, 300) : 'EMPTY');
  console.log('[qishui] encrypt_info:', JSON.stringify(encryptInfo).slice(0, 200));
  return {
    url: v0?.main_url || v0?.backup_url || (typeof info?.url_player_info === 'string' ? info.url_player_info : undefined),
    spadeA: encryptInfo?.spade_a || info?.spade_a || info?.spadeA,
    br: Number(v0?.video_meta?.bitrate || vm?.bitrate || br),
  };
}

// ============ 歌手 / 专辑详情（DetailDrawer 接入用） ============

// 歌手详情
export interface QishuiArtistDetail {
  id: string;
  name: string;
  cover?: string;
  description?: string;
  hotSongs: QishuiTrack[];
  albums: { id: string; name: string; cover?: string }[];
}

export async function qishuiGetArtistDetail(artistId: string): Promise<QishuiArtistDetail | null> {
  const r = await qishuiRequest('/artist/detail', {
    method: 'POST',
    body: { artist_id: artistId, cursor: '', count: 50 },
  });
  const a = r?.data?.artist || r?.artist || {};
  if (!a.id && !a.name) return null;
  const songs: any[] = r?.data?.media_resources || r?.media_resources || [];
  const trackList = songs
    .map((res: any) => res.entity?.track_wrapper?.track || res.entity?.track || res.track)
    .filter(Boolean)
    .map(mapTrack)
    .filter((t: QishuiTrack) => t.id);
  const albums: any[] = r?.data?.albums || r?.albums || [];
  return {
    id: String(a.id ?? artistId),
    name: a.name || '未知歌手',
    cover: extractCover(a.url_avatar) || extractCover(a.url_cover),
    description: a.description || a.intro,
    hotSongs: trackList,
    albums: albums.map((al: any) => ({
      id: String(al.id ?? al.album_id ?? ''),
      name: al.name || al.title || '未知专辑',
      cover: extractCover(al.url_cover),
    })),
  };
}

// 专辑详情
export interface QishuiAlbumDetail {
  id: string;
  name: string;
  cover?: string;
  artistName: string;
  artistId?: string;
  description?: string;
  tracks: QishuiTrack[];
}

export async function qishuiGetAlbumDetail(albumId: string, albumName?: string): Promise<QishuiAlbumDetail | null> {
  // 尝试路径 1：原 /album/detail（以防后续上线）
  try {
    const r = await qishuiRequest('/album/detail', {
      method: 'POST',
      body: { album_id: albumId, cursor: '', count: 100 },
    });
    if (r && r.data) {
      const a = r?.data?.album || r?.album || {};
      if (a.id || a.name) {
        const songs: any[] = r?.data?.media_resources || r?.media_resources || [];
        const trackList = songs
          .map((res: any) => res.entity?.track_wrapper?.track || res.entity?.track || res.track)
          .filter(Boolean)
          .map(mapTrack)
          .filter((t: QishuiTrack) => t.id);
        const artist = a.artists?.[0] || a.artist;
        return {
          id: String(a.id ?? albumId),
          name: a.name || a.title || '未知专辑',
          cover: extractCover(a.url_cover),
          artistName: artist?.name || '未知歌手',
          artistId: artist?.id ? String(artist.id) : undefined,
          description: a.description || a.intro,
          tracks: trackList,
        };
      }
    }
  } catch { /* 404 时降级 */ }

  // 降级方案：汽水 API 无独立专辑详情端点，用专辑名搜索曲目
  const searchName = albumName || '';
  if (!searchName) return null;
  const sr = await qishuiRequest('/search/track', {
    method: 'POST',
    body: { keyword: searchName, search_id: '', cursor: '0', count: 30 },
  });
  const rawTracks: any[] = sr?.data?.tracks || sr?.data?.result_groups?.flatMap((g: any) => g?.data || []) || sr?.data?.list || [];
  const allTracks = rawTracks
    .map((item: any) => item.entity?.track_wrapper?.track || item.entity?.track || item.track || item)
    .filter(Boolean)
    .map(mapTrack)
    .filter((t: QishuiTrack) => t.id);
  // 按 albumId 筛选（如果 track 带了 albumId）
  const filtered = allTracks.filter((t) => t.albumId === albumId);
  const tracks = filtered.length > 0 ? filtered : allTracks;
  if (!tracks.length) return null;
  // 从第一条提取专辑信息
  const first = rawTracks.find((item: any) => {
    const tr = item.entity?.track_wrapper?.track || item.entity?.track || item.track || item;
    return tr?.album?.id === albumId || tr?.albumId === albumId;
  });
  const tr = first?.entity?.track_wrapper?.track || first?.entity?.track || first?.track || first || {};
  const album = tr.album || {};
  const artist = tr.artists?.[0] || tr.artistInfos?.[0];
  return {
    id: albumId,
    name: album.name || searchName,
    cover: extractCover(album.url_cover),
    artistName: artist?.name || '未知歌手',
    artistId: artist?.id ? String(artist.id) : undefined,
    description: '',
    tracks,
  };
}
