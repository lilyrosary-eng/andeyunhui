// 漫游电台多平台接口抽象层
//
// 各平台推荐歌曲获取统一接口：
//   - fetchBatch(count): 获取一批推荐歌曲
//   - getSongUrl(track): 获取播放地址
//   - getWiki(track): 获取歌曲百科（可选）
//
// 统一 track 类型为 RoamSeedTrack，各平台在内部完成映射。

import type { RoamSeedTrack, RoamSource } from './RoamSidebar';
import { parseLrc, mergeLyricFields, splitInlineTranslation, type LyricLine } from './lyricsSync';

// ---- 网易云 ----
import {
  getListenNow as neteaseGetListenNow,
  getPersonalFm as neteaseGetPersonalFm,
  getSongUrl as neteaseGetSongUrl,
  getSongWiki as neteaseGetSongWiki,
  neteaseGetLyric as neteaseGetLyricFn,
  isLoggedIn as neteaseIsLoggedIn,
  type NeteaseTrack,
} from './neteaseApi';

// ---- 酷狗 ----
import {
  getRankList as kugouGetRankList,
  getTopList as kugouGetRankSongs,
  getSongUrl as kugouGetSongUrl,
  getLyric as kugouGetLyricFn,
  type KugouTrack,
  type KugouAuth,
} from './kugouApi';
import { readKugouAuth } from './kugouAuth';

// ---- 汽水 ----
import {
  qishuiGetRecommendPlaylists,
  qishuiGetPlaylistTracks,
  qishuiGetSongUrl,
  qishuiGetLyric as qishuiGetLyricFn,
  type QishuiTrack,
} from './qishuiApi';

// ---- 铃兰（本地音乐）----
import { musicPlayer, type Track } from './musicPlayer';

// 铃兰漫游用：外部注入的本地 tracks 池（合并所有歌单后打乱）
// 由 index.tsx 在进入漫游时设置
let linglanTrackPool: Track[] = [];
let linglanPoolCursor = 0; // 消费指针，每次 fetchBatch 从这里开始取
export function setLinglanRoamPool(tracks: Track[]) {
  // 合并 + 去重 + 打乱
  const seen = new Set<string>();
  const deduped: Track[] = [];
  for (const t of tracks) {
    if (t.filePath && !seen.has(t.filePath)) {
      seen.add(t.filePath);
      deduped.push(t);
    }
  }
  linglanTrackPool = deduped.sort(() => Math.random() - 0.5);
  linglanPoolCursor = 0;
}
// 确保池非空（仅检查外部注入的池，不从 musicPlayer 取——musicPlayer 里的是漫游队列不是本地歌单）
function ensureLinglanPool(): Track[] {
  return linglanTrackPool;
}

// ============ 映射函数 ============

function neteaseToRoam(t: NeteaseTrack, url: string, quality = ''): RoamSeedTrack {
  return {
    id: `netease-${t.id}`,
    title: t.name,
    artist: t.artist,
    album: t.album,
    cover: t.cover,
    durationSecs: Math.round((t.duration || 0) / 1000),
    filePath: url,
    quality,
  };
}

function kugouToRoam(t: KugouTrack, url: string, quality = ''): RoamSeedTrack {
  return {
    id: `kugou-${t.id}`,
    title: t.name,
    artist: t.artist,
    album: t.album,
    cover: t.cover,
    durationSecs: Math.round((t.duration || 0) / 1000),
    filePath: url,
    quality,
  };
}

function qishuiToRoam(t: QishuiTrack, url: string, quality = ''): RoamSeedTrack {
  return {
    id: `qishui-${t.id}`,
    title: t.name,
    artist: t.artist,
    album: t.album,
    cover: t.cover,
    durationSecs: Math.round((t.duration || 0)),
    filePath: url,
    quality,
  };
}

function localToRoam(t: Track): RoamSeedTrack {
  return {
    id: `local-${t.id}`,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.coverPath,
    durationSecs: t.durationSecs,
    filePath: t.filePath,
    quality: t.quality,
  };
}

// ============ 平台接口定义 ============

export interface RoamSourceApi {
  // 获取一批推荐歌曲（不含播放地址，地址在播放时按需获取）
  fetchBatch(count: number, offset: number): Promise<{ tracks: RoamSeedTrack[]; nextOffset: number }>;
  // 获取播放地址
  getSongUrl(track: RoamSeedTrack): Promise<{ url: string; br?: number }>;
  // 获取歌曲百科（可选）
  getWiki?(track: RoamSeedTrack): Promise<any | null>;
  // 获取歌词（结构化歌词行：原文 + 可选 translation/romaji）
  getLyric?(track: RoamSeedTrack): Promise<LyricLine[] | null>;
}

// ============ 网易云实现 ============

const neteaseApi: RoamSourceApi = {
  async fetchBatch(count: number, offset: number) {
    if (neteaseIsLoggedIn()) {
      const list = await neteaseGetPersonalFm(count, offset);
      if (list.length) return { tracks: list.map((t) => neteaseToRoam(t, '')), nextOffset: offset + list.length };
    }
    const seed = await neteaseGetListenNow(count);
    return { tracks: seed.map((t) => neteaseToRoam(t, '')), nextOffset: 0 };
  },
  async getSongUrl(track: RoamSeedTrack) {
    // track.id 格式为 netease-{数字}
    const nid = track.id.replace(/^netease-/, '');
    const r = await neteaseGetSongUrl(nid);
    return { url: r.url || '', br: r.br };
  },
  async getWiki(track: RoamSeedTrack) {
    const nid = Number(track.id.replace(/^netease-/, ''));
    return neteaseGetSongWiki(nid);
  },
  async getLyric(track: RoamSeedTrack) {
    const nid = Number(track.id.replace(/^netease-/, ''));
    return neteaseGetLyricFn(nid);
  },
};

// ============ 酷狗实现 ============

// 缓存榜单歌曲，避免每次都拉
let kugouRankCache: { rankId: number; tracks: KugouTrack[] } | null = null;

const kugouApiImpl: RoamSourceApi = {
  async fetchBatch(count: number, _offset: number) {
    // 取第一个榜单的歌曲
    if (!kugouRankCache || kugouRankCache.tracks.length < count) {
      const ranks = await kugouGetRankList();
      if (!ranks.length) return { tracks: [], nextOffset: 0 };
      const rankId = ranks[0].id;
      const tracks = await kugouGetRankSongs(rankId, 1, Math.max(count, 30));
      kugouRankCache = { rankId, tracks };
    }
    const slice = kugouRankCache.tracks.slice(0, count);
    // 随机打乱顺序以模拟"推荐"
    const shuffled = [...slice].sort(() => Math.random() - 0.5);
    return { tracks: shuffled.map((t) => kugouToRoam(t, '')), nextOffset: 0 };
  },
  async getSongUrl(track: RoamSeedTrack) {
    // track.id 格式为 kugou-{hash}
    const hash = track.id.replace(/^kugou-/, '');
    const auth: KugouAuth | null = readKugouAuth();
    const r = await kugouGetSongUrl(hash, undefined, auth, 'standard', !!auth?.userid);
    return { url: r.url, br: r.br };
  },
  async getLyric(track: RoamSeedTrack) {
    const hash = track.id.replace(/^kugou-/, '');
    const r = await kugouGetLyricFn(hash, track.title ? `${track.title} ${track.artist || ''}` : '');
    if (!r?.lyric) return null;
    const lines = parseLrc(r.lyric);
    // 酷狗接口额外返回翻译歌词 tlyric（trans），挂到对应原文行
    return r.trans ? mergeLyricFields(lines, r.trans) : lines;
  },
};

// ============ 汽水实现 ============

// 缓存推荐歌单歌曲
let qishuiPlaylistCache: { playlistId: string; tracks: QishuiTrack[] } | null = null;

const qishuiApiImpl: RoamSourceApi = {
  async fetchBatch(count: number, _offset: number) {
    if (!qishuiPlaylistCache || qishuiPlaylistCache.tracks.length < count) {
      const playlists = await qishuiGetRecommendPlaylists(1);
      if (!playlists.length) return { tracks: [], nextOffset: 0 };
      const pid = String(playlists[0].id);
      const tracks = await qishuiGetPlaylistTracks(pid);
      qishuiPlaylistCache = { playlistId: pid, tracks };
    }
    const slice = qishuiPlaylistCache.tracks.slice(0, Math.max(count, 10));
    const shuffled = [...slice].sort(() => Math.random() - 0.5);
    return { tracks: shuffled.map((t) => qishuiToRoam(t, '')), nextOffset: 0 };
  },
  async getSongUrl(track: RoamSeedTrack) {
    const id = track.id.replace(/^qishui-/, '');
    const r = await qishuiGetSongUrl(id);
    return { url: r.url || '', br: r.br };
  },
  async getLyric(track: RoamSeedTrack) {
    const id = track.id.replace(/^qishui-/, '');
    const t = await qishuiGetLyricFn(id);
    return t ? parseLrc(t) : null;
  },
};

// ============ 铃兰（本地）实现 ============

const linglanApi: RoamSourceApi = {
  async fetchBatch(count: number, _offset: number) {
    // 确保池非空（外部注入或从 musicPlayer 取）
    const pool = ensureLinglanPool();
    if (!pool.length) return { tracks: [], nextOffset: 0 };
    // 从游标位置取 count 首，不够则从头循环
    const take = Math.max(count, 1);
    const result: Track[] = [];
    for (let i = 0; i < take; i++) {
      const idx = (linglanPoolCursor + i) % pool.length;
      result.push(pool[idx]);
    }
    linglanPoolCursor = (linglanPoolCursor + take) % pool.length;
    return { tracks: result.map(localToRoam), nextOffset: 0 };
  },
  async getSongUrl(track: RoamSeedTrack) {
    // 本地歌曲 filePath 就是播放地址
    return { url: track.filePath };
  },
  async getLyric(track: RoamSeedTrack) {
    // 本地歌曲：通过宿主读取 .lrc 文件或内嵌标签
    const fp = track.filePath || track.id;
    const api = (window as any).__HOST_API__;
    if (!fp || !api?.invoke) return null;
    try {
      const res = await api.invoke<{ text: string; source: string }>('get_lyrics_text', { trackPath: fp });
      if (!res?.text) return null;
      const lines = parseLrc(res.text);
      // 内嵌歌词常把「外语原文 + 中文翻译」写在同一行，拆出翻译挂到 translation
      if (lines.length) {
        for (const ln of lines) {
          const sp = splitInlineTranslation(ln.text);
          if (sp.translation && sp.orig !== ln.text) {
            ln.text = sp.orig;
            ln.translation = sp.translation;
          }
        }
      }
      return lines;
    } catch { return null; }
  },
};

// ============ 注册表 ============

const sourceApis: Record<RoamSource, RoamSourceApi> = {
  linglan: linglanApi,
  netease: neteaseApi,
  kugou: kugouApiImpl,
  qishui: qishuiApiImpl,
};

export function getRoamSourceApi(source: RoamSource): RoamSourceApi {
  return sourceApis[source];
}

// 清空缓存（切换路径时调用）
// 注意：不清空铃兰池——铃兰池由 setLinglanRoamPool 管理，避免切换路径时丢掉本地歌曲
export function clearRoamCache(): void {
  kugouRankCache = null;
  qishuiPlaylistCache = null;
}
// 强制清空所有缓存（切换模块时调用）
export function clearAllRoamCache(): void {
  kugouRankCache = null;
  qishuiPlaylistCache = null;
  linglanTrackPool = [];
  linglanPoolCursor = 0;
}

// ============ 类型导出 ============

export type { RoamSeedTrack, RoamSource } from './RoamSidebar';
export type { RoamHistoryEntry } from './RoamSidebar';
