export interface StorageBackend {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface Storage {
  getString(key: string, fallback: string): string;
  setString(key: string, value: string): void;
  getJSON<T>(key: string, fallback: T): T;
  setJSON<T>(key: string, value: T): void;
  remove(key: string): void;
}

export function createStorage(backend: StorageBackend): Storage {
  return {
    getString(key, fallback) {
      try { const v = backend.getItem(key); return v != null ? v : fallback; }
      catch { return fallback; }
    },
    setString(key, value) {
      try { backend.setItem(key, value); } catch (e) {
        console.error(`[storage] 写入失败（可能是配额已满）key=${key}`, e);
        notifyWriteFailure(key, e);
      }
    },
    getJSON<T>(key: string, fallback: T): T {
      try {
        const v = backend.getItem(key);
        if (v == null) return fallback;
        return JSON.parse(v) as T;
      } catch { return fallback; }
    },
    setJSON(key, value) {
      try {
        backend.setItem(key, JSON.stringify(value));
      } catch (e) {
        // ⚠️ 不吞掉失败：localStorage 写失败几乎只有一种原因——**配额爆了**。
        // 静默的代价极隐蔽：用户看到的是「历史记录莫名丢失」（丢的是整个会话），
        // 而现场没有任何线索。这里至少留下可排查的痕迹，并给出一次可见的告警。
        console.error(`[storage] 写入失败（可能是配额已满）key=${key}`, e);
        notifyWriteFailure(key, e);
      }
    },
    remove(key) {
      try { backend.removeItem(key); } catch { /* 静默 */ }
    },
  };
}

/**
 * 写入失败处理器（由应用层注入）。
 *
 * storage 是底层模块，不该直接依赖 UI，所以只暴露一个注入点；
 * 应用启动时注册一次，就能把「配额已满」变成用户可见的一次告警。
 * 未注册时只在控制台留痕，绝不静默。
 */
let onWriteFailure: ((key: string, err: unknown) => void) | undefined;

/** 注册写入失败处理器（应用启动时调用一次）。 */
export function setStorageWriteFailureHandler(fn: (key: string, err: unknown) => void): void {
  onWriteFailure = fn;
}

function notifyWriteFailure(key: string, err: unknown): void {
  try {
    onWriteFailure?.(key, err);
  } catch {
    // 通知本身失败不能再抛——否则会盖住「写入失败」这个原始错误
  }
}

const domBackend: StorageBackend = {
  getItem: (k) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(k)),
  setItem: (k, v) => { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); },
  removeItem: (k) => { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); },
};

/** 默认实例：绑定真实 localStorage，无环境时读写安全回退。 */
export const storage: Storage = createStorage(domBackend);