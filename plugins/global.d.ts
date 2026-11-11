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

  /** 右键菜单命中目标的纯数据描述（宿主探测 DOM 后给出，插件拿不到 DOM 节点） */
  interface ContextMenuTargetInfo {
    /** 命中元素（或其可交互祖先）的标签名，大写 */
    tag: string;
    editable: boolean;
    readOnly: boolean;
    linkHref: string | null;
    imageSrc: string | null;
    /** 当前选区文本（已 trim） */
    selectionText: string;
    /** 当前模块 id */
    moduleId: string | null;
  }

  /** 插件贡献的右键菜单条目 */
  interface ContextMenuItem {
    label: string;
    /** 快捷键提示，仅展示 */
    hint?: string;
    variant?: 'default' | 'destructive';
    disabled?: boolean;
    /** 与上一项之间插入分隔线 */
    separatorBefore?: boolean;
    run?: () => void | Promise<void>;
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
      /**
       * 生成宿主深链（`andy-nav:///…`）：把导航目标变成一条能写进正文、明天还能点的 URL。
       * 与 navigate 的分工：navigate 是一次性动作，深链是可持久化的文本。
       */
      buildDeepLink?: (target: NavigationTarget) => string;
      /**
       * 注册本模块的右键菜单条目。宿主统一决定何时弹出与排序，
       * 不给 moduleId 时默认只在本模块激活时生效。
       */
      registerContextMenuProvider?: (provider: {
        id: string;
        moduleId?: string;
        /** 越大越靠前 */
        priority?: number;
        build: (target: ContextMenuTargetInfo) => ContextMenuItem[] | Promise<ContextMenuItem[]>;
      }) => () => void;
      /**
       * 全站唯一的模糊打分（宿主 src/lib/fuzzy.ts，Obsidian cx() 移植）。
       * 返回值 > 0 为命中（越大越靠前），< 0 为不匹配。
       * 模块自己的搜索框/过滤列表一律用它，别再留一份本地实现，
       * 否则同一个查询在命令面板里和在模块里排序不一样。
       */
      fuzzyScore: (query: string, target: string) => number;
      /** 预绑定查询的打分器：一次切分、对一批候选反复打分（provider 遍历大列表时用这个） */
      makeScorer: (query: string) => (target: string) => number;
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
        /** 用户可见的花名（侧栏标题 / 命令面板）；缺省回退 name，不影响 id 与加载 */
        displayName?: string;
        /** 花名的悬停文案；缺省按「花名 · 功能名」拼装 */
        displayTooltip?: string;
        /** 卸载/重载前调用；reason='reload' 为热重载，'shutdown' 为用户禁用/删除 */
        destroy?: (reason?: 'reload' | 'shutdown') => void;
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
        /** 用户可见的花名（侧栏标题 / 命令面板）；缺省回退 name，不影响 id 与加载 */
        displayName?: string;
        /** 花名的悬停文案；缺省按「花名 · 功能名」拼装 */
        displayTooltip?: string;
        /** 卸载/重载前调用；reason='reload' 为热重载，'shutdown' 为用户禁用/删除 */
        destroy?: (reason?: 'reload' | 'shutdown') => void;
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
        /** 用户可见的花名（侧栏标题 / 命令面板）；缺省回退 name，不影响 id 与加载 */
        displayName?: string;
        /** 花名的悬停文案；缺省按「花名 · 功能名」拼装 */
        displayTooltip?: string;
        /** 卸载/重载前调用；reason='reload' 为热重载，'shutdown' 为用户禁用/删除 */
        destroy?: (reason?: 'reload' | 'shutdown') => void;
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
        /** 用户可见的花名（侧栏标题 / 命令面板）；缺省回退 name，不影响 id 与加载 */
        displayName?: string;
        /** 花名的悬停文案；缺省按「花名 · 功能名」拼装 */
        displayTooltip?: string;
        /** 卸载/重载前调用；reason='reload' 为热重载，'shutdown' 为用户禁用/删除 */
        destroy?: (reason?: 'reload' | 'shutdown') => void;
      }[];
      unregister: (id: string) => void;
      setVisible: (id: string, visible: boolean) => boolean;
      /** 长生命周期资源共享槽：跨插件热重载保留（如音乐播放内核） */
      getSharedSlot: <T = unknown>(key: string) => T | undefined;
      setSharedSlot: (key: string, value: unknown) => void;
      deleteSharedSlot: (key: string) => void;
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
