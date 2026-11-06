// 应用自己的右键菜单 —— 本文件只负责「给定上下文，该显示哪些项」的判断。
//
// 为什么切成纯函数：这些判据（什么时候出粘贴、什么时候不给另存）最容易写错，
// 又最难靠肉眼发现；DOM 探测与真正执行留在组件侧。插件 provider 同样只拿到纯数据描述
// —— 不能把 DOM 节点递进沙箱，否则等于把整棵主文档暴露给插件代码。

/** 右键命中目标的纯数据描述（不含任何 DOM 引用） */
export interface ContextMenuTargetInfo {
  /** 命中元素（或其可交互祖先）的标签名，大写，如 A / IMG / TEXTAREA / DIV */
  tag: string;
  /** 是否落在可编辑区（input / textarea / contenteditable） */
  editable: boolean;
  /** 可编辑区是否只读（只读时不给剪切、粘贴） */
  readOnly: boolean;
  /** 最近锚点的 href */
  linkHref: string | null;
  /** 命中图片时的 src */
  imageSrc: string | null;
  /** 当前选区文本（已 trim，空则无选区） */
  selectionText: string;
  /** 当前模块 id（宿主内置模块用 notes / transfer / settings） */
  moduleId: string | null;
}

/** 内置项的出现判据 */
export interface ContextMenuBuiltins {
  copy: boolean;
  cut: boolean;
  paste: boolean;
  selectAll: boolean;
  openLink: boolean;
  copyLink: boolean;
  copyImage: boolean;
  saveImage: boolean;
}

/** 可执行协议：只有这些 href 才提供「打开」（javascript: 等一律不给，防手滑执行） */
const OPENABLE_HREF = /^(https?:|mailto:|andy-nav:)/i;
/** 可另存的图片源：只有远程地址需要下载。asset:/data: 要么本来就在盘上、要么后端不吃 */
const SAVEABLE_IMAGE = /^https?:/i;

export function builtinFlags(target: ContextMenuTargetInfo): ContextMenuBuiltins {
  const hasSelection = !!target.selectionText;
  const canEdit = target.editable && !target.readOnly;
  const href = target.linkHref;
  const image = target.imageSrc;
  return {
    // 没选区的「复制」只会复制出空字符串，宁可不给
    copy: hasSelection,
    cut: hasSelection && canEdit,
    paste: canEdit,
    selectAll: canEdit || target.editable,
    openLink: !!href && OPENABLE_HREF.test(href),
    copyLink: !!href,
    copyImage: !!image,
    saveImage: !!image && SAVEABLE_IMAGE.test(image),
  };
}

export interface ContextMenuItem {
  id: string;
  /** 已翻译好的文案（宿主 provider 用 t()，插件用 T()） */
  label: string;
  /** 快捷键提示，仅展示，不接管按键 */
  hint?: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  /** 与上一项之间插入分隔线 */
  separatorBefore?: boolean;
  /** 执行动作；不给就是只读展示项 */
  run?: () => void | Promise<void>;
}

export interface ContextMenuProvider {
  /** 全局唯一 id（插件侧由沙箱自动加插件前缀） */
  id: string;
  /** 限定生效模块；不给则全局生效 */
  moduleId?: string;
  /** 越大越靠前 */
  priority?: number;
  build: (target: ContextMenuTargetInfo) => ContextMenuItem[] | Promise<ContextMenuItem[]>;
}

type Listener = () => void;

const providers = new Map<string, ContextMenuProvider>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* 订阅方出错不影响注册表 */ }
  }
}

/** 注册 provider；同 id 覆盖（组件重挂时以最新闭包为准）。返回注销函数。 */
export function registerContextMenuProvider(provider: ContextMenuProvider): () => void {
  if (!provider || typeof provider.id !== 'string' || !provider.id || typeof provider.build !== 'function') {
    throw new Error('registerContextMenuProvider: 需要 { id, build }');
  }
  providers.set(provider.id, provider);
  notify();
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
    notify();
  };
}

/** 订阅注册表变化（菜单打开期间 provider 增删时用来重算） */
export function subscribeContextMenu(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 本模块可见的 provider（同步筛，避免为了判空去 await） */
export function visibleProviders(moduleId: string | null): ContextMenuProvider[] {
  return [...providers.values()]
    .filter((p) => !p.moduleId || p.moduleId === moduleId)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
}

/**
 * 收集 provider 条目。任一 provider 抛错只丢它自己的条目并在控制台说明 ——
 * 一个模块写崩不该让整个右键菜单消失。
 */
export async function collectProviderItems(
  target: ContextMenuTargetInfo,
  list = visibleProviders(target.moduleId),
): Promise<ContextMenuItem[]> {
  const out: ContextMenuItem[] = [];
  for (const provider of list) {
    try {
      const items = await provider.build(target);
      if (Array.isArray(items)) out.push(...items);
    } catch (err) {
      console.warn('[context-menu] provider 构建条目失败:', provider.id, err);
    }
  }
  return out;
}
