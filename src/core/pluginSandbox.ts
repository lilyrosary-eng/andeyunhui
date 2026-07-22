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
import { logger } from '@/lib/logger';
import { createFrameBuffer } from '@/lib/frameBuffer';

// 合并 react-dom（legacy: render / flushSync）+ react-dom/client（React 18: createRoot / hydrateRoot）
// esbuild 的 hostExternals 将 'react-dom' 和 'react-dom/client' 都映射到 __HOST_REACT_DOM__，
// 故此对象需同时承载两套 API
const ReactDOM = { ...ReactDOMNS, ...ReactDOMClient } as unknown as typeof ReactDOMNS;

// ========== 插件可调用的 Tauri 命令白名单 ==========
// 内置插件（图片、音乐等）需要的所有命令
const ALLOWED_COMMANDS = new Set([
  // 存储
  'plugin_storage_get',
  'plugin_storage_set',
  'plugin_log',
  // 图片模块
  'load_image_cache',
  'cancel_scan',
  'scan_image_root',
  'delete_image_cache',
  'pick_directory',
  'pick_file',
  'get_folder_images',
  // 音乐模块
  'load_music_cache',
  'scan_music_root',
  'delete_music_cache',
  'read_track_metadata',
  'get_lyrics',
  'show_lyrics_widget',
  'hide_lyrics_widget',
  'set_lyrics_widget_locked',
  'get_lyrics_widget_locked',
  // SMTC（任务栏「正在播放」）：前端推送播放状态 + 上报激活模块 + 诊断日志。
  // 注意：这些命令此前漏加白名单，导致沙箱内 music/video 插件的 invoke 被静默拦截
  // （插件侧 .catch 吞错），元信息永远到不了 Rust，任务栏卡片不显示。
  'smtc_update',
  'smtc_status',
  'set_active_module',
  'set_window_hidden',
  'debug_log',
  // 视频模块
  'load_video_cache',
  'scan_video_root',
  'delete_video_cache',
  'get_folder_videos',
  // 阅读模块
  'scan_reading_root',
  'load_reading_cache',
  'delete_reading_cache',
  'open_book',
  'cancel_open_book',
  // 通用
  'check_file_exists',
  // 办公（wps）插件：文档导入（docx→markdown）、演示导入（pptx→json）
  'convert_to_markdown',
  'wps_import_pptx',
  'wps_import_pptx_diagnose',
  // 黑名单管理
  'get_blacklist_paths',
  'add_to_blacklist',
  'remove_from_blacklist',
  // 专业模块「薄荷」工具
  'get_env_vars',
  'set_env_var',
  'scan_ports',
  'list_processes',
  'clipboard_read',
  'clipboard_write',
  'clipboard_read_image',
  'clipboard_clear',
  'clipboard_poll_image',
  'convert_image',
  'convert_document',
  'check_ffmpeg',
  'transcode_media',
  // 薄荷音频转换：音频 → MIDI 转写（basic-pitch，MIT）
  'audio_to_midi',
  // 通用：插件按需读取自身入口脚本与文件
  'read_plugin_file',
  // IDE 子插件：按需加载 CodeMirror 等外部依赖
  'read_external_dep_file',
  // 本地 OCR 引擎（PaddleOCR 依赖包）：按相对路径读取二进制资产（ONNX 模型 / 权重）为 base64
  'read_external_dep_bytes',
  // 绘画子插件：导出到剪贴板 / 中转站
  'clipboard_write_image',
  'clipboard_write_image_from_path',
  'add_bytes_to_dropzone',
  // IDE 子插件：读取文本文件 / 目录列表
  'read_text_file',
  'list_directory',
  'ensure_directory',
  // IDE 子插件：保存 / 另存为（Rust 端已实现并注册，此前漏加白名单导致被沙箱拦截）
  'write_text_file',
  // 通用：插件导出二进制文件（XLSX / 图片等），base64 解码后原子写盘
  'write_file_bytes',
  'pick_save_file',
  // 图片模块：读取文件为 data URI（GIF 绕过 asset: 协议动画限制）
  'read_file_base64',
  // 全局 AI 能力：茑萝 · AI 编程 子插件调用（LLM 走后端，规避沙箱屏蔽 fetch）
  'ai_get_profiles',
  'ai_set_profiles',
  'ai_chat',
  // IDE 终端：本地 shell 命令执行（沙箱屏蔽了 child_process，需走 Rust）
  'run_shell_command',
  // AI agent 受限 shell：白名单 + Dry-Run 黑名单 + 超时（仅 agent 自主编辑模式使用）
  'run_agent_shell',
  // 薄荷·网络测速：用系统默认浏览器打开外链（test.ustc.edu.cn）
  'plugin:opener|open_url',
  // 桌宠引擎：销毁其常驻浮窗（与 overlay_window_get_or_create 配对）
  'overlay_window_destroy',
]);

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
function createSafeApi(pluginId: string) {
  return {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (!ALLOWED_COMMANDS.has(command)) {
        const msg = `插件 "${pluginId}" 尝试调用未授权命令: ${command}`;
        console.error(`[pluginSandbox] 拦截未授权命令: ${command} (插件:${pluginId}) —— 若需放开请在 ALLOWED_COMMANDS 白名单追加`);
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
    // 帧缓冲工具：高频数据推送批处理，避免渲染风暴
    createFrameBuffer: createFrameBuffer,
    // 创建浮窗窗口（前端 WebviewWindow API，规避 sync 命令中 build 导致的主线程重入死锁）
    // 用于剪贴板浮窗等场景，label 由插件指定（如 'floating-clipboard'）
    createFloatingWindow: async (label: string, url: string, options: Record<string, unknown>) => {
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

export function createSandboxGlobals(
  pluginId: string,
  registry: PluginRegistry,
  deps?: string[],
): SandboxGlobals {
  // 声明了 external-deps 的插件必须能 new Function 加载依赖；白名单为保底。
  const exposeFunction = TRUSTED_FUNCTION_PLUGINS.has(pluginId) || (deps?.length ?? 0) > 0;
  return {
    React,
    ReactDOM,
    register: (def: PluginDef) => {
      registry.register(def);
    },
    api: createSafeApi(pluginId),
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
    // 受限 window：优先返回宿主注入变量，未知属性透传真实 window
    window: new Proxy<SafeWindow>(
      {
        __HOST_REACT__: React,
        __HOST_REACT_DOM__: ReactDOM,
        __HOST_API__: createSafeApi(pluginId),
        __PLUGIN_REGISTRY__: registry,
        __HOST_UI__: window.__HOST_UI__ || {},
      },
      {
        get(target, prop) {
          if (prop in target) return (target as Record<string, unknown>)[prop as string];
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
    ),
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
  eval: undefined,
  Function: exposeFunction ? Function : undefined,
  WebSocket: undefined,
  Worker: undefined,
  // 宿主注入的全局变量
    __HOST_REACT__: React,
    __HOST_REACT_DOM__: ReactDOM,
    __HOST_API__: createSafeApi(pluginId),
    __PLUGIN_REGISTRY__: registry,
    __HOST_UI__: window.__HOST_UI__ || {},
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
  _pluginId: string,
): void {
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