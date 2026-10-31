/**
 * 插件沙箱执行环境
 *
 * 替换 eval() 直接执行插件代码，提供三层安全隔离：
 * 1. new Function() — 无法访问闭包作用域，仅能访问全局作用域
 * 2. 全局变量影子遮蔽 — 将危险全局变量替换为受限版本
 * 3. "use strict" — 阻止部分危险模式（如 arguments.callee）
 *
 * 注意：完全隔离需要 Web Worker / iframe，但 React 组件插件必须
 * 在主线程渲染。本沙箱在"可用性"和"安全性"之间取得平衡。
 */

import React from 'react';
// 完整 react-dom（含 flushSync）+ react-dom/client（createRoot / hydrateRoot）
// 作为 __HOST_REACT_DOM__ 提供给插件沙箱：
//   - TipTap 等老库外部化 'react-dom'，需要 flushSync / render
//   - Univer 等 React 18 库外部化 'react-dom/client'，需要 createRoot
// 两者合并到同一全局变量，兼容新旧 React 渲染 API
import * as ReactDOMNS from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { ensureOverlayWindow, type OverlayProfile } from '@/core/overlayWindow';
import { PluginRegistry, type PluginDef } from '@/core/pluginRegistry';
import type { PluginPermissions } from '@/lib/api';
// 沙箱里刻意不走 @/lib/logger：它经 tauri invoke 落盘，而沙箱/控制台要在任何宿主服务
// 缺失时也能报错（拦截未授权命令必须让开发者看见），故此处直接用 console.*。
import { createFrameBuffer } from '@/lib/frameBuffer';

// 合并 react-dom（legacy: render / flushSync）+ react-dom/client（React 18: createRoot / hydrateRoot）
// esbuild 的 hostExternals 将 'react-dom' 和 'react-dom/client' 都映射到 __HOST_REACT_DOM__，
// 故此对象需同时承载两套 API
const ReactDOM = { ...ReactDOMNS, ...ReactDOMClient } as unknown as typeof ReactDOMNS;

// ========== 插件能力模型 ==========
// 命令 → 能力的规则由 Rust 下发（plugin_capability_rules），授权账本由 Rust 保存；
// 前端不再维护逐命令白名单。见 src/core/pluginAccess.ts。
import type { SandboxPolicy } from '@/core/pluginAccess';
import { denyAllPolicy, policyAllows, policyDenyReason } from '@/core/pluginAccess';
import { pluginDiagnostics } from '@/core/pluginDiagnostics';

// ========== 命令调用策略（能力制） ==========
// 实际放行由 SandboxPolicy 决定：能力规则 ∩ 已授权能力 ∩（旧式 commands 收紧）。

// ========== 安全 Console：所有输出带插件前缀 ==========
// 生产环境静默 log/info/debug/count/trace，保留 warn/error，避免高频日志拖慢主线程
const isProd = !import.meta.env.DEV;
const noop = () => {};

function createSafeConsole(pluginId: string): Console {
  const prefix = `[插件:${pluginId}]`;
  return {
    log: isProd ? noop : (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
    info: isProd ? noop : (...args: unknown[]) => console.info(prefix, ...args),
    debug: isProd ? noop : (...args: unknown[]) => console.debug(prefix, ...args),
    // 以下方法直接透传，不做额外处理
    assert: console.assert.bind(console),
    // 生产环境禁止插件清空控制台，避免抹掉调试痕迹
    clear: isProd ? noop : console.clear.bind(console),
    count: isProd ? noop : console.count.bind(console),
    countReset: console.countReset.bind(console),
    dir: console.dir.bind(console),
    dirxml: console.dirxml.bind(console),
    group: console.group.bind(console),
    groupCollapsed: console.groupCollapsed.bind(console),
    groupEnd: console.groupEnd.bind(console),
    table: console.table.bind(console),
    time: console.time.bind(console),
    timeEnd: console.timeEnd.bind(console),
    timeLog: console.timeLog.bind(console),
    timeStamp: console.timeStamp.bind(console),
    trace: isProd ? noop : console.trace.bind(console),
  } as Console;
}

// ========== 安全 API 代理：白名单拦截 + 安全事件透传 ==========
// 关键诊断改进（2026-07-18）：此前插件侧 `invoke(...).catch(() => {})` 会静默吞掉所有
// 错误（未授权命令 / Tauri ACL 拦截 / 命令执行异常），导致"明明调了却毫无反应、日志还被吞"。
// 这里在代理层把三件事显式打印出来，全部经宿主真实 console，会被 tauri dev 转发到终端 stdout：
//   1) 未授权命令 → console.error（红色，明确提示漏加白名单）
//   2) 命令执行失败 → console.error（暴露被插件 .catch 吞掉的真正错误，如权限拒绝）
//   3) 放行命令 → 仅开发环境 console.warn（确认调用确实发出了，便于对照 Rust 侧是否收到）
//
// 声明式权限（manifest.permissions.commands）落地后，第 1 类的报错进一步细分成两种原因，
// 并给出**可直接复制**的修复提示 —— 此前只有一句"未授权命令"，插件侧 .catch 吞掉后
// 根本无法判断是 manifest 漏声明还是全局白名单漏加，只能靠猜。
// 未授权命令的诊断节流：同一插件+命令 5 秒内只记一条，避免刷屏
const deniedAt = new Map<string, number>();

function createSafeApi(pluginId: string, policy: SandboxPolicy) {
  return {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (!policyAllows(policy, command)) {
        const fix = policyDenyReason(policy, command);
        const msg = `插件 "${pluginId}" 尝试调用未授权命令: ${command} —— ${fix}`;
        console.error(`[pluginSandbox] 拦截未授权命令: ${command} (插件:${pluginId}) —— ${fix}`);
        const key = `${pluginId}:${command}`;
        const now = Date.now();
        const last = deniedAt.get(key) ?? 0;
        if (now - last > 5000) {
          deniedAt.set(key, now);
          try {
            pluginDiagnostics.addEntry({
              pluginId,
              stage: 'permission',
              reason: `拒绝命令 ${command}：${fix}`,
              timestamp: now,
            });
          } catch { /* 诊断不可用时不影响拦截 */ }
        }
        throw new Error(msg);
      }
      if (import.meta.env.DEV) {
        console.warn(`[pluginSandbox] 放行命令: ${command} (插件:${pluginId})`);
      }
      try {
        return await invoke(command, { ...args, pluginId });
      } catch (err) {
        console.error(`[pluginSandbox] 命令执行失败: ${command} (插件:${pluginId})`, err);
        throw err;
      }
    },
    // 以下方法安全透传——事件监听和资产转换无安全风险
    listen: listen,
    emit: emit,
    convertFileSrc: convertFileSrc,
    // 宿主侧读文件 → 返回 blob: URL。存在的理由：插件沙箱**刻意**屏蔽了
    // fetch / XMLHttpRequest / WebSocket（见下方 GLOBAL_OVERRIDES），所以插件
    // 无法自己把本地文件读成 Blob。而 WebKitGTK 的媒体加载器又不接管 Tauri 的
    // asset:// 自定义 scheme（图片走普通资源加载能通、音视频不走），
    // 于是本地音乐在 Linux 上既不能直接播、也读不出来。
    //
    // 宿主窗口的 fetch 是完好的（沙箱只改插件那个 window），而插件 iframe 与宿主
    // **同源** ⇒ 在宿主里创建的 blob: URL 插件侧可直接用于 <audio>。
    //
    // ⚠ 安全：这是**放宽**了插件能读的文件范围，因此按扩展名白名单收紧 ——
    //   只允许音频/媒体文件。插件若需要读别的类型，应走能力授权 + 文件命令，
    //   而不是把任意文件读取能力一次性给出去。
    readFileAsObjectUrl: async (path: string, maxBytes?: number): Promise<string> => {
      if (!policy.bundled && !policyAllows(policy, 'read_file_base64')) {
        throw new Error('readFileAsObjectUrl: 插件缺少 fs.read 能力（请在 设置 → 扩展 中授权）');
      }
      const ext = (path.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
      const ALLOW = new Set([
        'mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'ape', 'alac',
      ]);
      if (!ALLOW.has(ext)) {
        throw new Error(`readFileAsObjectUrl: 不允许读取该类型文件 (.${ext || '无扩展名'})`);
      }
      const url = convertFileSrc(path);
      // ⚠⚠ **必须做体积上限**（实测教训，代价是 OOM 掉整个桌面）：
      // 整首读成 blob 会让**页缓存**暴涨 —— 内核 OOM 现场证据：
      //     anon 451MB / file 5.65GB，栈顶 filemap_add_folio → do_read_fault
      // 也就是说内存不是进程堆涨的，是「反复读整首歌」把 page cache 撑爆的。
      // cgroup 有 MemoryMax 时更糟：页缓存不能通过全局回收自救（不允许拿别的
      // cgroup 的页来释放自己），于是直接触发 OOM，把整机进程一起带走。
      //
      // 先用 Range 请求只取 1 字节，从 Content-Range 头拿到真实大小，
      // 超限就直接失败 —— 宁可这条大文件播不了，也不能拖垮系统。
      // （为什么不用 HEAD：Tauri 的 asset 协议是 GET 型应答器，HEAD 不一定被支持。）
      const LIMIT = maxBytes && maxBytes > 0 ? maxBytes : 8 * 1024 * 1024;
      const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      const cr = probe.headers.get('content-range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      const size = m ? Number(m[1]) : Number(probe.headers.get('content-length') || 0);
      if (size > LIMIT) {
        throw new Error(
          `readFileAsObjectUrl: 文件 ${(size / 1048576).toFixed(1)}MB 超过上限 ` +
            `${(LIMIT / 1048576).toFixed(0)}MB（整首读入会撑爆页缓存导致 OOM）`
        );
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`readFileAsObjectUrl: HTTP ${res.status}`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
    revokeObjectUrl: (url: string) => {
      try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
    },
    // 帧缓冲工具：高频数据推送批处理，避免渲染风暴
    createFrameBuffer: createFrameBuffer,
    // 创建浮窗窗口（前端 WebviewWindow API，规避 sync 命令中 build 导致的主线程重入死锁）
    // 用于剪贴板浮窗等场景，label 由插件指定（如 'floating-clipboard'）
    createFloatingWindow: async (label: string, url: string, options: Record<string, unknown>) => {
      if (!policy.bundled && !policyAllows(policy, 'browser_open')) {
        throw new Error('createFloatingWindow: 插件缺少 window 能力（请在 设置 → 扩展 中授权）');
      }
      // 统一走 window_manager 引擎；options 即 OverlayProfile（camelCase 字段已由 Rust 端解析）
      const win = await ensureOverlayWindow(label, url, options as OverlayProfile);
      if (win) {
        await win.show().catch(() => {});
        await win.setFocus().catch(() => {});
      }
    },
  };
}

// ========== 沙箱全局变量定义 ==========
/** 受限 window 对象：宿主注入变量优先，其余透传到真实 window */
interface SafeWindow extends Record<string, unknown> {
  __HOST_REACT__?: unknown;
  __HOST_REACT_DOM__?: unknown;
  __HOST_API__?: unknown;
  __PLUGIN_REGISTRY__?: unknown;
  __HOST_UI__?: unknown;
  __HOST_I18N__?: unknown;
}

export interface SandboxGlobals {
  React: typeof React;
  ReactDOM: typeof ReactDOM;
  register: (def: PluginDef) => void;
  api: ReturnType<typeof createSafeApi>;
  console: Console;
  // 安全的定时器（直接绑定到 window，避免 Worker 兼容问题）
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
  // JSON / Math / Date / Array / Object 等常用内置对象
  JSON: typeof JSON;
  Math: typeof Math;
  Date: typeof Date;
  Object: typeof Object;
  Array: typeof Array;
  String: typeof String;
  Number: typeof Number;
  Boolean: typeof Boolean;
  Map: typeof Map;
  Set: typeof Set;
  Promise: typeof Promise;
  Error: typeof Error;
  RegExp: typeof RegExp;
  parseInt: typeof parseInt;
  parseFloat: typeof parseFloat;
  isNaN: typeof isNaN;
  isFinite: typeof isFinite;
  // 受限 window：仅暴露宿主注入变量，插件编译时通过 window.__HOST_XXX__ 引用
  window: SafeWindow;
  // 禁止访问的危险全局变量用 undefined 影子遮蔽
  // 注意: document/location/navigator 不遮蔽，React 插件需要它们渲染 DOM
  // 注意: localStorage/sessionStorage 不遮蔽，插件需要用于持久化
  fetch: undefined;
  XMLHttpRequest: undefined;
  indexedDB: undefined;
  alert: undefined;
  prompt: undefined;
  confirm: undefined;
  eval: undefined;
  Function?: typeof Function;
  WebSocket: undefined;
  Worker: undefined;
  // 宿主注入的全局变量（插件通过 Vite globals 构建引用）
  __HOST_REACT__: typeof React;
  __HOST_REACT_DOM__: typeof ReactDOM;
  __HOST_API__: ReturnType<typeof createSafeApi>;
  __PLUGIN_REGISTRY__: PluginRegistry;
  __HOST_UI__: Record<string, unknown>;
  __HOST_I18N__: Record<string, unknown>;
}

/**
 * 创建插件沙箱的全局变量
 */
// 受信任、允许使用 Function 构造器的插件白名单（保底）。
// 其余插件仍遮蔽 Function，保持沙箱隔离。
// 当前 'ide'：它需要 new Function() 运行时加载 CodeMirror 外部依赖（external-deps/codemirror）。
// 注意：只要插件 manifest 声明了 deps（即依赖 external-deps 并需 new Function 加载），
// 会自动开放 Function，无需在此逐个登记——契合「依赖全走 external-deps」约定。
const TRUSTED_FUNCTION_PLUGINS = new Set(['ide', 'wps', 'ocr']);

/**
 * 未获放行的插件拿到的 `Function` —— **不是 `undefined`，而是一个禁止调用/构造的 `Proxy`**。
 *
 * ## 血案（2026-10-15）
 * 原实现是 `Function: undefined`，目的是堵住 `new Function()` 动态执行代码。但
 * `x instanceof Function` 是**第三方库代码里极常见的分支**，而 `instanceof` 的右值
 * 不是对象时会直接抛：
 *     TypeError: Right-hand side of 'instanceof' is not an object
 * 实测：插件 `ai-chat` 的「AI 工作 → 蓝图」画布用 React Flow，其 `MiniMap` 内部有
 *     `const getFunc = e => e instanceof Function ? e : () => e`
 * 于是**只要蓝图画布渲染一次，整个 AI 页面就被 ErrorBoundary 捕获成崩溃**。
 * 崩溃栈定位方式：报错 `<anonymous>:324:68430` 的"匿名函数行号 = 脚本行号 + 3
 * （`new Function` 的包装头），据此还原到 bundle 第 321 行原文对上了这一句。
 *
 * ## 为什么必须是 Proxy 而不是"随便给个函数"
 * `instanceof` 走 `OrdinaryHasInstance`：取右值的 `prototype`，再沿左值原型链查找。
 * - 给一个普通空函数 → `prototype` 是它自己的 `{}`，**任何真函数都不匹配**，
 *   库会走错分支（把函数当值包裹一层），bug 更隐蔽。
 * - 给真 `Function` 的 `Proxy` → 原型链一致，`instanceof` 语义**完全正确**；
 *   同时 `apply`/`construct` 陷阱把唯一的危险路径堵死。
 *
 * ⇒ 安全性**不降级**（`new Function` / `Function('code')` 仍然抛错），兼容性**恢复**。
 */
const sandboxedFunction = new Proxy(Function, {
  apply() {
    throw new Error('插件沙箱已禁用 Function 构造器：不允许动态执行代码');
  },
  construct() {
    throw new Error('插件沙箱已禁用 Function 构造器：不允许动态执行代码');
  },
});

/** createSandboxGlobals 需要的 manifest 子集（只取沙箱关心的两个字段） */
export interface SandboxManifestInput {
  deps?: string[];
  permissions?: PluginPermissions;
}

export function createSandboxGlobals(
  pluginId: string,
  registry: PluginRegistry,
  manifest?: SandboxManifestInput,
  accessPolicy?: SandboxPolicy,
): SandboxGlobals {
  const deps = manifest?.deps;
  // 声明了 external-deps 的插件必须能 new Function 加载依赖；白名单为保底。
  const exposeFunction = TRUSTED_FUNCTION_PLUGINS.has(pluginId) || (deps?.length ?? 0) > 0;
  // 命令调用策略：Rust 规则 + 授权账本算出的能力集合；缺省一律拒绝。
  const policy = accessPolicy ?? denyAllPolicy();
  // 受限 window：优先返回宿主注入变量，未知属性透传真实 window
  // （get 陷阱需要自引用沙箱 proxy 本身，故先声明再构造，末尾以 window: sandboxWindow 注入）
  const sandboxWindow: SafeWindow = new Proxy<SafeWindow>(
    {
      __HOST_REACT__: React,
      __HOST_REACT_DOM__: ReactDOM,
      __HOST_API__: createSafeApi(pluginId, policy),
      __PLUGIN_REGISTRY__: registry,
      __HOST_UI__: window.__HOST_UI__ || {},
      __HOST_I18N__: window.__HOST_I18N__ || {},
    },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string, unknown>)[prop as string];
        // 危险网络 API 强制遮蔽：即便插件改用 window.fetch / window.XMLHttpRequest /
        // window.WebSocket 也拿不到真身，所有出站网络必须走 hostApi.invoke → Rust 命令，
        // 统一受 truncate_messages_for_safety + HARD_CHAR_CAP 兜底（根治沙箱内直连 LLM 导致的
        // 208 万 token HTTP 400 报错）。
        if (prop === 'fetch' || prop === 'XMLHttpRequest' || prop === 'WebSocket') {
          return undefined;
        }
        // Tauri IPC 全局遮蔽：capabilities 未开 withGlobalTauri，正常情况下不存在；
        // 但一旦将来开启（或某个窗口单独开启），插件即可绕过 __HOST_API__ 的能力检查
        // 直接 invoke 任意命令。此处按"永不存在"处理，
        // 使沙箱的调用审计假设不依赖远端配置。
        // ⚠️ 例外：__TAURI_INTERNALS__ 不能遮蔽。@tauri-apps/api/core 的 invoke 实现是
        // `window.__TAURI_INTERNALS__.invoke(...)`，而 ai-chat / 薄荷 等插件走 vite.shared.config
        // 的 resolve.alias `'@' → 仓库 src/`，把宿主代码（src/lib/api.ts 等）整个编进插件 IIFE，
        // 它们的 invoke 是直连接口、根本不经过 __HOST_API__。遮蔽 __TAURI_INTERNALS__ 会让这类
        // 插件一启动就 TypeError。这同时说明沙箱从来不是安全边界（真正的边界是 Tauri
        // capability/ACL），能力检查只是"规范插件入口"的工程约束。
        if (
          prop === '__TAURI__' ||
          prop === '__TAURI_INVOKE__' ||
          prop === '__TAURI_OS__'
        ) {
          return undefined;
        }
        // 自引用窗口属性：顶层窗口里 parent/top/self/frames/globalThis 都指向真实 window，
        // 透传出去等于把上面所有遮蔽原样绕开放手（window.parent.fetch 即真身）。
        // 返回沙箱 proxy 本身：语义不变（顶层窗口 parent===window），遮蔽继续生效。
        if (
          prop === 'parent' ||
          prop === 'top' ||
          prop === 'self' ||
          prop === 'frames' ||
          prop === 'globalThis'
        ) {
          return sandboxWindow;
        }
        // 未知属性透传真实 window（addEventListener、removeEventListener 等）
        const val = (window as unknown as Record<string, unknown>)[prop as string];
        // 绑定原生函数到真实 window，防止 "Illegal invocation" 错误
        // 原生 DOM API（addEventListener、setTimeout 等）要求 this 为 EventTarget/Window，
        // 若直接返回函数引用，调用时 this 指向 sandbox proxy 就会抛错
        if (typeof val === 'function') {
          return val.bind(window);
        }
        return val;
      },
      set(target, prop, value) {
        // 写入 proxy target（与 get 的「先 target 后 window」读取顺序一致）。
        // 曾尝试改写真实 window 以追求「读写都透传」，但 get 对 target 已有 key
        // （__HOST_API__/__PLUGIN_REGISTRY__ 等）始终优先返回 target，导致 set 透传后
        // 插件拿到的仍是 target 旧值，重载后功能失效。故保留原「写 target」语义。
        (target as Record<string, unknown>)[prop as string] = value;
        return true;
      },
    },
  );
  return {
    React,
    ReactDOM,
    register: (def: PluginDef) => {
      registry.register(def);
    },
    api: createSafeApi(pluginId, policy),
    console: createSafeConsole(pluginId),
    setTimeout: setTimeout.bind(window),
    setInterval: setInterval.bind(window),
    clearTimeout: clearTimeout.bind(window),
    clearInterval: clearInterval.bind(window),
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    window: sandboxWindow,
    // 危险全局变量遮蔽
    // 注意: document/location/navigator 不遮蔽，React 插件需要它们渲染 DOM
    // 注意: localStorage/sessionStorage 不遮蔽，插件需要用于持久化
    // 注意: alert/prompt/confirm 遮蔽的是「裸调用」形式，强制插件改用 window.alert 等
    //       （经 proxy 透传，可被宿主审计/拦截）。这降低恶意插件社会工程攻击面。
    fetch: undefined,
    XMLHttpRequest: undefined,
    indexedDB: undefined,
    alert: undefined,
    prompt: undefined,
    confirm: undefined,
    // ⚠️ 这一条**实际不生效**：`executeInSandbox` 会把 `eval` 从形参列表里过滤掉
    //    （strict mode 不允许 `eval` 作形参名），所以插件里的裸 `eval` 仍解析到全局 eval。
    //    保留字段只为让 `SandboxGlobals` 的类型与意图完整；**不要据此认为 eval 已被堵住**。
    //    （有测试 assert 了现状；真要堵住需改整体包装方式，属独立任务。）
    eval: undefined,
    Function: exposeFunction ? Function : sandboxedFunction,
    WebSocket: undefined,
    Worker: undefined,
    // 宿主注入的全局变量
    __HOST_REACT__: React,
    __HOST_REACT_DOM__: ReactDOM,
    __HOST_API__: createSafeApi(pluginId, policy),
    __PLUGIN_REGISTRY__: registry,
    __HOST_UI__: window.__HOST_UI__ || {},
    __HOST_I18N__: window.__HOST_I18N__ || {},
  };
}

/**
 * 在沙箱中安全执行插件脚本
 *
 * 使用 new Function() 替代 eval()：
 * - eval() 可访问闭包作用域 → 不安全
 * - new Function() 仅可访问全局作用域 → 更安全
 * - 通过参数将危险全局变量影子遮蔽为 undefined
 * - "use strict" 阻止 arguments.callee 等危险模式
 */
export function executeInSandbox(
  script: string,
  sandbox: SandboxGlobals,
  pluginId: string,
): void {
  // 诊断：记录沙箱脚本归属（pluginId），便于复现时定位"在 ai_chat 之外直连上游 LLM"的插件。
  // 例：208 万 token HTTP 400 报错栈落在 executeInSandbox 内时，可据此确认是哪条插件脚本。
  console.info(`[sandbox] 执行插件脚本: pluginId=${pluginId}`);
  // 过滤掉 strict mode 禁用的参数名（eval 不能作为形参）
  const entries = Object.entries(sandbox).filter(([key]) => key !== 'eval');
  const paramNames = entries.map(([key]) => key);
  const paramValues = entries.map(([, value]) => value);

  const fn = new Function(
    ...paramNames,
    `"use strict";
${script}`,
  );

  fn(...paramValues);
}

// 注：原 tryImportPlugin（动态 import blob URL 加载模块化插件）已移除。
// CSP 的 script-src 不含 blob:，该路径必然失败并回退到 executeInSandbox，
// 故直接统一走沙箱执行，避免死代码与误导性日志。