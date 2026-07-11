import { ComponentType } from 'react';
import { logger } from '@/lib/logger';

// 宿主 API 版本号：插件 manifest 中 hostApiVersion 与此一致才允许加载
export const HOST_API_VERSION = 1;

// 插件定义（由插件自身调用 register() 时提供）
export interface PluginDef {
  id: string;
  name: string;
  iconName: string;
  kind: 'module' | 'service';
  visible?: boolean;       // 默认 true，控制是否出现在导航栏
  component: ComponentType<any>;
  sidebar?: ComponentType<any>;
  settings?: ComponentType<any>;
  // 子插件：归属的父模块 id（如 'niuluo' / 'professional'）。
  // 设置后该插件不再作为顶层模块出现在导航栏 / 茑萝列表，
  // 而是嵌套在其父模块内部（如薄荷的 16 个功能、茑萝下的工具箱）。
  parent?: string;
  // 子插件分组 / 描述（供父模块 UI 渲染时使用）
  category?: string;
  desc?: string;
  // 生命周期钩子：插件卸载/重载前调用，用于释放 audio、定时器、事件监听等资源。
  // 不抛错时由 PluginHost 在 unregister 前调用。
  destroy?: () => void;
}

// 插件注册器：插件调用 register() 注册自己，宿主通过 getAll() / get() 查询
export class PluginRegistry {
  private plugins: Record<string, PluginDef> = {};

  register(def: PluginDef): void {
    // id 重复检测
    if (this.plugins[def.id]) {
      logger.plugins.registryDuplicate(def.id);
      return;
    }
    this.plugins[def.id] = {
      ...def,
      visible: def.visible ?? true,  // 默认可见
    };
    // 触发自定义事件，通知宿主 UI 更新
    window.dispatchEvent(new CustomEvent('plugin-registered', { detail: def }));
  }

  getAll(): PluginDef[] {
    return Object.values(this.plugins);
  }

  get(id: string): PluginDef | undefined {
    return this.plugins[id];
  }

  /** 获取某父模块下的全部子插件（按注册顺序） */
  getChildren(parentId: string): PluginDef[] {
    return Object.values(this.plugins).filter(p => p.parent === parentId);
  }

  /** 清除指定 id 的注册（用于插件自注册校验失败时清理） */
  unregister(id: string): void {
    delete this.plugins[id];
  }

  /** 切换插件可见性（动态显示/隐藏，不销毁组件） */
  setVisible(id: string, visible: boolean): boolean {
    const plugin = this.plugins[id];
    if (!plugin) return false;
    plugin.visible = visible;
    window.dispatchEvent(new CustomEvent('plugin-visibility-changed', { detail: { id, visible } }));
    return true;
  }
}

// 暴露给插件的宿主 API
export interface HostAPI {
  invoke: typeof import('@tauri-apps/api/core').invoke;
  convertFileSrc: typeof import('@tauri-apps/api/core').convertFileSrc;
  listen: typeof import('@tauri-apps/api/event').listen;
}