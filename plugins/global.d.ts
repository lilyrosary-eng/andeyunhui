/// <reference types="vite/client" />

/** 帧缓冲工具类型 */
interface FrameBuffer<T> {
  push: (item: T) => void;
  flush: () => void;
  destroy: () => void;
}

/** 插件全局类型声明 — 所有插件共享 */
declare global {
  /** 跨模块导航目标 */
  interface NavigationTarget {
    module: string;
    /** 层级路径：一级 tab → 二级 sub tab */
    tabs?: string[];
    /** 末级实体 id（歌曲、书籍路径、会话 id…） */
    entity?: string;
    /** 模块自定义参数 */
    props?: Record<string, unknown>;
  }

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
      registerCommandProvider?: (provider: {
        id: string;
        label: string;
        moduleId?: string;
        /** 同组排序权重，越大越靠前（可选） */
        priority?: number;
        /** 面板打开时刷新快照（可选，自行节流） */
        refresh?: () => void | Promise<void>;
        search: (query: string) => Array<{
          id: string;
          title: string;
          subtitle?: string;
          path?: string[];
          iconName?: string;
          rank?: number;
          navigate?: NavigationTarget;
          run?: () => void | Promise<void>;
        }> | Promise<Array<{
          id: string;
          title: string;
          subtitle?: string;
          path?: string[];
          iconName?: string;
          rank?: number;
          navigate?: NavigationTarget;
          run?: () => void | Promise<void>;
        }>>;
      }) => () => void;
      /** 注册本模块的导航处理器（命令面板/其它模块跳转时调用） */
      registerNavigator?: (handler: (target: NavigationTarget) => boolean | void | Promise<boolean | void>) => () => void;
      /** 跳到任意模块的 tab / 实体 */
      navigate?: (target: NavigationTarget) => Promise<boolean>;
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
        codename?: string;
        destroy?: () => void;
      }) => void;
      get: (id: string) => {
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
        codename?: string;
        destroy?: () => void;
      } | undefined;
      getAll: () => {
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
        codename?: string;
        destroy?: () => void;
      }[];
      getChildren: (parentId: string) => {
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
        codename?: string;
        destroy?: () => void;
      }[];
      unregister: (id: string) => void;
      setVisible: (id: string, visible: boolean) => boolean;
    };
    __HOST_UI__: Record<string, React.ComponentType<Record<string, unknown>>>;
    __HOST_I18N__: {
      /** 全局翻译函数（读取宿主当前语言，支持 {var} 插值） */
      t: (key: string, vars?: Record<string, string | number>) => string;
      /** 指定语言翻译 */
      translate: (lang: string, key: string, vars?: Record<string, string | number>) => string;
      /** 当前语言 */
      getLanguage: () => string;
      /** 语言选项 */
      LANGUAGES: { code: string; label: string }[];
    };
    __MUSIC_PLAYER__?: {
      getCurrentTrack: () => { filePath: string } | null;
    };
  }
}

export {};
