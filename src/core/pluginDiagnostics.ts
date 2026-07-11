// 插件诊断信息收集器 — 发布订阅模式，供 React 组件监听
// 替代纯 console.warn，让诊断信息能在 UI 中展示

export interface DiagnosticEntry {
  pluginId: string;
  stage: 'scan' | 'version' | 'load' | 'register' | 'conflict' | 'runtime';
  reason: string;
  timestamp: number;
}

type Listener = () => void;

class PluginDiagnostics {
  private entries: DiagnosticEntry[] = [];
  private listeners = new Set<Listener>();
  /** 缓存快照，避免每次 getAll() 返回新引用导致 useSyncExternalStore 无限循环 */
  private snapshot: DiagnosticEntry[] = [];

  addEntry(entry: DiagnosticEntry): void {
    this.entries.push(entry);
    this.snapshot = [...this.entries];
    this.listeners.forEach(fn => fn());
  }

  /** 返回稳定引用：仅在数据变更时生成新数组 */
  getSnapshot(): DiagnosticEntry[] {
    return this.snapshot;
  }

  subscribe(callback: Listener): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }
}

// 全局单例
export const pluginDiagnostics = new PluginDiagnostics();