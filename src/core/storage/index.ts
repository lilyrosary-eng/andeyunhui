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
      try { backend.setItem(key, value); } catch { /* 静默，等价现状 catch {} */ }
    },
    getJSON<T>(key: string, fallback: T): T {
      try {
        const v = backend.getItem(key);
        if (v == null) return fallback;
        return JSON.parse(v) as T;
      } catch { return fallback; }
    },
    setJSON(key, value) {
      try { backend.setItem(key, JSON.stringify(value)); } catch { /* 静默 */ }
    },
    remove(key) {
      try { backend.removeItem(key); } catch { /* 静默 */ }
    },
  };
}

const domBackend: StorageBackend = {
  getItem: (k) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(k)),
  setItem: (k, v) => { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); },
  removeItem: (k) => { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); },
};

/** 默认实例：绑定真实 localStorage，无环境时读写安全回退。 */
export const storage: Storage = createStorage(domBackend);