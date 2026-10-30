// 导轨刻度上的「读者标记」：普通标记（琥珀点）与重点标记（品红菱形）。
//
// 对齐 dsh 的 turn-marks，并补上本项目的跨窗口同步：
// - 主窗口/浮岛是两个独立 webview，localStorage 互相隔离；
// - 后端 `turn_marks.json` 是跨窗口事实源（首次挂载时拉取）；
// - 每次改动同时发 Tauri 事件 `turn-marks-changed`，其它窗口实时应用。
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type TurnMark = 'mark' | 'star';

const STORAGE_PREFIX = 'andeyunhui.chat.turnMarks.v1.';
const EVENT_NAME = 'turn-marks-changed';

interface StoredMarks {
  v: 1;
  marks: Record<string, TurnMark>;
}

interface TurnMarkChange {
  scope: string;
  id: string;
  mark: TurnMark | null;
  source: string;
}

function readMark(value: unknown): TurnMark | undefined {
  return value === 'mark' || value === 'star' ? value : undefined;
}

class TurnMarkStore {
  private readonly byScope = new Map<string, Map<string, TurnMark>>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(scope: string, id: string): TurnMark | undefined {
    return this.scope(scope).get(id);
  }

  /** 当前 scope 的完整快照（用于首次同步/迁移）。 */
  snapshot(scope: string): Map<string, TurnMark> {
    return new Map(this.scope(scope));
  }

  /**
   * 设置/清除一条标记。
   *
   * 三条写路径：
   *   1. 内存 + 本窗口 localStorage（即时渲染）；
   *   2. 后端 JSON（跨窗口/跨重启事实源）；
   *   3. Tauri 事件（其它窗口立即应用，无需等下次挂载）。
   */
  set(scope: string, id: string, mark: TurnMark | null): void {
    const marks = this.scope(scope);
    const current = marks.get(id);
    if (mark === null) {
      if (current === undefined) return;
      marks.delete(id);
    } else {
      if (current === mark) return;
      marks.set(id, mark);
    }
    this.persist(scope, marks);
    this.publish();

    ensureSync();
    void invoke('turn_marks_put', { scope, id, mark: mark ?? null }).catch(() => {});
    void emit(EVENT_NAME, { scope, id, mark: mark ?? null, source: myLabel }).catch(() => {});
  }

  /** 应用其它窗口推来的变更（不再回写后端/事件）。 */
  applyRemote(scope: string, id: string, mark: TurnMark | null): void {
    const marks = this.scope(scope);
    const current = marks.get(id);
    if (mark === null) {
      if (current === undefined) return;
      marks.delete(id);
    } else {
      if (current === mark) return;
      marks.set(id, mark);
    }
    this.persist(scope, marks);
    this.publish();
  }

  /** 用后端快照替换一个 scope（首次加载/重新聚焦时）。 */
  replaceScope(scope: string, marks: Map<string, TurnMark>): void {
    this.byScope.set(scope, new Map(marks));
    this.persist(scope, marks);
    this.publish();
  }

  private scope(scope: string): Map<string, TurnMark> {
    const cached = this.byScope.get(scope);
    if (cached !== undefined) return cached;
    const marks = this.hydrate(scope);
    this.byScope.set(scope, marks);
    return marks;
  }

  private hydrate(scope: string): Map<string, TurnMark> {
    const marks = new Map<string, TurnMark>();
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_PREFIX + scope);
    } catch {
      return marks;
    }
    if (!raw) return marks;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return marks;
    }
    if (typeof parsed !== 'object' || parsed === null) return marks;
    const stored = parsed as StoredMarks;
    if (stored.v !== 1 || typeof stored.marks !== 'object' || stored.marks === null) return marks;
    for (const [id, value] of Object.entries(stored.marks)) {
      const mark = readMark(value);
      if (mark) marks.set(id, mark);
    }
    return marks;
  }

  private persist(scope: string, marks: ReadonlyMap<string, TurnMark>): void {
    const payload: StoredMarks = { v: 1, marks: Object.fromEntries(marks) };
    try {
      localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(payload));
    } catch {
      // 配额/隐私模式：内存标记仍可用
    }
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const turnMarks = new TurnMarkStore();

let syncStarted = false;
let myLabel = '';

function ensureSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  try {
    myLabel = getCurrentWebviewWindow().label;
  } catch {
    myLabel = '';
  }
  void listen<TurnMarkChange>(EVENT_NAME, (event) => {
    const change = event.payload;
    if (!change || change.source === myLabel) return;
    turnMarks.applyRemote(change.scope, change.id, change.mark);
  }).catch(() => {});
}

/**
 * 首次挂载某个 scope 的导轨时调用：从后端拉取跨窗口事实源。
 *
 * - 后端有数据 → 以后端为准替换本地（避免离线期间被别的窗口取消的标记复活）；
 * - 后端为空、本地有数据 → 把本地迁移到后端（兼容这次改动之前的旧标记）。
 */
export function syncTurnMarks(scope: string): void {
  ensureSync();
  void (async () => {
    try {
      const remoteRaw = await invoke<Record<string, unknown>>('turn_marks_get', { scope });
      const remote = new Map<string, TurnMark>();
      for (const [id, value] of Object.entries(remoteRaw || {})) {
        const mark = readMark(value);
        if (mark) remote.set(id, mark);
      }
      const local = turnMarks.snapshot(scope);
      if (remote.size === 0 && local.size > 0) {
        for (const [id, mark] of local) {
          void invoke('turn_marks_put', { scope, id, mark }).catch(() => {});
        }
        return;
      }
      turnMarks.replaceScope(scope, remote);
    } catch {
      // 后端不可用（浏览器预览/旧版）：保留本地 localStorage 行为
    }
  })();
}
