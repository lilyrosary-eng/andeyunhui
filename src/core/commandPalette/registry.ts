// 命令面板的模块级 provider 注册表
//
// 宿主内置的模块/动作/笔记由面板自己产出；各业务模块（音乐、阅读、AI 会话…）
// 通过 registerCommandProvider 注册自己的实体搜索与执行能力，面板只负责展示与排序。
// 这样“搜索一首歌”会落到音乐模块的能力上，而不是打开文件资源管理器。
export interface PaletteProviderResult {
  id: string;
  title: string;
  /** 追加说明（歌手/专辑等） */
  subtitle?: string;
  /** 层级路径，例如 ['歌单名']；面板会渲染成 音乐 › 歌单名 › 歌曲 */
  path?: string[];
  /** 注册表里的图标名（PluginIcon 使用） */
  iconName?: string;
  run: () => void | Promise<void>;
}

export interface PaletteProvider {
  id: string;
  label: string;
  /** 执行结果前先切换到的模块 id（缺省为 provider.id） */
  moduleId?: string;
  search: (query: string) => PaletteProviderResult[] | Promise<PaletteProviderResult[]>;
}

const providers = new Map<string, PaletteProvider>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 注册 provider；重复 id 覆盖旧实现。返回注销函数。 */
export function registerCommandProvider(provider: PaletteProvider): () => void {
  if (!provider || typeof provider.id !== 'string' || typeof provider.label !== 'string' || typeof provider.search !== 'function') {
    throw new Error('registerCommandProvider: 需要 { id, label, search }');
  }
  providers.set(provider.id, provider);
  notify();
  return () => {
    if (providers.get(provider.id) === provider) {
      providers.delete(provider.id);
      notify();
    }
  };
}

export function getCommandProviders(): PaletteProvider[] {
  return [...providers.values()];
}

export function subscribeCommandProviders(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
