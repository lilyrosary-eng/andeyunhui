// 桌面歌词同步单例（模块级，与 React 组件生命周期解耦）
// 只要音乐在播放且桌面歌词可见，就持续根据播放进度 emit `lyrics-update`，
// 即使音乐模块 / PlayerBar 因切换页面被卸载，浮动歌词窗口也能继续滚动，
// 解决「切到其它模块后桌面歌词冻结 / 不滚动」的问题。
import { musicPlayer } from './musicPlayer';

export interface LyricLine {
  time_ms: number;
  text: string;
  // 可选的翻译 / 罗马音（音译），由在线源（如网易云）填充，视图按「译/音」模式选择展示
  translation?: string;
  romaji?: string;
}

// 「译/音」三态模式：关闭 → 译（翻译）→ 音（音译）→ 关闭
export type LyricMode = 'off' | 'translate' | 'romaji';

// 模块级共享歌词翻译模式（仿 lyricsSync 单例，跨 PlayerBar / RoamView / NowPlayingView 传播）
// 持久化到 localStorage，避免刷新/切换视图后丢失
let lyricMode: LyricMode = (() => {
  try { return (localStorage.getItem('music_lyric_mode') as LyricMode) || 'off'; }
  catch { return 'off'; }
})();
const modeListeners = new Set<(m: LyricMode) => void>();
export const lyricModeStore = {
  get(): LyricMode { return lyricMode; },
  set(m: LyricMode): void {
    lyricMode = m;
    try { localStorage.setItem('music_lyric_mode', m); } catch {}
    modeListeners.forEach((l) => { try { l(m); } catch {} });
  },
  subscribe(l: (m: LyricMode) => void): () => void {
    modeListeners.add(l);
    return () => { modeListeners.delete(l); };
  },
  // 循环切换：off → translate → romaji → off
  cycle(): LyricMode {
    const next: LyricMode = lyricMode === 'off' ? 'translate' : lyricMode === 'translate' ? 'romaji' : 'off';
    lyricModeStore.set(next);
    return next;
  },
};

let lines: LyricLine[] = [];
let emitting = false;
// 去重键：原文 + 翻译/罗马音一起参与比较。
// 只比原文（曾经的 lastText）会漏掉「同一行但副行内容变了」的情况——典型是切换「译/音」模式：
// 原文没变，curSub 却应当立刻换成译文，结果桌面歌词要等到下一行才生效。
let lastKey = '';
// 节流：progress 事件约 250ms 一次，但 burst 时可能更频繁。
// 限制 emit 频率为 150ms 一次，防止 IPC 通道堵塞。
let lastEmitTime = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

type HostApiWithEmit = {
  emit: (event: string, payload: unknown) => Promise<void>;
};

function hostEmit(event: string, payload: unknown): void {
  const api = (window as unknown as { __HOST_API__?: HostApiWithEmit }).__HOST_API__;
  api?.emit(event, payload)?.catch(() => {});
}

function computeAndEmit(): void {
  if (!emitting || lines.length === 0) return;
  const ct = musicPlayer.getCurrentTime() * 1000;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time_ms <= ct) idx = i;
    else break;
  }
  const cur = idx >= 0 ? lines[idx] : null;
  const nxt = idx + 1 < lines.length ? lines[idx + 1] : null;
  const curText = cur?.text ?? '';
  const nxtText = nxt?.text ?? '';

  const mode = lyricModeStore.get();
  let curSub = '';
  let nxtSub = '';
  if (mode === 'translate') {
    curSub = cur?.translation ?? '';
    nxtSub = nxt?.translation ?? '';
  } else if (mode === 'romaji') {
    curSub = cur?.romaji ?? '';
    nxtSub = nxt?.romaji ?? '';
  }

  // 四元组一起比对：任一变化（换行、译文/罗马音切换、翻译异步挂载完成）都要重发
  const key = `${curText}\u0000${nxtText}\u0000${curSub}\u0000${nxtSub}`;
  if (key !== lastKey) {
    lastKey = key;
    // 节流：距上次 emit 不足 150ms 则延迟补发
    const now = Date.now();
    if (now - lastEmitTime >= 150) {
      lastEmitTime = now;
      hostEmit('lyrics-update', { currentLine: curText, nextLine: nxtText, currentSub: curSub, nextSub: nxtSub });
    } else {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastEmitTime = Date.now();
        hostEmit('lyrics-update', { currentLine: curText, nextLine: nxtText, currentSub: curSub, nextSub: nxtSub });
      }, 150);
    }
  }
}

// 订阅一次，常驻于应用生命周期
musicPlayer.on('progress', () => computeAndEmit());

// 模式切换（译/音/关）不改变原文，必须主动重置去重键并重算，
// 否则桌面歌词会停留在切换前的副行内容，直到下一行才刷新。
lyricModeStore.subscribe(() => {
  lastKey = '';
  computeAndEmit();
});

export const lyricsSync = {
  setLines(next: LyricLine[]): void {
    // 关键：桌面歌词 emit 前对每行做「内嵌翻译拆分」。
    // 本地歌词常把「外语原文 + 中文翻译」写在同一行（如 `I sang 于此放声歌唱`），
    // 若不在 setLines 时拆出 translation，桌面歌词在译/音模式下 currentSub 恒为空、
    // 原文行还整行混排，即「翻译规则对桌面歌词不生效」的根因。
    // NowPlayingView 等模块内歌词已各自 splitInlineTranslation，这里统一处理使其一致。
    // splitInlineTranslation 对纯单语行返回无 translation，安全不误拆。
    lines = next.map((ln) => {
      if (ln.translation) return ln;
      const sp = splitInlineTranslation(ln.text);
      if (sp.translation) return { ...ln, text: sp.orig, translation: sp.translation };
      return ln;
    });
    lastKey = '';
    computeAndEmit();
  },
  setVisible(v: boolean): void {
    emitting = v;
    lastKey = '';
    if (v) computeAndEmit();
  },
  clear(): void {
    lines = [];
    lastKey = '';
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  },
  isVisible(): boolean {
    return emitting;
  },
};

// ===== 网易云远程歌词辅助（PlayerBar 浮窗歌词 / NowPlayingView 沉浸页共用）=====

// 标准 LRC（[mm:ss.xx]文本）解析为 LyricLine[]（time_ms 毫秒）
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split('\n')) {
    re.lastIndex = 0;
    let m = re.exec(raw);
    if (!m) continue;
    const times: number[] = [];
    let last = m.index;
    while (m) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      times.push((min * 60 + sec + frac / 1000) * 1000);
      last = re.lastIndex;
      m = re.exec(raw);
    }
    const text = raw.slice(last).trim();
    if (text) times.forEach((t) => out.push({ time_ms: t, text }));
  }
  out.sort((a, b) => a.time_ms - b.time_ms);
  return out;
}

// 是否为网易云远程曲：filePath 为 http(s) 直链，id 形如 netease-<songId>
export function isNeteaseRemote(track: { id?: string; filePath?: string }): boolean {
  return !!track.filePath && /^https?:\/\//i.test(track.filePath) && /^netease-\d+$/.test(track.id || '');
}
export function neteaseSongId(track: { id?: string }): number | null {
  const m = (track.id || '').match(/^netease-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// 是否为酷狗远程曲：filePath 为 http(s) 直链，id 形如 kugou-<hash>
export function isKugouRemote(track: { id?: string; filePath?: string }): boolean {
  return !!track.filePath && /^https?:\/\//i.test(track.filePath) && /^kugou-/.test(track.id || '');
}
export function kugouSongId(track: { id?: string }): string | null {
  const m = (track.id || '').match(/^kugou-([0-9a-fA-F]+)$/);
  return m ? m[1] : null;
}

// 把翻译 / 罗马音 LRC 按时间戳（容差 0.5s）挂到原文行，返回带可选 translation/romaji 的歌词行
export function mergeLyricFields(lines: LyricLine[], tLrc?: string, romaLrc?: string): LyricLine[] {
  if (tLrc || romaLrc) {
    const tMap = buildTextMap(tLrc);
    const romaMap = buildTextMap(romaLrc);
    if (tMap.size || romaMap.size) {
      for (const ln of lines) {
        if (tMap.size) ln.translation = findBestMatch(tMap, ln.time_ms);
        if (romaMap.size) ln.romaji = findBestMatch(romaMap, ln.time_ms);
      }
    }
  }
  return lines;
}

function buildTextMap(lrc?: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!lrc) return map;
  for (const ln of parseLrc(lrc)) {
    if (ln.text && !map.has(ln.time_ms)) map.set(ln.time_ms, ln.text);
  }
  return map;
}

// 找到时间戳最接近（容差 0.5s）的文本；无则返回 undefined
function findBestMatch(map: Map<number, string>, time_ms: number): string | undefined {
  let best = '';
  let bestDiff = 500;
  for (const [t, v] of map) {
    const d = Math.abs(t - time_ms);
    if (d < bestDiff) { bestDiff = d; best = v; }
  }
  return best || undefined;
}

// ===== 本地内嵌歌词的翻译提取 =====
//
// 常见的内嵌 LRC 会把「外语原文 + 中文翻译」写在同一行：
//   [00:12.73]I sang 于此放声歌唱
//   [00:35.20]You will always be there ... 你仍稳坐泰山
//   [01:57.91]The salt, salt 一粒粒盐，一粒粒盐
//   [00:17.54]Veste lannja 面披轻纱的你        （架空语 / 法语原词 + 中文）
//   [00:31.18]君を繋ぐ空の星が1つ音を立てても 即使是 ... （日文原文 + 中文翻译）
//
// 规则：行内若「外语（含字母/数字）成段在前、纯汉字成段在后」，则把末尾的
//      中文成片作为翻译。整行都是单语（纯中文 / 纯日文 / 纯架空语）时不去拆。
//
// 关键判定依据：中文翻译段 = 连续的「汉字为主、几乎无假名」的块（因为日语句子
// 必然夹带平/片假名，而中文翻译不会有；方法/架空语等纯外语行则一个汉字都没有）。
// 反过来，「中文原文 + 外语」这种中文在前的不拆。
//
// 采用两套逻辑：
//  - 行内含拉丁字母 → 「拉丁宽松层」（现状）：保留字符流扫描，要求翻译段纯汉字、前面确有外语原词。
//  - 行内无拉丁但含假名 → 「日文严格层」：以空格为候选边界，要求左侧段含假名（确为日文原文）、
//    右侧段除标点/空格外几乎纯汉字；宁漏不误，任一条件不确定就整行不拆。
export function splitInlineTranslation(text: string): { orig: string; translation?: string } {
  if (!text) return { orig: text || '' };
  const trimmed = text.trim();
  if (!trimmed) return { orig: text };

  const chars = Array.from(trimmed);
  const n = chars.length;
  const isIdeo: boolean[] = new Array(n).fill(false); // 汉字（含扩展区/兼容区）
  const isKana: boolean[] = new Array(n).fill(false); // 平假名/片假名
  let hasLatin = false;
  let hasKana = false;
  for (let i = 0; i < n; i++) {
    const cp = chars[i].codePointAt(0)!;
    isIdeo[i] =
      (cp >= 0x2e80 && cp <= 0x2eff) || // 部首
      (cp >= 0x2f00 && cp <= 0x2fdf) || // 康熙部首
      (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容
      cp >= 0x20000;                    // 扩展B+
    isKana[i] = (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff);
    if (isKana[i]) hasKana = true;
    else if (/[A-Za-z0-9]/.test(chars[i])) hasLatin = true;
  }

  if (hasLatin) {
    // —— 拉丁宽松层（现状）——
    let bestStart = -1;
    for (let i = 0; i < n; i++) {
      if (!isIdeo[i]) continue;
      // 统计尾部 [i, n) 的汉字与假名
      let ideo = 0, kana = 0;
      let headForeign = false; // 前面是否出现字母/数字（外语信号）
      for (let j = 0; j < n; j++) {
        if (j >= i) {
          if (isIdeo[j]) ideo++;
          else if (isKana[j]) kana++;
        } else if (!isIdeo[j] && !isKana[j] && /[A-Za-z0-9]/.test(chars[j])) {
          headForeign = true;
        }
      }
      // 中文翻译段：至少 2 个汉字、几乎无假名（避免把日文句子当翻译）
      if (ideo < 2 || kana > 0) continue;
      // 前面必须确有「外语/含字母数字」原词，才判定中文在后
      if (!headForeign) continue;
      // 翻译段前必须是边界（空格/标点），不能紧贴假名——否则只是日文句尾恰好是汉字词
      if (i > 0 && (isIdeo[i - 1] || isKana[i - 1])) continue;
      bestStart = i; // 取最靠前、成片最完整的汉字块起点
      break;
    }

    if (bestStart > 0) {
      const orig = trimmed.slice(0, bestStart).trim();
      const translation = trimmed.slice(bestStart).trim();
      if (orig && translation) return { orig, translation };
    }
    return { orig: text };
  }

  if (hasKana) {
    // —— 日文严格层（宁漏不误）——
    const sp = splitJapaneseStrict(chars, n, isIdeo, isKana, trimmed);
    if (sp) return sp;
  }

  return { orig: trimmed };
}

// 行内可忽略字符：全/半角空格、各种标点（CJK/全角/通用/补充/ASCII 常用标点）。
// 这些只作为翻译尾部或内部的装饰，不影响「纯汉字判别」；拉丁字母/数字不在此列（会走拉丁层）。
function isIgnorable(cp: number): boolean {
  return (
    cp === 0x20 ||
    (cp >= 0x21 && cp <= 0x2f) || // ASCII 标点 !" # ￥ % & ' ( ) * + , - . /
    (cp >= 0x3a && cp <= 0x40) || // : ; < = > ? @
    (cp >= 0x5b && cp <= 0x60) || // [ \ ] ^ _ `
    (cp >= 0x7b && cp <= 0x7e) || // { | } ~
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 符号/标点
    (cp >= 0xff00 && cp <= 0xffef) || // 全角形式
    (cp >= 0x2000 && cp <= 0x206f) || // 通用标点
    (cp >= 0x2e00 && cp <= 0x2e7f)    // 补充标点
  );
}

// 日文严格层：只认「空格」为边界，从右侧回扫找第一个满足条件的候选：
//  - 右侧段：除标点/空格外几乎纯汉字（无假名、汉字 >= 2）
//  - 紧邻该格左侧的「词」（上一个空格到本格之间）含假名 → 确为日文原文延伸到边界处
//  这样即便翻译里也带空格（如「你找寻信笺的指尖 微微颤抖」），也能停在日语结束、翻译起始的那一格，
//  而不是停在最右端把翻译拆碎。
function splitJapaneseStrict(
  chars: string[], n: number, isIdeo: boolean[], isKana: boolean[], trimmed: string,
): { orig: string; translation?: string } | null {
  // 候选边界 = 空格（半角 / 全角 \u3000）
  const boundaries: number[] = [];
  for (let i = 0; i < n; i++) {
    if (chars[i] === ' ' || chars[i] === '\u3000') boundaries.push(i);
  }
  if (!boundaries.length) return null;

  for (let bi = boundaries.length - 1; bi >= 0; bi--) {
    const b = boundaries[bi];
    // 右侧段真实起点（跳过连续空格）
    let br = b + 1;
    while (br < n && (chars[br] === ' ' || chars[br] === '\u3000')) br++;
    if (br >= n) continue; // 空格在句尾，忽略

    // 右侧段判定：几乎纯汉字
    let han = 0;
    let tailOk = true;
    for (let i = br; i < n; i++) {
      const cp = chars[i].codePointAt(0)!;
      if (isIdeo[i]) { han++; continue; }
      if (isKana[i] || !isIgnorable(cp)) { tailOk = false; break; }
    }
    if (!tailOk || han < 2) continue;

    // 紧邻左侧的「词」（上一个空格 + 1 到本空格之前）是否含假名
    const prevSpace = bi > 0 ? boundaries[bi - 1] : -1;
    let wordStart = prevSpace + 1;
    while (wordStart < b && (chars[wordStart] === ' ' || chars[wordStart] === '\u3000')) wordStart++;
    let wordHasKana = false;
    for (let i = wordStart; i < b; i++) {
      if (isKana[i]) { wordHasKana = true; break; }
    }
    if (!wordHasKana) continue;

    const orig = trimmed.slice(0, b).trim();
    const translation = trimmed.slice(br).trim();
    if (!orig || !translation) continue;
    return { orig, translation };
  }
  return null;
}
