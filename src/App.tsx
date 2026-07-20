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
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ensureOverlayWindow } from '@/core/overlayWindow';
import { listen } from '@tauri-apps/api/event';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
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
  const notes = useNotesStore(s => s.notes);

  // 热重载生效：当前活动模块被重新注册时，强制重挂其组件（画布重新初始化，给出可见反馈）
  const [activeReloadKey, setActiveReloadKey] = useState(0);

  // ====== 微信式截图 ======
  // 不隐藏主窗口：软件运行（含最小化/托盘）时随时可截图；主窗口可见时会被截入画面
  // （已在 UI 层说明取舍）。截图覆盖窗由前端 new WebviewWindow 创建并复用（与浮窗同款安全路径），
  // 不在 Rust 异步命令里同步 build()，避免 WebView2 0x8007139F / "无法获取缩放比"。
  // 截图覆盖窗：由前端创建（与浮窗同款已验证安全路径）。Rust start_screenshot 仅操作已存在的窗。
  const ensureScreenshotOverlay = useCallback(async () => {
    // 统一走 window_manager 引擎：主线程安全创建 + 重试 + 坏窗自愈，
    // 不再各自 new WebviewWindow（避免坏窗残留 / 错误抓不到）。离屏坐标创建后由 start_screenshot 定位显示。
    try {
      return await ensureOverlayWindow('screenshot-overlay', 'screenshot-overlay.html', {
        width: 1280,
        height: 720,
        x: -4000,
        y: -4000,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        shadow: false,
      });
    } catch (err) {
      console.error('[截图] 创建覆盖窗失败:', err);
      return null;
    }
  }, []);

  const startScreenshot = useCallback(async () => {
    try {
      // 记录当前笔记页 id（非阻塞：与截图启动并行，减少一次 IPC 往返延迟）
      const noteId = useNotesStore.getState().currentNoteId ?? '';
      invoke('store_screenshot_note_id', { noteId }).catch(() => {});
      // 确保覆盖窗已创建（前端 new WebviewWindow，环境就绪后创建，避免 WebView2 初始化失败）
      await ensureScreenshotOverlay();
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

  // 唤出剪贴板浮窗（全局热键，复用 Rust 已注册的 floating-clipboard 窗口）
  const openClipboardFloating = useCallback(async () => {
    // 统一走 window_manager 引擎；复用（已存在则直接 show）由 ensureOverlayWindow 内部处理
    try {
      const w = await ensureOverlayWindow('floating-clipboard', 'index.html?floating=clipboard', {
        width: 360,
        height: 480,
        minWidth: 280,
        minHeight: 320,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
      });
      if (w) {
        await w.show();
        await w.setFocus();
      }
    } catch (err) {
      console.error('[Floating] 创建剪贴板浮窗失败:', err);
    }
  }, []);

  // 唤出中转站浮窗（全局热键，与图标栏中转站共享数据源、实时同步）
  const openDropzoneFloating = useCallback(async () => {
    try {
      const w = await ensureOverlayWindow('floating-dropzone', 'index.html?floating=dropzone', {
        width: 420,
        height: 520,
        minWidth: 320,
        minHeight: 360,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        // 关闭 Tauri 原生拖放，改由前端 HTML5 dragover/drop 处理，
        // 否则原生拖放会吞掉 drop 事件，导致文件拖入浮窗无法导入 / 同步主站。
        dragDropEnabled: false,
      });
      if (w) {
        await w.show();
        await w.setFocus();
      }
    } catch (err) {
      console.error('[Floating] 创建中转站浮窗失败:', err);
    }
  }, []);

  // 托盘菜单窗：由前端 new WebviewWindow 创建（与浮窗同款安全路径）。
  // Rust 侧 open_tray_menu 仅在右键时 emit 光标位置（open-tray-menu），避免 Rust 同步 build() 死锁/异常。
  const openTrayMenu = useCallback(async (x: number, y: number) => {
    let w: WebviewWindow | null = null;
    try {
      // 透明窗不能 visible:false 创建（会 0x8007139F 变坏窗）；改离屏坐标创建后定位到托盘附近再 show。
      // 统一走 window_manager 引擎：主线程安全创建 + 重试 + 坏窗自愈。
      w = await ensureOverlayWindow('tray-menu', 'index.html?overlay=tray-menu', {
        width: 220,
        height: 156,
        x: -4000,
        y: -4000,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        shadow: false,
      });
    } catch (err) {
      console.error('[托盘] 创建菜单窗失败:', err);
      return;
    }
    if (!w) return;
    try {
      await w.setPosition(new PhysicalPosition(Math.max(4, x - 110), Math.max(4, y - 160)));
      await w.show();
      await w.setFocus();
    } catch (err) {
      console.error('[托盘] 显示菜单窗失败:', err);
    }
  }, []);

  useEffect(() => {
    const un = listen<null>('open-clipboard-floating', () => { void openClipboardFloating(); });
    return () => { void un.then((fn) => fn()); };
  }, [openClipboardFloating]);

  useEffect(() => {
    const un = listen<null>('open-dropzone-floating', () => { void openDropzoneFloating(); });
    return () => { void un.then((fn) => fn()); };
  }, [openDropzoneFloating]);

  // Rust 托盘右键 → emit 光标位置，前端建窗并定位显示
  useEffect(() => {
    const un = listen<{ x: number; y: number }>('open-tray-menu', (e) => {
      void openTrayMenu(e.payload.x, e.payload.y);
    });
    return () => { void un.then((fn) => fn()); };
  }, [openTrayMenu]);

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

  // Rust 端写入 dropzone 后 emit 'dropzone-changed'，前端立即刷新中转站列表
  // （ScreenshotOverlay 的 finish 回调也会调 emitDropzoneChange，但 Tauri 事件更可靠：
  // 即便覆盖窗已关闭、finish 未执行也能触发刷新）
  useEffect(() => {
    const un = listen('dropzone-changed', () => emitDropzoneChange());
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
  // 导致哥特加载页动画掉帧（用户 Issue 4）。延迟 ~200ms 后执行，此时加载页已流畅播放、且仍盖在上方。
  const initCleanupRef = useRef<() => void>(() => {});
  useEffect(() => {
    const t = window.setTimeout(() => {
      initNotes();
      initCleanupRef.current = initFloatingListeners() || (() => {});
    }, 200);
    return () => {
      window.clearTimeout(t);
      initCleanupRef.current();
    };
  }, [initNotes, initFloatingListeners]);

  // 加载页收尾：不再「UI 一渲染就关加载页」，而是**等笔记列表真正加载完毕**再淡出
  // （用户 Issue 4：之前加载页先结束、笔记目录再过 ~2s 才出现，体验割裂）。
  // 笔记在加载页盖住期间已在后台加载；加载页最短展示时长（index.html MIN_BOOT_MS=2600ms）
  // 仍保证用户能看到哥特动画。最多等 4s，避免极端情况下加载页卡住。
  const bootDoneRef = useRef(false);
  const finishBoot = useCallback(() => {
    if (bootDoneRef.current) return;
    bootDoneRef.current = true;
    const boot = window as unknown as {
      __bootDone?: (opts?: { text?: string; phase?: string }) => void;
    };
    boot.__bootDone?.({ text: "准备就绪", phase: "PHASE 05 / 05" });
  }, []);
  useEffect(() => {
    if (notes.length > 0) finishBoot();
  }, [notes, finishBoot]);
  useEffect(() => {
    const t = window.setTimeout(finishBoot, 4000);
    return () => window.clearTimeout(t);
  }, [finishBoot]);

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
      // 进度：全部模块就绪，进度拉满（100%）。加载页淡出改由 App 内
      // 笔记列表加载完毕后统一触发（见 finishBoot），确保笔记与 UI 同步出现。
      const boot = window as unknown as {
        __bootProgress?: (pct: number, opts?: { text?: string; phase?: string }) => void;
      };
      boot.__bootProgress?.(100, { text: "准备就绪", phase: "PHASE 05 / 05" });
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
