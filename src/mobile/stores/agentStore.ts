// Agent 工具 Store（人机恋阶段 1 · 默认关闭）。
//
// - enabled 开关持久化 localStorage，默认 false（用户必须在设置里开启）。
// - 开启后 useAiStream 把工具说明注入 system，AI 可在回答末尾输出
//   ```json {"tool":"create_calendar","args":{...}} ```
//   前端解析并调用本 store 的 createRecord 执行。
// - 数据来自 Rust agent_tools_get / agent_tool_create / agent_tool_delete。

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface AgentRecord {
  id: string;
  title: string;
  time: string;
  note: string;
  created_at: number;
}

export interface AgentData {
  calendar: AgentRecord[];
  todos: AgentRecord[];
  reminders: AgentRecord[];
}

const AGENT_KEY = 'andeyunhui.mobile.agent.enabled';

export interface ToolCall {
  tool: 'create_calendar' | 'create_todo' | 'create_reminder' | 'set_alarm' | 'generate_image' | string;
  args: {
    title?: string;
    time?: string;
    note?: string;
    prompt?: string;
    [k: string]: unknown;
  };
}

/** 把 "YYYY-MM-DD HH:mm" 解析为本地时间戳（毫秒）；失败返回 null */
export function parseTimeToMs(time: string): number | null {
  const m = time.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [_, y, mo, d, h, mi] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** 静默模式：开启后系统级操作（闹铃/日历）不再弹确认，直接执行 */
const SILENT_KEY = 'andeyunhui.mobile.agent.silent';
export function getAgentSilent(): boolean {
  try { return localStorage.getItem(SILENT_KEY) === '1'; } catch { return false; }
}
export function setAgentSilent(v: boolean) {
  try { localStorage.setItem(SILENT_KEY, v ? '1' : '0'); } catch { /* 忽略 */ }
}

/** 工具执行结果 */
export interface ToolResult {
  text: string;
  /** 图片生成结果（data URL，useAiStream 追加为图片消息） */
  imageUrl?: string;
}

/**
 * 从 startIdx 处的 { 开始，扫描括号配对的完整 JSON 对象字符串（支持嵌套与字符串内括号）。
 * 找不到平衡闭合返回 null。
 */
function findBalancedJson(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** 从 AI 输出文本中提取工具调用 JSON 块（支持 ```json 围栏 或 裸 JSON 结尾） */
export function extractToolCall(text: string): ToolCall | null {
  if (!text) return null;
  // 优先 ```json ... ``` 围栏（取第一个围栏内容，防后续文本干扰）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fence ? fence[1] : text;
  const braceIdx = raw.indexOf('{');
  if (braceIdx < 0) return null;
  const jsonStr = findBalancedJson(raw, braceIdx);
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr);
    if (obj && typeof obj.tool === 'string' && obj.args && typeof obj.args === 'object') {
      return obj as ToolCall;
    }
  } catch { /* 忽略解析失败 */ }
  return null;
}

/** Agent 工具说明（注入 system 用） */
export function buildAgentInstructions(): string {
  // 当前日期：AI 必须用它计算"今晚/明早/后天"等相对时间（否则会编造 2025 年的过去日期）
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    '【Agent 能力】用户开启了你的工具能力。当 TA 要求你创建日历事件 / 待办 / 提醒 / 闹铃，或想让你画一张图时，',
    '请正常用文字回复，然后在回复末尾追加一个 JSON 工具调用块（不要省略，用围栏包裹）：',
    '```json',
    '{"tool":"create_calendar","args":{"title":"事件标题","time":"2026-08-05 20:00","note":"备注（可选）"}}',
    '```',
    '【今天日期】现在是 ' + dateStr + ' ' + timeStr + '。所有时间必须用今天的日期推算，例如"今晚 8 点"应写 ' + dateStr + ' 20:00，禁止使用过去日期！',
    '可用工具：',
    '- create_calendar / create_todo / create_reminder：创建日历事件/待办/提醒（time 格式 "YYYY-MM-DD HH:mm"）',
    '- set_alarm：设置系统闹铃（args: {"time":"YYYY-MM-DD HH:mm","title":"标题"}），用于"明早 8 点叫我"这类需求',
    '- generate_image：AI 画图（args: {"prompt":"图片描述"}），用于用户想要图片、插画、表情包等场景',
  ].join('\n');
}

interface AgentStore {
  enabled: boolean;
  data: AgentData;
  loaded: boolean;
  setEnabled: (v: boolean) => void;
  load: () => Promise<void>;
  /** 执行工具调用（AI 输出解析后）；返回提示文本（可能携带图片） */
  runTool: (call: ToolCall) => Promise<ToolResult>;
  /** 删除记录 */
  deleteRecord: (kind: 'calendar' | 'todo' | 'reminder', id: string) => Promise<void>;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  enabled: (() => {
    try { return localStorage.getItem(AGENT_KEY) === '1'; } catch { return false; }
  })(),
  data: { calendar: [], todos: [], reminders: [] },
  loaded: false,

  setEnabled: (v) => {
    try { localStorage.setItem(AGENT_KEY, v ? '1' : '0'); } catch { /* 忽略 */ }
    set({ enabled: v });
  },

  load: async () => {
    try {
      const d = await invoke<AgentData>('agent_tools_get');
      set({ data: d ?? { calendar: [], todos: [], reminders: [] }, loaded: true });
    } catch {
      set({ data: { calendar: [], todos: [], reminders: [] }, loaded: true });
    }
  },

  runTool: async (call) => {
    // 系统闹铃：移动端调原生桥 window.AndroidAgent.setAlarm（需用户开启静默或已确认）；桌面/预览降级
    if (call.tool === 'set_alarm') {
      const time = String(call.args.time ?? '').trim();
      const title = String(call.args.title ?? '').trim() || '闹铃';
      const ts = parseTimeToMs(time);
      if (ts === null) return { text: '（闹铃时间格式应为 "YYYY-MM-DD HH:mm"）' };
      const w = window as unknown as { AndroidAgent?: { setAlarm?: (ts: string, title: string) => boolean } };
      if (w.AndroidAgent?.setAlarm) {
        // 传 String 时间戳（Kotlin 侧 toLongOrNull），避免 JS number → Long 精度坑
        const ok = w.AndroidAgent.setAlarm(String(ts), title);
        return { text: ok ? `已设置系统闹铃：${time} ${title}` : '设置闹铃失败（可能权限不足或时间已过）' };
      }
      return { text: `（预览模式）已收到闹铃请求：${time} ${title}` };
    }
    // 图片生成：返回图片 data URL（由 useAiStream 追加为图片消息）
    if (call.tool === 'generate_image') {
      const prompt = String(call.args.prompt ?? '').trim();
      if (!prompt) return { text: '（画图请求缺少描述，未执行）' };
      try {
        const dataUrl = await invoke<string>('ai_generate_image', { prompt });
        return { text: '已画好：' + prompt, imageUrl: dataUrl };
      } catch (e) {
        return { text: `画图失败：${String(e).slice(0, 80)}` };
      }
    }
    const kindMap: Record<string, 'calendar' | 'todo' | 'reminder'> = {
      create_calendar: 'calendar',
      create_todo: 'todo',
      create_reminder: 'reminder',
    };
    const kind = kindMap[call.tool];
    if (!kind) return { text: `（未知工具 ${call.tool}，未执行）` };
    const title = String(call.args.title ?? '').trim();
    if (!title) return { text: '（工具调用缺少标题，未执行）' };
    const time = String(call.args.time ?? '').trim();
    const note = String(call.args.note ?? '').trim();
    const ts = parseTimeToMs(time);

    // 系统级能力（Android 真机）：写入系统日历（静默，不打扰）
    const w = window as unknown as {
      AndroidCalendar?: {
        createCalendarEvent?: (title: string, timeMs: string, note: string) => boolean;
        createCalendarTodo?: (title: string, timeMs: string, note: string) => boolean;
        createCalendarReminder?: (title: string, timeMs: string, note: string) => boolean;
      };
    };
    const sys = w.AndroidCalendar;
    let sysOk = false;
    let sysErr = '';
    if (sys && ts) {
      try {
        if (kind === 'calendar') sysOk = !!sys.createCalendarEvent?.(title, String(ts), note);
        else if (kind === 'todo') sysOk = !!sys.createCalendarTodo?.(title, String(ts), note);
        else if (kind === 'reminder') sysOk = !!sys.createCalendarReminder?.(title, String(ts), note);
        if (!sysOk) sysErr = '（可能未授权日历权限，请在系统设置中允许）';
      } catch { sysErr = '（写入系统日历失败）'; }
    }

    try {
      await invoke('agent_tool_create', {
        kind,
        title,
        time,
        note,
      });
      const d = await invoke<AgentData>('agent_tools_get');
      set({ data: d });
      const label = { calendar: '日历事件', todo: '待办', reminder: '提醒' }[kind];
      const sysText = sys && ts ? (sysOk ? '已同步到系统日历' : sysErr) : '';
      return { text: `已创建${label}：${title}${sysText ? ' · ' + sysText : ''}` };
    } catch {
      return { text: `已收到请求（浏览器预览模式，${title} 未持久化）` };
    }
  },

  deleteRecord: async (kind, id) => {
    try {
      const d = await invoke<AgentData>('agent_tool_delete', { kind, id });
      set({ data: d });
    } catch {
      const key = kind === 'calendar' ? 'calendar' : kind === 'todo' ? 'todos' : 'reminders';
      set({ data: { ...get().data, [key]: get().data[key].filter((r) => r.id !== id) } });
    }
  },
}));
