/**
 * 前后端命令契约的防线：**前端 `invoke` 的每个命令，必须在对应端的注册表里**。
 *
 * 读文件的方式刻意用 **vite 的 `?raw` glob**，而不是 node 的 fs/path：
 * 本项目的 tsconfig 把 `types` 清成 `[]`（浏览器端不该有 node 全局），
 * 而三斜线 `/// <reference types="node" />` **不是文件级的** —— 它会把 node 类型
 * 加入整个编译上下文，于是 `LyricsWidget` 里 `setTimeout` 的返回类型被换成 node 的
 * `Timeout`，全项目多出一片无关报错。`?raw` 由 `vite/client` 提供类型，零污染。
 *
 * ## 血案（2026-10-15）
 * 能力探测落地时实现了 5 个 tauri 命令（`ai_probe_vision` / `ai_get_caps_probe_enabled` /
 * `ai_set_caps_probe_enabled` / `ai_media_usage` / `ai_media_cleanup`），
 * （注：其中 `ai_get/set_caps_probe_enabled` 两个后来随「探测去开关」一并删除 ——
 *  这里保留它们的名字只是记录当时的事实，不必去代码里找。）
 * `ai_service/mod.rs` 里 `pub use` 也写了，**但忘了在 `main.rs` 的 `generate_handler!`
 * 里列一行**。于是：9 条单测全绿、`cargo test` 214/214、`tsc` 0 错 ——
 * 而前端一点就是 "command not found"。
 *
 * 整条链上**没有任何一环**能发现它：
 *   - Rust 单测打的是纯逻辑函数，不经过注册表；
 *   - `cargo check` 只查类型，`generate_handler!` 漏项不是类型错误；
 *   - `tsc` 不校验 `invoke()` 的字符串参数（它就是个 string）。
 * 这条测试补的就是那一环。
 *
 * ## 第二段防线：**参数名**（2026-10-16 补）
 *
 * 上面那条只查**命令名**，查不到"命令名对了、参数名写错"——
 * 而 Tauri 只认 **camelCase**（`tauri-macros` 的 `ArgumentCase::Camel` 是默认值，
 * 生成代码按 `to_lower_camel_case()` 取键），写 `max_rounds` / `comfyUrl` 会直接 "invalid args"。
 *
 * 实测撞到两次：`AiWorkflowView.tsx` 的 `comfyUrl`（应为 `comfyuiUrl`）、
 * `plugins/茑萝/ide` 的 `max_rounds`（应为 `maxRounds`）。两次都只在**一处**写错，
 * 所以看起来像"偶发失败"而不是"这条路径根本不通"。
 *
 * ⇒ 从 Rust 源码里解析 `pub fn` 的参数表，与前端 `invoke('x', { ... })` 的键比对。
 *
 * ## 解析要点（踩过的坑）
 * **必须按方括号配平扫描**，不能用 `generate_handler!\s*\[(.*?)\]` 这类非贪婪正则 ——
 * 列表里有 `#[cfg(target_os = "linux")]`，其中的 `]` 会让非贪婪匹配**提前截断**，
 * 于是「它之后的所有命令」都被判成未注册，产出大量**假阳性**。
 * （我第一版就错在这：算出 24 个断链，实际只有 1 个。）
 */
import { describe, expect, it } from 'vitest';

/** 构建期把需要的源文件读成字符串（vite `?raw`）。 */
const RAW = import.meta.glob('../../src-tauri/src/{main.rs,android/mod.rs}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 前端源码（拆成两个 glob，便于区分是否在 src/mobile 下）。 */
const FRONTEND = import.meta.glob(['../**/*.{ts,tsx,js,jsx}', '!../**/*.test.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Rust 源码全文（只有 94 个文件 / ~294KB，直接 eager 读 —— 便于按函数名找签名）。
 * 刻意**不**按注册表里的模块路径推文件路径：`a::b::c::d` 到底是 `c/d.rs` 还是 `b/d.rs`
 * 有歧义，猜错就会静默漏判。
 */
const RUST = import.meta.glob('../../src-tauri/src/**/*.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 插件源码（命令名防线没覆盖 plugins/，但参数名这一关必须覆盖 —— 茑萝那处就写错了）。 */
const PLUGIN_FRONTEND = import.meta.glob('../../plugins/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 按后缀取源文件内容。
 * 不按精确键索引：`import.meta.glob` 的键是**相对本测试文件**的路径
 * （形如 `../../src-tauri/src/main.rs`），与"从项目根算"的写法不一致；
 * 用后缀匹配把这个形式差异隔离掉。
 */
function rawBySuffix(suffix: string): string {
  const key = Object.keys(RAW).find((k) => k.endsWith(suffix));
  if (!key) {
    throw new Error(
      `?raw glob 没抓到 *${suffix}。实际抓到的键：${JSON.stringify(Object.keys(RAW))}`,
    );
  }
  return RAW[key];
}

/** 按方括号配平解析 `generate_handler![...]`，返回命令名集合。 */
function handlerSet(relPath: string): Set<string> {
  const text = rawBySuffix(relPath.replace('src-tauri/src/', ''));
  const start = text.indexOf('generate_handler!');
  if (start < 0) throw new Error(`${relPath} 里找不到 generate_handler!`);
  const open = text.indexOf('[', start);

  let depth = 0;
  let k = open;
  for (; k < text.length; k++) {
    if (text[k] === '[') depth++;
    else if (text[k] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`${relPath} 的 generate_handler! 方括号不配平`);

  const out = new Set<string>();
  for (const rawLine of text.slice(open + 1, k).split('\n')) {
    // 去掉行内注释与尾逗号；跳过属性行（#[cfg(...)]）与空行
    const line = rawLine.split('//')[0].trim().replace(/,$/, '');
    if (!line || line.startsWith('#')) continue;
    out.add(line.split('::').pop()!);
  }
  return out;
}

/**
 * 收集前端源码里的 `invoke('name')` 命令名 → 出现位置。
 * `onlyMobile` 为真时只取 `src/mobile/` 下的（便于"桌面"这一侧排除移动端专用命令）。
 */
function invokedIn(onlyMobile: boolean): Map<string, string[]> {
  const found = new Map<string, string[]>();
  // 匹配 invoke 之后到第一个 ( 之间的任意内容 —— **不能**写成 (?:<[^>]*>)?：
    // 泛型可能嵌套（invoke<Record<string, unknown>>(...)），[^>]* 会在第一个 > 处失配，
    // 于是整条调用被漏掉、命令被误报成未调用。这个坑我踩过一次（2026-10-15）。
    // 只认「invoke 后紧跟（可选 ?. / 泛型 / 空白）+ 左括号 + 引号命令名」。
    // 不能用 [^(]* 通配：注释里出现 invoke 字样时会一路吃到下一行的括号，
    // 把无关字符串当成命令名（2026-10-21 实测：注释里提到 invoke，它把下面
    // ensureOverlayWindow('deskpet') 的 'deskpet' 报成未注册命令；
    // 另有个用例里的 'function' 也是同一类误报）。
    const re = /invoke\s*(?:\?\.)?\s*(?:<[^()]*?>)?\s*\(\s*'([A-Za-z0-9_]+)'/g;
  for (const [path, text] of Object.entries(FRONTEND)) {
    // glob 键是相对本测试文件的路径（形如 ../mobile/screens/x.tsx），
    // 所以不能按 '/src/mobile/' 判断。
    const isMobile = /(^|\/)mobile\//.test(path);
    if (onlyMobile !== isMobile) continue;
    for (const m of text.matchAll(re)) {
      const list = found.get(m[1]) ?? [];
      list.push(path);
      found.set(m[1], list);
    }
  }
  return found;
}

/**
 * 已知的、暂不修的前端调用（**显式列出并写明理由**，不允许悄悄放过）。
 * 加进来等于承认"这里有一条断链"，所以每一条都该有对应的待办。
 */
const KNOWN_BROKEN: Record<string, string> = {
  // 2026-10-21 已修：Capsule 首次打开桌宠改用 ensureOverlayWindow('deskpet','deskpet.html')
  // （后端确实没有 show_deskpet 命令，前端不再调它）⇒ 豁免表清空，恢复全量拦截。
};

describe('前后端命令契约', () => {
  const desktop = handlerSet('src-tauri/src/main.rs');
  const android = handlerSet('src-tauri/src/android/mod.rs');

  it('桌面注册表非空且能正确解析（防空解析导致的假绿）', () => {
    // 配平解析若写错（比如正则版），会漏掉 #[cfg] 之后的一大段 —— 这里用数量下限兜住。
    expect(desktop.size).toBeGreaterThan(400);
    expect(android.size).toBeGreaterThan(30);
    // 抽查几个一定存在的命令，确保解析器抓的是真列表
    expect(desktop.has('ai_chat_agent')).toBe(true);
    expect(desktop.has('ai_get_config')).toBe(true);
  });

  it('桌面端：前端调用的命令都已注册', () => {
    const invoked = invokedIn(false);
    const missing: string[] = [];
    for (const [cmd, files] of invoked) {
      if (files.every((f) => f.startsWith('src/mobile/'))) continue; // 移动端另有注册表
      if (desktop.has(cmd)) continue;
      if (cmd in KNOWN_BROKEN) continue;
      missing.push(`${cmd}  <- ${files[0]}`);
    }
    expect(missing, `以下命令前端在调用、桌面端却没注册：\n${missing.join('\n')}`).toEqual([]);
  });

  // ⚠️ 移动端**暂不纳入**这条防线（用户 2026-10-15 明确「移动端不管」）。
  //
  // 但已核实存在的问题仍然记在这里，避免日后重蹈：
  //   `ai_vision_ocr` 被 `src/mobile/hooks/useAiStream.ts` 调用，而
  //   `android/mod.rs` 的注册表里没有它 ⇒ 移动端发图在真机上会 "command not found"。
  //   之所以特别值得记：`android/mod.rs` **只在 `target_os = "android"` 下编译**，
  //   桌面的 `cargo check` 检查不到它 —— 这类漏项在开发机上永远不会自己暴露。
  it.skip('移动端：src/mobile 调用的命令都已注册（用户明确移动端暂不管）', () => {
    const invoked = invokedIn(true);
    const missing: string[] = [];
    for (const [cmd, files] of invoked) {
      if (android.has(cmd)) continue;
      if (cmd in KNOWN_BROKEN) continue;
      missing.push(`${cmd}  <- ${files[0]}`);
    }
    expect(missing, `以下命令 src/mobile 在调用、移动端却没注册：\n${missing.join('\n')}`).toEqual([]);
  });

  it('注册表里没有重复项（Tauri 对重复注册会直接 panic）', () => {
    for (const [label, path] of [
      ['桌面', 'main.rs'],
      ['移动端', 'mod.rs'],
    ] as const) {
      const text = rawBySuffix(path);
      const start = text.indexOf('generate_handler!');
      const open = text.indexOf('[', start);
      let depth = 0;
      let k = open;
      for (; k < text.length; k++) {
        if (text[k] === '[') depth++;
        else if (text[k] === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      const names: string[] = [];
      for (const rawLine of text.slice(open + 1, k).split('\n')) {
        const line = rawLine.split('//')[0].trim().replace(/,$/, '');
        if (!line || line.startsWith('#')) continue;
        names.push(line.split('::').pop()!);
      }
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dup, `${label}注册表里有重复命令：${dup.join(', ')}`).toEqual([]);
    }
  });
// ============ 参数名防线（2026-10-16）============

/**
 * 去掉 `//` 行注释。注释里常带括号，会破坏后面的配平扫描。
 *
 * ⚠️ **不能用 `/\/\/.*$/`**（我第一版就是这么写的，坑了很久）：
 * 本仓库源码是 **CRLF**，而 JS 里 `.` **不匹配 `\r`**、`$`（不加 `m`）只在**整串末尾**成立 ——
 * 于是行内的 `//` 注释**一条都剥不掉**。后果不是"少剥注释"这么轻：
 * 参数列表里带注释的参数（如 `ai_chat` 的 `system` / `exclude_global_persona` / `effort`）
 * 会被整段跳过 → 参数集少 3 个 → 前端调用被误报成"参数名对不上"。
 * 改用 `[^\n]*`（只排除换行）就与换行风格无关了。
 */
function stripLineComments(s: string): string {
  return s.replace(/\/\/[^\n]*/g, '');
}

/** snake_case → camelCase（Tauri 默认的 rename_all）。 */
function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * 按深度 0 切分（跟踪 `<>` `()` `[]` `{}`）。
 * 参数表里的逗号可能藏在 `Option<Vec<(u32, u32)>>` 这类嵌套里，不能按逗号裸切。
 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  /** 必须**跳过字符串**：模板串里的 `(` `)` `[` `]`（如 `` `${new Date().toLocaleString('zh-CN')}` ``）
   *  会被当成真括号，把深度算歪 → 嵌套对象的键漏成顶层键（实测把 `rag_ingest` 的
   *  `source.namespace` 报成了顶层键）。字符串里的一切都不参与深度。 */
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** 找深度 0 处第一次出现的某个字符（如参数名与类型之间的 `:`）。 */
function topLevelIndexOf(s: string, ch: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** 从 `{`（或 `(`）起配平找到闭合位置；跳过字符串字面量。找不到返回 -1。 */
function matchPair(s: string, from: number): number {
  const open = s[from];
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : '';
  if (!close) return -1;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 读 `fn` 前最近的那个 `#[tauri::command(...)]`，判断参数命名。
 *
 * ⚠️ **不能一律假定 camelCase**：仓库里有几个命令**显式**写成
 * `#[tauri::command(rename_all = "snake_case")]`（`kugou_proxy` / `netease_proxy` /
 * `bilibili_proxy`），它们的前端键**就该是 snake_case**。
 * 不读这个属性就会把它们全判成错的 —— 一堆假阳性。（我第一版就这么错了。）
 */
function argCaseBefore(clean: string, fnIndex: number): 'camel' | 'snake' {
  const seg = clean.slice(Math.max(0, fnIndex - 2000), fnIndex);
  const at = seg.lastIndexOf('#[tauri::command');
  if (at < 0) return 'camel'; // 裸 #[tauri::command] → tauri-macros 的默认就是 camelCase
  return /rename_all\s*=\s*"snake_case"/.test(seg.slice(at, at + 200)) ? 'snake' : 'camel';
}

/**
 * Tauri 会**自动注入**的参数（`AppHandle` / `Webview` / `State<..>` / `Window`…），
 * 前端**不能也不该**传。所以它们必须从"必填"里排除 —— 否则每条带 app 的命令都会被误报成"缺必填"。
 */
const INJECTED_TYPES = /(AppHandle|Webview|State<|Window|CommandScope)/;

interface CmdSig {
  /** 全部参数名（camelCase）。 */
  params: Set<string>;
  /** 非 `Option<...>` 的参数（Tauri 缺了会 "invalid args"）。 */
  required: Set<string>;
}

/**
 * 按名字在 Rust 源码里找出**所有** `pub[(…)] [async] fn ‹name›(` 的签名。
 *
 * ⚠️ **必须收集全部同名签名，不能取第一个**（踩过的坑）：
 * 桌面版与移动版常同名但参数完全不同 —— 例如 `rag_embed_api` 在
 * `commands/rag_commands.rs` 是 `(texts, endpoint, api_key, model)`，
 * 在 `android/mod.rs` 是 `(req: RagEmbedRequest)`（一个转发包装）。
 * `ai_chat` 同理。而 `Object.values(RUST)` 的字典序让 `android/` 排在最前，
 * 取第一个就会拿**包装版**的参数去比桌面的调用 —— 产出 30 多条**假阳性**。
 *
 * 判据因此改成：一个键只要出现在**任一**变体里就算合法（调用方可能面向任何一个），
 * "缺必填"则要求**存在某个变体被完全满足**。
 */
function findSignatures(fnName: string): CmdSig[] {
  const re = new RegExp(`\\bpub(?:\\s*\\(crate\\))?\\s+(?:async\\s+)?fn\\s+${fnName}\\s*\\(`);
  const out: CmdSig[] = [];
  for (const text of Object.values(RUST)) {
    const clean = stripLineComments(text);
    const m = re.exec(clean);
    if (!m) continue;
    // 收窄：只认**真的 tauri 命令**。同名但非命令的 fn（如内部辅助函数）
    // 参数完全不同，拿它们去比会产出假阳性。
    if (!/#\[tauri::command/.test(clean.slice(Math.max(0, m.index - 2000), m.index))) continue;
    const open = clean.indexOf('(', m.index + m[0].length - 1);
    const end = matchPair(clean, open);
    if (end < 0) continue;
    const kase = argCaseBefore(clean, m.index);
    const params = new Set<string>();
    const required = new Set<string>();
    for (const part of splitTopLevel(clean.slice(open + 1, end))) {
      // 参数上可能挂属性（如 #[serde(default)]），先去干净
      const p = part.replace(/#\[[^\]]*\]/g, '').trim();
      if (!p) continue;
      const ci = topLevelIndexOf(p, ':');
      if (ci < 0) continue;
      // ⚠️ 先剥掉**前导下划线**再转 camelCase：`_note_id` 直接丢给 toCamel 会得到 `NoteId`
      //    （下划线后的字母被当成词首大写）—— 实测被这个坑出 30 多条假阳性。
      //    heck 的 to_lower_camel_case("_note_id") 给的是 "noteId"。
      const raw = p.slice(0, ci).trim().replace(/^mut\s+/, '').replace(/^_+/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) continue;
      const ty = p.slice(ci + 1).trim();
      const key = kase === 'snake' ? raw : toCamel(raw);
      params.add(key);
      // Option 可省；Tauri 注入的参数前端传不了，也不算必填
      if (!ty.startsWith('Option<') && !INJECTED_TYPES.test(ty)) required.add(key);
    }
    out.push({ params, required });
  }
  return out;
}

interface InvokeCall {
  cmd: string;
  file: string;
  keys: string[];
  /** 对象里有 `...` 展开 —— 此时"缺必填"判不了（键可能来自被展开的对象）。 */
  hasSpread: boolean;
}

/** 收集前端 `invoke('cmd', { ... })` 的**字面量键**。非对象字面量（变量/无参）跳过。 */
function invokeCalls(): InvokeCall[] {
  const out: InvokeCall[] = [];
  const sources: Array<[string, string]> = [
    ...Object.entries(FRONTEND),
    ...Object.entries(PLUGIN_FRONTEND),
  ];
  const re = /invoke\s*[^(]*\(\s*'([A-Za-z0-9_]+)'/g;
  for (const [path, rawText] of sources) {
    const text = stripLineComments(rawText);
    for (const m of text.matchAll(re)) {
      let i = m.index + m[0].length;
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (text[i] !== '{') continue; // 不是对象字面量 → 无从静态判断
      const end = matchPair(text, i);
      if (end < 0) continue;
      const keys: string[] = [];
      let hasSpread = false;
      for (const part of splitTopLevel(text.slice(i + 1, end))) {
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith('...')) {
          hasSpread = true;
          continue;
        }
        const ci = topLevelIndexOf(p, ':');
        if (ci < 0) {
          // 简写形式 `{ prompt, comfyuiUrl }` —— 整段就是键
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) keys.push(p);
          continue;
        }
        const k = p.slice(0, ci).trim().replace(/^['"]|['"]$/g, '');
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k);
      }
      out.push({ cmd: m[1], file: path, keys, hasSpread });
    }
  }
  return out;
}

/**
 * 参数名不匹配的**显式登记表**（每条必须写明理由与后果）。
 *
 * ⚠️ **现在是空的** —— 2026-10-17 用户批准"需要就加"，原先登记的 4 类全部落地：
 *   - `pick_file` 补了 `title` / `multiple`（原先调用方在传、Rust 没这两个参数、静默失效）
 *   - `run_shell_command` 补了 `cwd`（同上）
 *   - `ai_chat({stream})` 的键**直接删掉**（该命令恒流式，那个键只会被静默忽略）
 * 空表意味着这条防线**全量拦截**：任何新的参数名不匹配都会被立刻打红。
 * 日后若确实需要临时放过某条，**必须**在这里写清理由 —— 不允许悄悄放过。
 */
const KNOWN_ARG_MISMATCH: Record<string, string> = {};

/**
 * 由插件沙箱**自动注入**的参数（调用方不传是正确的，不是"漏传"）。
 *
 * `pluginSandbox.createSafeApi` 的转发是 `invoke(command, { ...args, pluginId })`——
 * 注入值在展开之后，插件传什么都覆盖不了它。所以插件源码里写
 * `invoke('plugin_storage_get', { key })` 完全正确；而 Rust 签名里
 * `plugin_id: String` 是必填。不登记这张表，契约测试就会把每条插件侧调用
 * 误判成"缺少必填参数 pluginId"（2026-10-19 加攻防会话持久化时撞到）。
 */
const SANDBOX_INJECTED_ARGS: Record<string, string[]> = {
  plugin_storage_get: ['pluginId'],
  plugin_storage_set: ['pluginId'],
};

describe('前后端命令参数名契约', () => {
  // 只校验**桌面注册表里真实注册的**命令：别的名字（插件自定义、非命令函数）
  // 没有权威签名可比，硬比只会产出假阳性。
  const desktop = handlerSet('src-tauri/src/main.rs');

  it('解析器自检（防"什么都没解析到"的假绿）', () => {
    // 抽两个一定存在的命令，确认能解析出参数名与"必填"判定
    const chats = findSignatures('ai_chat');
    expect(chats.length, 'ai_chat 应有签名（桌面 + 移动包装）').toBeGreaterThan(0);
    const desktop = chats.find((s) => s.params.has('messages'));
    expect(desktop, '应能找到含 messages 的桌面版签名').toBeTruthy();
    expect(desktop!.required.has('messages')).toBe(true);
    // Option 参数不算必填
    expect(desktop!.required.has('profileId')).toBe(false);

    const calls = invokeCalls();
    expect(calls.length, '应能从前端收到若干 invoke 调用').toBeGreaterThan(30);
    expect(calls.some((c) => c.cmd === 'ai_chat_agent')).toBe(true);
  });

  it('所有 invoke 的对象键都是该命令的真实参数（Tauri 只认 camelCase）', () => {
    const bad: string[] = [];
    for (const c of invokeCalls()) {
      if (c.cmd in KNOWN_BROKEN || !desktop.has(c.cmd)) continue;
      const sigs = findSignatures(c.cmd);
      if (sigs.length === 0) continue; // 找不到签名 → 不判（宁缺勿假报）
      for (const k of c.keys) {
        const tag = `${c.cmd}({ ${k} })`;
        if (tag in KNOWN_ARG_MISMATCH) continue;
        if (!sigs.some((s) => s.params.has(k))) bad.push(`${tag}  <- ${c.file}`);
      }
    }
    expect(
      bad,
      `以下调用的参数名与 Rust 签名对不上（Tauri 默认 rename_all = "camelCase"，\n` +
        `把 snake_case 写在 invoke 里会直接 "invalid args"）：\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('非 Option 参数必须都传（没有展开时才判）', () => {
    const bad: string[] = [];
    for (const c of invokeCalls()) {
      if (c.cmd in KNOWN_BROKEN || c.hasSpread || !desktop.has(c.cmd)) continue;
      const sigs = findSignatures(c.cmd);
      if (sigs.length === 0) continue;
      // 沙箱注入的参数不算调用方的责任（见 SANDBOX_INJECTED_ARGS）
      const injected = new Set(SANDBOX_INJECTED_ARGS[c.cmd] ?? []);
      // 只要**存在一个变体被完全满足**就算通过（同名桌面/移动包装的参数不同）
      const satisfied = sigs.some((s) =>
        [...s.required].every((r) => injected.has(r) || c.keys.includes(r)),
      );
      if (!satisfied) {
        const best = sigs.reduce((a, b) => (a.required.size <= b.required.size ? a : b));
        const miss = [...best.required].filter((r) => !injected.has(r) && !c.keys.includes(r));
        bad.push(`${c.cmd} 缺少必填参数 ${miss.join(', ')}  <- ${c.file}`);
      }
    }
    expect(bad, `以下调用缺少 Rust 侧的必填参数：\n${bad.join('\n')}`).toEqual([]);
  });
});

});
