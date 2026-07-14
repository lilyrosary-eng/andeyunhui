import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { PluginHost, PluginErrorBoundary } from '@/core/PluginHost';
import { GlobalSettingsPanel } from '@/core/settings/GlobalSettingsPanel';
import { ExtensionsHub } from '@/core/extensions/ExtensionsHub';
import { NotesModule } from '@/core/notes/NotesModule';
import { TransferStationPanel, emitDropzoneChange } from '@/components/TransferStationPanel';
import { Titlebar } from '@/components/Titlebar';
import { AppNav } from '@/components/AppNav';
import { HostSidebar } from '@/components/HostSidebar';
import { logger } from '@/lib/logger';
import { api } from '@/lib/api';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '@/stores/appStore';
import { useNotesStore } from '@/stores/notesStore';
import { clearStaleBootPreview } from '@/lib/bootPreview';

function App() {
  // ====== store 订阅 ======
  const pluginRegistry = useAppStore(s => s.pluginRegistry);
  const visibilityTick = useAppStore(s => s.visibilityTick);
  const activeModule = useAppStore(s => s.activeModule);
  const showExtensionSettings = useAppStore(s => s.showExtensionSettings);
  const setPluginRegistry = useAppStore(s => s.setPluginRegistry);
  const bumpVisibility = useAppStore(s => s.bumpVisibility);
  const setActiveModule = useAppStore(s => s.setActiveModule);
  const initFloatingListeners = useAppStore(s => s.initFloatingNoteListeners);
  const openExternalContent = useNotesStore(s => s.openExternalContent);
  const initNotes = useNotesStore(s => s.init);

  // 热重载生效：当前活动模块被重新注册时，强制重挂其组件（画布重新初始化，给出可见反馈）
  const [activeReloadKey, setActiveReloadKey] = useState(0);

  // ====== 微信式截图 ======
  // 不隐藏主窗口：软件运行（含最小化/托盘）时随时可截图；主窗口可见时会被截入画面
  // （已在 UI 层说明取舍）。截图覆盖窗口在 setup 预创建并复用，避免卡顿。
  const startScreenshot = useCallback(async () => {
    try {
      // 记录当前笔记页 id（非阻塞：与截图启动并行，减少一次 IPC 往返延迟）
      const noteId = useNotesStore.getState().currentNoteId ?? '';
      invoke('store_screenshot_note_id', { noteId }).catch(() => {});
      // 立即启动截图捕获（不等 note_id 存储）
      await invoke('start_screenshot');
    } catch (e) {
      // 失败时给出可见提示（而非「按了毫无反应」），并复位覆盖窗状态避免卡死
      console.error('[截图] 启动失败:', e);
      const msg = typeof e === 'string' ? e : (e as { message?: string })?.message || '截图启动失败';
      try { await invoke('hide_overlay_window'); } catch { /* ignore */ }
      let tip = document.getElementById('screenshot-err-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'screenshot-err-tip';
        tip.style.cssText =
          'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;' +
          'background:rgba(220,38,38,.95);color:#fff;padding:8px 14px;border-radius:8px;' +
          'font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:80vw;';
        document.body.appendChild(tip);
      }
      tip.textContent = '截图失败：' + msg;
      window.setTimeout(() => tip?.remove(), 4000);
    }
  }, []);

  // 系统级热键 Ctrl+Shift+S（Rust globalShortcut，应用失焦也能触发）
  // Rust 侧派发 `open-screenshot` 事件到当前窗口
  useEffect(() => {
    const un = listen<null>('open-screenshot', () => { void startScreenshot(); });
    return () => { void un.then((fn) => fn()); };
  }, [startScreenshot]);

  // 截图保存后：若触发时正处于某篇笔记页，由覆盖窗口转发事件，在此追加图片到该笔记
  useEffect(() => {
    const un = listen<{ ref: string; name: string; noteId: string }>('screenshot-note-import', (e) => {
      const { ref, name, noteId } = e.payload;
      const st = useNotesStore.getState();
      if (st.currentNoteId && st.currentNoteId === noteId && st.setContent) {
        st.setContent(`${st.content}\n\n![${name}](${ref})\n`);
      }
    });
    return () => { void un.then((fn) => fn()); };
  }, []);

  // ====== 派生数据 ======
  const mainPluginIds = useMemo(() => {
    if (!pluginRegistry) return [] as string[];
    return pluginRegistry.getAll()
      .filter((p: { kind: string; visible?: boolean; id: string }) => p.kind === 'module' && p.visible !== false)
      .map((p: { id: string }) => p.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibilityTick 是计数器，用于强制重算（插件可见性变化时递增）
  }, [pluginRegistry, visibilityTick]);

  const subPluginIds = useMemo(() => {
    if (!pluginRegistry) return [] as string[];
    return pluginRegistry.getAll()
      .filter((p: { kind: string; parent?: string }) => p.kind === 'module' && p.parent)
      .map((p: { id: string }) => p.id);
  }, [pluginRegistry]);

  const validModuleIds = useMemo(() => {
    const ids = new Set(['notes', 'extensions', 'settings', 'transfer']);
    mainPluginIds.forEach(id => ids.add(id));
    subPluginIds.forEach(id => ids.add(id));
    return ids;
  }, [mainPluginIds, subPluginIds]);

  // ====== refs ======
  const activeModuleRef = useRef(activeModule);
  useEffect(() => { activeModuleRef.current = activeModule; }, [activeModule]);

  // 挂载即清理可能残留的预览覆盖层（旧版本返回按钮失灵时卡住的全屏层会挡住所有点击）
  useEffect(() => { clearStaleBootPreview(); }, []);

  // ====== 全局 effect ======
  // 初始化（「加载页优先」：推后到哥特加载动画稳态之后）
  // 不立即同步跑笔记初始化 + 浮窗监听——否则会与 React 挂载、插件加载在启动头几秒抢占主线程，
  // 导致哥特加载页动画掉帧（用户 Issue 4）。延迟 ~1.2s 后执行，此时加载页已流畅播放、且仍盖在上方。
  const initCleanupRef = useRef<() => void>(() => {});
  useEffect(() => {
    const t = window.setTimeout(() => {
      initNotes();
      initCleanupRef.current = initFloatingListeners() || (() => {});
    }, 1200);
    return () => {
      window.clearTimeout(t);
      initCleanupRef.current();
    };
  }, [initNotes, initFloatingListeners]);

  // 插件可见性变化
  useEffect(() => {
    const handler = () => bumpVisibility();
    window.addEventListener('plugin-visibility-changed', handler);
    return () => window.removeEventListener('plugin-visibility-changed', handler);
  }, [bumpVisibility]);

  // 热重载生效：活动模块被重新注册时，递增 key 以重挂组件（画布重初始化=可见反馈）
  useEffect(() => {
    const onReg = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      if (detail && detail.id === activeModule) {
        setActiveReloadKey((k) => k + 1);
      }
    };
    window.addEventListener('plugin-registered', onReg as EventListener);
    return () => window.removeEventListener('plugin-registered', onReg as EventListener);
  }, [activeModule]);

  // 热插拔：重载/卸载插件后，强制重算已加载模块列表并刷新当前活动模块视图
  useEffect(() => {
    const bump = () => bumpVisibility();
    window.addEventListener('plugin-registered', bump);
    window.addEventListener('plugin-unregistered', bump);
    return () => {
      window.removeEventListener('plugin-registered', bump);
      window.removeEventListener('plugin-unregistered', bump);
    };
  }, [bumpVisibility]);

  // activeModule 兜底
  useEffect(() => {
    if (pluginRegistry && !validModuleIds.has(activeModule)) {
      logger.app.fallbackModule(activeModule);
      setActiveModule('notes');
    }
  }, [pluginRegistry, validModuleIds, activeModule, setActiveModule]);

  // 文件拖入（HTML5 拖放）：dragDropEnabled 已关闭，由 webview 原生处理拖放事件，
  // 这样「拖出」也能通过 dataTransfer.items.add(File) 正常工作（否则会显示禁止符号）。
  // 非笔记模块：把文件导入图标栏中转站（并可打开可读文本）；
  // 笔记模块：交给 NotesEditor 自身的 onDrop（可定位光标）处理，此处不重复处理。
  const openExternalContentRef = useRef(openExternalContent);
  useEffect(() => {
    openExternalContentRef.current = openExternalContent;
  }, [openExternalContent]);
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // 仅当拖拽内容含文件时允许放下（否则 Explorer 会显示禁止符号）
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = async (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      // 应用内原生拖出（中转站行按下拖出）拖回应用内时不重复导入
      if ((window as unknown as Record<string, unknown>).__andengDragging) {
        e.preventDefault();
        return;
      }
      // 应用内拖出的文件（如从中转站拖来）拖回应用内时不要重复导入，否则会一直复制
      if (Array.from(dt.types).includes('application/x-andeng-internal')) {
        e.preventDefault();
        return;
      }
      if (dt.files.length === 0) return;
      // 始终阻止浏览器默认行为（否则落在编辑器外的文件会被浏览器直接打开/导航）
      e.preventDefault();
      // 笔记模块：交给编辑器自身的 onDrop 在光标处插入，避免重复处理
      if (activeModuleRef.current === 'notes') return;
      for (const file of Array.from(dt.files)) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          logger.dropzone.importStart(file.name);
          const imported = await api.addBytesToDropzone(dataUrl, file.name);
          logger.dropzone.importSuccess(imported.originalName, imported.isReadable);
          emitDropzoneChange();
          if (imported.isReadable) {
            try {
              logger.dropzone.readStart(imported.storedPath);
              const fileContent: string = await invoke('read_dropzone_file', { storedPath: imported.storedPath });
              logger.dropzone.readSuccess(imported.originalName, fileContent.length);
              openExternalContentRef.current(imported.originalName.replace(/\.\w+$/, ''), fileContent);
            } catch (readErr) {
              logger.dropzone.readFailed(imported.storedPath, readErr);
            }
          }
        } catch (err) {
          logger.dropzone.importFailed(file.name, err);
        }
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // ====== 中转站回调 ======
  const handleOpenReadableFile = useCallback((file: { originalName: string }, fileContent: string) => {
    openExternalContent(file.originalName.replace(/\.\w+$/, ''), fileContent);
    setActiveModule('notes');
  }, [openExternalContent, setActiveModule]);

  // ====== 模块路由 ======
  const renderModule = () => {
    if (activeModule === 'settings') {
      return <div className="flex-1 h-full overflow-hidden main-panel-bg p-6 fade-in"><GlobalSettingsPanel /></div>;
    }
    if (activeModule === 'transfer') {
      return <TransferStationPanel onOpenReadableFile={handleOpenReadableFile} />;
    }
    if (activeModule === 'notes') {
      return <NotesModule />;
    }
    if (activeModule === 'extensions' && pluginRegistry) {
      return <ExtensionsHub registry={pluginRegistry} parentId="niaoluo" excludePluginIds={mainPluginIds} />;
    }
    // 茑萝子插件模式下，若用户点击了"管理拓展设置"，优先渲染 ExtensionsHub（内部会检测 showExtensionSettings）
    // 这样设置面板能顶掉当前子插件的主面板页面
    if (
      showExtensionSettings &&
      pluginRegistry &&
      pluginRegistry.get(activeModule)?.parent === 'niaoluo'
    ) {
      return <ExtensionsHub registry={pluginRegistry} parentId="niaoluo" excludePluginIds={mainPluginIds} />;
    }
    if (pluginRegistry && (mainPluginIds.includes(activeModule) || subPluginIds.includes(activeModule))) {
      logger.app.mainPluginRenderStart(activeModule, !!pluginRegistry);
      const def = pluginRegistry.get(activeModule);
      if (!def) {
        logger.app.mainPluginMissing(activeModule, pluginRegistry.getAll().map(p => p.id));
        return <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500">插件未加载</div>;
      }
      if (!def.component) {
        logger.app.mainPluginNoComponent(activeModule, Object.keys(def));
        return <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500">插件组件缺失</div>;
      }
      logger.app.mainPluginRendering(activeModule, typeof def.component, def.name);
      return <PluginErrorBoundary key={`${activeModule}-${activeReloadKey}`} pluginId={activeModule}><def.component /></PluginErrorBoundary>;
    }
    return <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500">未找到该模块</div>;
  };

  return (
    <PluginHost onPluginsLoaded={(registry) => {
      setPluginRegistry(registry);
      // 进度：全部模块就绪，收尾加载层（100% → 淡出）
      const boot = window as unknown as {
        __bootProgress?: (pct: number, opts?: { text?: string; phase?: string }) => void;
        __bootDone?: (opts?: { text?: string; phase?: string }) => void;
      };
      boot.__bootProgress?.(100, { text: "准备就绪", phase: "PHASE 05 / 05" });
      boot.__bootDone?.({ text: "准备就绪", phase: "PHASE 05 / 05" });
    }}>
      <div className="flex flex-col h-screen w-screen main-panel-bg text-foreground antialiased overflow-hidden">
        <Titlebar />
        <div className="flex flex-1 overflow-hidden">
          <AppNav mainPluginIds={mainPluginIds} />
          <HostSidebar />
          <div className="flex flex-1 h-full overflow-hidden">
            {renderModule()}
          </div>
        </div>
      </div>
    </PluginHost>
  );
}

export default App;
