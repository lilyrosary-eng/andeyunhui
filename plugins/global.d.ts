/// <reference types="vite/client" />

/** 帧缓冲工具类型 */
interface FrameBuffer<T> {
  push: (item: T) => void;
  flush: () => void;
  destroy: () => void;
}

/** 插件全局类型声明 — 所有插件共享 */
declare global {
  interface Window {
    __HOST_REACT__: typeof import('react');
    __HOST_REACT_DOM__: typeof import('react-dom/client');
    __HOST_API__: {
      invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      convertFileSrc: (filePath: string) => string;
      listen: <T = unknown>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
      emit: (event: string, payload?: unknown) => Promise<void>;
      createFrameBuffer: <T>(onFlush: (items: T[]) => void) => FrameBuffer<T>;
      createFloatingWindow: (label: string, url: string, options: Record<string, unknown>) => Promise<void>;
    };
    __PLUGIN_REGISTRY__: {
      register: (def: {
        id: string;
        name: string;
        iconName: string;
        kind: 'module' | 'service';
        visible: boolean;
        component: React.ComponentType;
        sidebar?: React.ComponentType;
        settings?: React.ComponentType;
        parent?: string;
        category?: string;
        desc?: string;
        destroy?: () => void;
      }) => void;
    };
    __HOST_UI__: Record<string, React.ComponentType<Record<string, unknown>>>;
    __MUSIC_PLAYER__?: {
      getCurrentTrack: () => { filePath: string } | null;
    };
  }
}

export {};
