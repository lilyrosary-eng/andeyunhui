import { useState, useEffect, useCallback, useRef } from 'react';
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Settings, Sparkles, Palette, Puzzle, Sun, Moon, Monitor, Keyboard, Info, ExternalLink, Database, Archive, FileText, File, Undo2, Trash2, ChevronDown, ChevronUp, RotateCcw, Search, Ban, Eye, FolderOpen, Cpu, Languages } from 'lucide-react'
import { ExtensionManagerPanel } from '@/core/settings/ExtensionManagerPanel'
import { BackgroundImageEditor } from '@/core/settings/BackgroundImageEditor'
import { BlacklistManager } from '@/core/settings/BlacklistManager'
import { ModelSettings } from '@/core/settings/ModelSettings'
import { DevConsole } from '@/core/settings/DevConsole'
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { logger } from '@/lib/logger';
import { api, type ArchiveEntry, type PluginManifest } from '@/lib/api';
import { useTheme } from '@/lib/ThemeProvider';
import { useSystemFonts } from '@/lib/useSystemFonts';
import { previewBootScreen } from '@/lib/bootPreview';
import { SlidingTabs } from '@/components/motion/SlidingTabs';
import { useI18n, LANGUAGES, type Language } from '@/lib/i18n';
import { DeskpetManifest, loadDeskpetManifest, saveDeskpetManifest, inferDeskpetAsset, DeskpetPreset, loadDeskpetPresets, saveDeskpetPresets, loadActivePresetId, saveActivePresetId } from '@/deskpetManifest';
import { useAppStore } from '@/stores/appStore';

type TabId = 'general' | 'themes' | 'extensions' | 'transfer' | 'model' | 'blacklist' | 'about';

interface ShortcutDef {
  id: string;
  label: string;
  keys: string;
}

const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { id: 'bold', label: '加粗', keys: 'Ctrl + B' },
  { id: 'italic', label: '斜体', keys: 'Ctrl + I' },
  { id: 'link', label: '链接', keys: 'Ctrl + K' },
  { id: 'screenshot', label: '全局截图', keys: 'Ctrl + Shift + S' },
  { id: 'recorder', label: '全局录屏', keys: 'Ctrl + Alt + R' },
  { id: 'clipboard', label: '剪贴板浮窗', keys: 'Ctrl + Alt + C' },
  { id: 'dropzone', label: '中转站浮窗', keys: 'Ctrl + Alt + V' },
];

function loadShortcuts(): ShortcutDef[] {
  try {
    const raw = localStorage.getItem('shortcuts');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.shortcuts.configLoaded(parsed.length);
        return parsed;
      }
    }
  } catch { /* 解析失败使用默认值 */ }
  return DEFAULT_SHORTCUTS;
}

function saveShortcuts(shortcuts: ShortcutDef[]) {
  localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
}

// 桌宠素材缩略图：从外部依赖包直接读取字节并预览（图片/视频）
function PetAssetThumb({ rel, mime }: { rel: string; mime: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<string>('read_external_dep_bytes', { relativePath: rel })
      .then((b64) => {
        if (alive) setUrl(`data:${mime};base64,${b64}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [rel, mime]);
  if (!url) return <div className="w-12 h-12 rounded-lg bg-neutral-100 dark:bg-stone-700 animate-pulse" />;
  if (mime.startsWith('video')) {
    return <video src={url} muted loop autoPlay playsInline className="w-12 h-12 rounded-lg object-cover" />;
  }
  return <img src={url} alt="" className="w-12 h-12 rounded-lg object-cover" />;
}

/** 将 KeyboardEvent 转为快捷键字符串 */
function eventToShortcut(e: KeyboardEvent): string | null {
  const key = e.key;
  // 忽略修饰键本身
  if (['Control', 'Shift', 'Alt', 'Meta', 'Escape', 'Tab', 'CapsLock'].includes(key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  // 规范化键名
  const normalized = key.length === 1 ? key.toUpperCase() : key === ' ' ? 'Space' : key;
  parts.push(normalized);
  return parts.join(' + ');
}

/** 将存储型快捷键（"Ctrl+Shift+S"）转为展示格式（"Ctrl + Shift + S"） */
function normalizeForDisplay(s: string): string {
  return s.split('+').map((p) => p.trim()).join(' + ');
}

// 存档 modified 形如 "YYYYMMDD_HHMMSS" → "YYYY-MM-DD HH:MM:SS"
function formatArchiveTime(modified: string): string {
  const m = modified.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return modified;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

export function GlobalSettingsPanel() {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme, themeColor, setThemeColor, elementColor, setElementColor, reverseColor, setReverseColor, zoom, setZoom, panelOpacity, setPanelOpacity, fontFamily, setFontFamily, bgImage, setBgImage, bgBlur, setBgBlur, setBgAngle, setBgFlip } = useTheme();
  const [autoSave, setAutoSave] = useState(true);
  const [bgEditorSrc, setBgEditorSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [autoSaveInterval, setAutoSaveInterval] = useState([30]);
  const [trayMode, setTrayMode] = useState(false);

  // 系统字体
  const { fonts, loading: fontsLoading } = useSystemFonts();
  const [fontSearch, setFontSearch] = useState('');
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);

  // 过滤字体列表
  const filteredFonts = fontSearch
    ? fonts.filter(f => f.displayName.toLowerCase().includes(fontSearch.toLowerCase()) || f.family.toLowerCase().includes(fontSearch.toLowerCase()))
    : fonts;

  // 当前选中字体的显示名称
  const currentFontDisplay = fonts.find(f => f.family === fontFamily)?.displayName || fontFamily;

  // 点击外部关闭字体下拉
  useEffect(() => {
    if (!fontDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.font-dropdown')) setFontDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fontDropdownOpen]);

  // 快捷键状态
  const [shortcuts, setShortcuts] = useState<ShortcutDef[]>(loadShortcuts);
  const [shortcutsOpen, setShortcutsOpen] = useState(true);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);

  // 启动时加载托盘模式配置
  useEffect(() => {
    invoke<boolean>('get_tray_mode')
      .then(setTrayMode)
      .catch(() => {});
  }, []);

  // 启动时从 Rust 读取实际生效的截图/录屏热键，与设置面板展示同步（设置改键会真正注册）
  useEffect(() => {
    const updateDisplay = (id: string, sc: string) => {
      const display = normalizeForDisplay(sc);
      setShortcuts((prev) => {
        const updated = prev.map((s) =>
          s.id === id ? { ...s, keys: display } : s,
        );
        saveShortcuts(updated);
        return updated;
      });
    };
    invoke<string>('get_screenshot_shortcut')
      .then((sc) => updateDisplay('screenshot', sc))
      .catch(() => {});
    invoke<string>('get_recorder_shortcut')
      .then((sc) => updateDisplay('recorder', sc))
      .catch(() => {});
    invoke<string>('get_clipboard_shortcut')
      .then((sc) => updateDisplay('clipboard', sc))
      .catch(() => {});
    invoke<string>('get_dropzone_shortcut')
      .then((sc) => updateDisplay('dropzone', sc))
      .catch(() => {});
  }, []);

  // 键盘捕获：编辑快捷键时监听按键
  useEffect(() => {
    if (!editingShortcutId) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        logger.shortcuts.editCancel(editingShortcutId);
        setEditingShortcutId(null);
        return;
      }
      const shortcut = eventToShortcut(e);
      if (shortcut) {
        setShortcuts(prev => {
          const updated = prev.map(s => s.id === editingShortcutId ? { ...s, keys: shortcut } : s);
          saveShortcuts(updated);
          logger.shortcuts.editConfirm(editingShortcutId, shortcut);
          return updated;
        });
        // 截图/录屏热键：真正注册到系统（解析失败则忽略，保留本地展示）
        if (editingShortcutId === 'screenshot') {
          invoke('set_screenshot_shortcut', { shortcut }).catch((err) => {
            console.error('[截图] 设置热键失败:', err);
          });
        } else if (editingShortcutId === 'recorder') {
          invoke('set_recorder_shortcut', { shortcut }).catch((err) => {
            console.error('[录屏] 设置热键失败:', err);
          });
        } else if (editingShortcutId === 'clipboard') {
          invoke('set_clipboard_shortcut', { shortcut }).catch((err) => {
            console.error('[剪贴板] 设置热键失败:', err);
          });
        } else if (editingShortcutId === 'dropzone') {
          invoke('set_dropzone_shortcut', { shortcut }).catch((err) => {
            console.error('[中转站] 设置热键失败:', err);
          });
        }
        setEditingShortcutId(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [editingShortcutId]);

  const handleResetShortcuts = () => {
    setShortcuts(DEFAULT_SHORTCUTS);
    saveShortcuts(DEFAULT_SHORTCUTS);
    logger.shortcuts.reset();
    // 重置时把截图/录屏热键恢复为默认并重新注册
    const sc = DEFAULT_SHORTCUTS.find((s) => s.id === 'screenshot');
    if (sc) invoke('set_screenshot_shortcut', { shortcut: sc.keys }).catch(() => {});
    const rc = DEFAULT_SHORTCUTS.find((s) => s.id === 'recorder');
    if (rc) invoke('set_recorder_shortcut', { shortcut: rc.keys }).catch(() => {});
    const cc = DEFAULT_SHORTCUTS.find((s) => s.id === 'clipboard');
    if (cc) invoke('set_clipboard_shortcut', { shortcut: cc.keys }).catch(() => {});
    const dc = DEFAULT_SHORTCUTS.find((s) => s.id === 'dropzone');
    if (dc) invoke('set_dropzone_shortcut', { shortcut: dc.keys }).catch(() => {});
  };

  const handleStartEditShortcut = (id: string) => {
    logger.shortcuts.editStart(id);
    setEditingShortcutId(id);
  };

  // 通用存档（快照）列表
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);

  const loadArchives = useCallback(() => {
    setArchiveLoading(true);
    api.listArchives()
      .then((items) => setArchives(items))
      .catch((err) => logger.transferStation.listFailed(err))
      .finally(() => setArchiveLoading(false));
  }, []);

  useEffect(() => {
    if (activeTab === 'transfer') {
      loadArchives();
    }
  }, [activeTab, loadArchives]);

  const [themePack, setThemePack] = useState('默认');

  // 加载自动保存配置
  useEffect(() => {
    invoke<{ enabled: boolean; intervalSecs: number }>('get_auto_save_config')
      .then((cfg) => {
        setAutoSave(cfg.enabled);
        setAutoSaveInterval([cfg.intervalSecs]);
        logger.autoSave.configLoaded(cfg.enabled, cfg.intervalSecs);
      })
      .catch((err) => {
        logger.autoSave.configLoadFailed(err);
      });
  }, []);

  // 同步自动保存配置到后端
  const syncAutoSave = (enabled: boolean, interval: number) => {
    logger.autoSave.configUpdated(enabled, interval);
    invoke('configure_auto_save', { enabled, intervalSecs: interval }).catch((err) => {
      logger.autoSave.syncFailed(err);
    });
  };

  // ---- 桌宠显隐：与「管理拓展」共享单一可见性状态（单一事实源，避免两处开关脱节）----
  const [deskpetVisible, setDeskpetVisible] = useState<boolean | null>(null);
  const [deskpetManifest, setDeskpetManifest] = useState<PluginManifest | null>(null);
  const deskpetHot = (window as unknown as { __pluginHot__?: { load: (m: PluginManifest) => Promise<void>; unload: (id: string) => void } }).__pluginHot__;

  // ---- 茑萝 RAG 模块：默认不在侧栏展示（manifest.visible=false，作为内置功能），由本开关控制显隐 ----
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const activeModule = useAppStore((s) => s.activeModule);
  const [ragVisible, setRagVisible] = useState<boolean>(() => {
    try { return localStorage.getItem('niaoluo:rag-visible') === '1'; } catch { return false; }
  });
  const toggleRagModule = (val: boolean) => {
    setRagVisible(val);
    try { localStorage.setItem('niaoluo:rag-visible', val ? '1' : '0'); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('niaoluo-rag-visibility'));
    if (!val && activeModule === 'rag') setActiveModule('extensions');
  };

  useEffect(() => {
    let alive = true;
    api.getInstalledPlugins().then((res) => {
      if (!alive) return;
      const d = (res.valid ?? []).find((p) => p.id === 'deskpet');
      if (d) { setDeskpetManifest(d); setDeskpetVisible(d.visible !== false); }
    }).catch(() => {});
    const onVis = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; visible: boolean }>).detail;
      if (detail && detail.id === 'deskpet') setDeskpetVisible(detail.visible);
    };
    window.addEventListener('plugin-visibility-changed', onVis);
    return () => { alive = false; window.removeEventListener('plugin-visibility-changed', onVis); };
  }, []);

  const toggleDeskpet = useCallback(async (val: boolean) => {
    if (!deskpetManifest) return;
    setDeskpetVisible(val);
    try {
      await api.setPluginVisibility('deskpet', val);
      if (val) await deskpetHot?.load(deskpetManifest);
      else deskpetHot?.unload('deskpet');
      // 派发与「管理拓展」相同的事件，保证两处开关状态一致
      window.dispatchEvent(new CustomEvent('plugin-visibility-changed', { detail: { id: 'deskpet', visible: val } }));
    } catch (err) {
      logger.log('[GlobalSettings] 桌宠显隐切换失败:', err);
      setDeskpetVisible(!val);
    }
  }, [deskpetManifest, deskpetHot]);

  // ---- 桌宠 Phase A 基础设置（缩放 / 透明度 / 点击穿透）----
  // 与插件 / 浮窗共享 localStorage['deskpet:settings']：面板写入并全局 emit，
  // 浮窗直接收到应用；插件监听更新缓存并持久化，并在浮窗请求时回复。
  const DESKPET_SETTINGS_KEY = 'deskpet:settings';
  const [deskpetScale, setDeskpetScale] = useState(1);
  const [deskpetOpacity, setDeskpetOpacity] = useState(1);
  const [deskpetClickThrough, setDeskpetClickThrough] = useState(false);

  // 启动时从 localStorage 恢复缓存值（与插件 / 浮窗对齐）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DESKPET_SETTINGS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as {
          scale?: number;
          opacity?: number;
          clickThrough?: boolean;
        };
        if (typeof p.scale === 'number') setDeskpetScale(p.scale);
        if (typeof p.opacity === 'number') setDeskpetOpacity(p.opacity);
        if (typeof p.clickThrough === 'boolean') setDeskpetClickThrough(p.clickThrough);
      }
    } catch {
      /* 忽略解析失败 */
    }
  }, []);

  // 持久化并下发（浮窗经全局 emit 直接收到；插件监听并更新缓存）
  const pushDeskpetSettings = useCallback(
    (next: { scale: number; opacity: number; clickThrough: boolean }) => {
      try {
        localStorage.setItem(DESKPET_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* 忽略持久化失败 */
      }
      emit('deskpet:settings', next).catch(() => {});
    },
    [],
  );

  // ---- 桌宠素材清单（manifest）：用户可导入自己的图片/视频 ----
  // 与插件 / 浮窗共享 localStorage['deskpet:manifest']：面板写入并全局 emit，
  // 浮窗直接收到应用；插件监听更新缓存并在浮窗请求时回复。
  const [petManifest, setPetManifest] = useState<DeskpetManifest>(() => loadDeskpetManifest());
  const [petTargetState, setPetTargetState] = useState<string>('idle');
  const [petNewState, setPetNewState] = useState<string>('');
  const [petImportError, setPetImportError] = useState<string>('');

  const pushPetManifest = useCallback(
    (next: DeskpetManifest) => {
      setPetManifest(next);
      try {
        saveDeskpetManifest(next);
      } catch {
        /* 忽略持久化失败 */
      }
      emit('deskpet:manifest', next).catch(() => {});
    },
    [],
  );

  // ---- 桌宠预设：每个方案 = manifest + 基础设置，独立保存可切换 ----
  const [presets, setPresets] = useState<DeskpetPreset[]>(() => loadDeskpetPresets());
  const [activePresetId, setActivePresetId] = useState<string | null>(() => loadActivePresetId());
  const [newPresetName, setNewPresetName] = useState('');

  const applyPreset = useCallback((p: DeskpetPreset) => {
    pushPetManifest(p.manifest);
    pushDeskpetSettings(p.settings);
    setDeskpetScale(p.settings.scale);
    setDeskpetOpacity(p.settings.opacity);
    setDeskpetClickThrough(p.settings.clickThrough);
  }, [pushPetManifest, pushDeskpetSettings]);

  const handleSelectPreset = useCallback((id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setActivePresetId(id);
    saveActivePresetId(id);
    applyPreset(p);
  }, [presets, applyPreset]);

  const handleSavePreset = useCallback(() => {
    const name = newPresetName.trim() || `方案 ${presets.length + 1}`;
    const id = `preset-${Date.now()}`;
    const preset: DeskpetPreset = {
      id,
      name,
      manifest: petManifest,
      settings: { scale: deskpetScale, opacity: deskpetOpacity, clickThrough: deskpetClickThrough },
    };
    const next = [...presets, preset];
    setPresets(next);
    saveDeskpetPresets(next);
    setActivePresetId(id);
    saveActivePresetId(id);
    setNewPresetName('');
  }, [presets, petManifest, deskpetScale, deskpetOpacity, deskpetClickThrough]);

  const handleDeletePreset = useCallback((id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    saveDeskpetPresets(next);
    if (activePresetId === id) {
      setActivePresetId(null);
      saveActivePresetId(null);
    }
  }, [presets, activePresetId]);

  const handleRenamePreset = useCallback((id: string, name: string) => {
    const next = presets.map((p) => (p.id === id ? { ...p, name } : p));
    setPresets(next);
    saveDeskpetPresets(next);
  }, [presets]);

  // 导入本地图片/视频作为桌宠素材：复制到 user_external_deps/deskpet-assets/pet/，并写入 manifest
  const handleImportPetAsset = useCallback(async () => {
    setPetImportError('');
    const targetId = petTargetState === '__new__' ? petNewState.trim() : petTargetState;
    if (!targetId) {
      setPetImportError('请选择或填写目标状态名称');
      return;
    }
    try {
      const picked = await invoke<string[]>('pick_file', {
        title: '选择桌宠图片或视频',
        filters: [
          {
            name: '图片/视频',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'ogg'],
          },
        ],
      });
      if (!picked || picked.length === 0) return;
      const src = picked[0];
      const fname = src.split(/[\\/]/).pop() || 'asset';
      const rel = await invoke<string>('import_deskpet_asset', { sourcePath: src, filename: fname });
      const { kind, mime } = inferDeskpetAsset(fname);
      const next: DeskpetManifest = {
        states: petManifest.states.map((s) =>
          s.id === targetId ? { ...s, assets: [...s.assets, { file: fname, rel, kind, mime }] } : s,
        ),
      };
      if (!next.states.some((s) => s.id === targetId)) {
        next.states.push({ id: targetId, label: targetId, assets: [{ file: fname, rel, kind, mime }] });
      }
      setPetNewState('');
      pushPetManifest(next);
    } catch (err) {
      setPetImportError(String(err));
    }
  }, [petManifest, petTargetState, petNewState, pushPetManifest]);

  const removePetAsset = useCallback(
    (stateId: string, rel: string) => {
      const next: DeskpetManifest = {
        states: petManifest.states.map((s) =>
          s.id === stateId ? { ...s, assets: s.assets.filter((a) => a.rel !== rel) } : s,
        ),
      };
      pushPetManifest(next);
    },
    [petManifest, pushPetManifest],
  );

  const tabs = [
    { id: 'general' as const, label: t('settings.tab.general'), icon: Settings },
    { id: 'themes' as const, label: t('settings.tab.themes'), icon: Palette },
    { id: 'extensions' as const, label: t('settings.tab.extensions'), icon: Puzzle },
    { id: 'transfer' as const, label: t('settings.tab.transfer'), icon: Archive },
    { id: 'model' as const, label: t('settings.tab.model'), icon: Cpu },
    { id: 'blacklist' as const, label: t('settings.tab.blacklist'), icon: Ban },
    { id: 'about' as const, label: t('settings.tab.about'), icon: Info },
  ];

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <SlidingTabs
            tabs={tabs.map((tab) => ({ id: tab.id, label: tab.label, icon: <tab.icon size={14} /> }))}
            value={activeTab}
            onChange={(id) => setActiveTab(id as TabId)}
            className="mb-8 bg-white dark:bg-stone-700/60 backdrop-blur border border-white/80 dark:border-stone-700/50 rounded-xl p-1 w-fit"
          />

          {activeTab === 'general' && (
            <div className="space-y-6">
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
                  <Languages size={14} />
                  {t('settings.general.language.title')}
                </h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-4">
                  <div className="flex justify-between items-center gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-neutral-700 dark:text-stone-200">{t('settings.general.language.label')}</div>
                      <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{t('settings.general.language.desc')}</div>
                    </div>
                    <div className="flex-shrink-0">
                      <select
                        value={lang}
                        onChange={(e) => setLang(e.target.value as Language)}
                        className="px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-200 outline-none cursor-pointer hover:border-neutral-300 dark:hover:border-stone-500 focus:ring-2 focus:ring-[var(--element-border)]"
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">{t('settings.general.zoom.title')}</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-4">
                  <div className="flex justify-between items-center text-sm font-medium mb-3">
                    <span>{t('settings.general.zoom.level')}</span>
                    <span className="text-neutral-500 dark:text-stone-400">{zoom}%</span>
                  </div>
                  <Slider
                    value={[zoom]}
                    onValueChange={([v]: number[]) => setZoom(v)}
                    max={150}
                    min={50}
                    step={5}
                    className="slider-themed"
                  />
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
                  <Keyboard size={14} />
                  {t('settings.general.shortcuts.title')}
                </h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden">
                  {/* 折叠标题栏 */}
                  <div
                    onClick={() => setShortcutsOpen(!shortcutsOpen)}
                    className="w-full flex justify-between items-center p-4 hover:bg-neutral-50 dark:hover:bg-stone-700/50 transition-colors cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setShortcutsOpen(!shortcutsOpen); }}
                  >
                    <span className="text-sm font-medium text-neutral-700 dark:text-stone-200">
                      {t('settings.general.shortcuts.title')} ({shortcuts.length})
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleResetShortcuts(); }}
                        className="btn-press p-1 rounded-md text-neutral-400 dark:text-stone-500 hover:text-amber-500 transition-colors"
                        title={t('settings.general.shortcuts.resetDefault')}
                      >
                        <RotateCcw size={14} />
                      </button>
                      {shortcutsOpen ? <ChevronUp size={16} className="text-neutral-400 dark:text-stone-500" /> : <ChevronDown size={16} className="text-neutral-400 dark:text-stone-500" />}
                    </div>
                  </div>
                  {/* 折叠内容 */}
                  {shortcutsOpen && (
                    <div className="divide-y divide-neutral-200/50 dark:divide-stone-700/50">
                      {shortcuts.map((shortcut) => (
                        <div key={shortcut.id} className="flex justify-between items-center p-4">
                          <span className="text-sm text-neutral-600 dark:text-stone-300">{t('shortcut.' + shortcut.id)}</span>
                          {editingShortcutId === shortcut.id ? (
                            <kbd className="px-3 py-1 rounded-md bg-[var(--element-muted)] text-xs font-medium text-[var(--element-bg)] animate-pulse">
                              {t('settings.general.shortcuts.pressKey')}
                            </kbd>
                          ) : (
                            <button
                              onClick={() => handleStartEditShortcut(shortcut.id)}
                              className="btn-press px-3 py-1 rounded-md bg-neutral-100 dark:bg-stone-700 text-xs font-medium text-neutral-500 dark:text-stone-400 hover:bg-[var(--element-muted)] hover:text-[var(--element-bg)] transition-colors cursor-pointer"
                              title={t('settings.general.shortcuts.editTip')}
                            >
                              {shortcut.keys}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {!shortcutsOpen && (
                    <div className="px-4 pb-3 text-xs text-neutral-400 dark:text-stone-500">
                      {shortcuts.map(s => s.keys).join('  ·  ')}
                    </div>
                  )}
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">{t('settings.general.common.title')}</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">{t('settings.general.tray.title')}</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{t('settings.general.tray.desc')}</p>
                    </div>
                    <Switch
                      checked={trayMode}
                      onCheckedChange={(val: boolean) => {
                        setTrayMode(val);
                        invoke('toggle_tray_mode', { enabled: val }).catch(() => {});
                      }}
                      className="data-[state=checked]:bg-[var(--element-color-raw)]"
                    />
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">{t('settings.general.autosave.title')}</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{t('settings.general.autosave.desc')}</p>
                    </div>
                    <Switch checked={autoSave} onCheckedChange={(val: boolean) => {
                      setAutoSave(val);
                      syncAutoSave(val, autoSaveInterval[0]);
                    }} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
                  </div>
                  {autoSave && (
                    <div className="p-4">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.general.autosave.interval')}</span>
                        <span className="text-xs text-neutral-500 dark:text-stone-400">{autoSaveInterval[0]}s</span>
                      </div>
                      <Slider
                        value={autoSaveInterval}
                        onValueChange={(val: number[]) => {
                          setAutoSaveInterval(val);
                          syncAutoSave(autoSave, val[0]);
                        }}
                        min={5}
                        max={120}
                        step={5}
                        className="slider-themed"
                      />
                    </div>
                  )}
                </div>
              </section>

              {/* 桌宠：显隐 + Phase A 基础设置（缩放 / 透明度 / 点击穿透） */}
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
                  <Sparkles size={14} />
                  桌宠
                </h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  {/* 显隐：与「管理拓展」共享单一可见性状态（单一事实源） */}
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">桌宠显示</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">启用后桌宠常驻桌面漫步；关闭即卸载插件。</p>
                    </div>
                    <Switch
                      checked={deskpetVisible ?? false}
                      disabled={deskpetManifest === null}
                      onCheckedChange={(val: boolean) => { void toggleDeskpet(val); }}
                      className="data-[state=checked]:bg-[var(--element-color-raw)]"
                    />
                  </div>
                  {/* 缩放 */}
                  <div className="p-4">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-sm text-neutral-600 dark:text-stone-300">缩放</span>
                      <span className="text-xs text-neutral-500 dark:text-stone-400">{Math.round(deskpetScale * 100)}%</span>
                    </div>
                    <Slider
                      value={[deskpetScale]}
                      onValueChange={([v]: number[]) => {
                        const s = v;
                        setDeskpetScale(s);
                        pushDeskpetSettings({ scale: s, opacity: deskpetOpacity, clickThrough: deskpetClickThrough });
                      }}
                      min={0.5}
                      max={1.5}
                      step={0.05}
                      className="slider-themed"
                    />
                  </div>
                  {/* 透明度 */}
                  <div className="p-4">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-sm text-neutral-600 dark:text-stone-300">透明度</span>
                      <span className="text-xs text-neutral-500 dark:text-stone-400">{Math.round(deskpetOpacity * 100)}%</span>
                    </div>
                    <Slider
                      value={[deskpetOpacity]}
                      onValueChange={([v]: number[]) => {
                        const o = v;
                        setDeskpetOpacity(o);
                        pushDeskpetSettings({ scale: deskpetScale, opacity: o, clickThrough: deskpetClickThrough });
                      }}
                      min={0.2}
                      max={1}
                      step={0.05}
                      className="slider-themed"
                    />
                  </div>
                  {/* 点击穿透 */}
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">点击穿透</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">开启后鼠标可穿透桌宠（不拦截点击），便于截图选区。</p>
                    </div>
                    <Switch
                      checked={deskpetClickThrough}
                      onCheckedChange={(val: boolean) => {
                        setDeskpetClickThrough(val);
                        pushDeskpetSettings({ scale: deskpetScale, opacity: deskpetOpacity, clickThrough: val });
                      }}
                      className="data-[state=checked]:bg-[var(--element-color-raw)]"
                    />
                  </div>
                  {/* 自定义素材：导入自己的图片 / 视频，按状态绑定 */}
                  <div className="p-4 space-y-3">
                    <div>
                      <span className="text-sm font-medium block">自定义素材</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">导入你自己的图片或视频作为桌宠；按状态（待机 / 工作 / 自定义）绑定，右键桌宠可切换。</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={petTargetState}
                        onChange={(e) => setPetTargetState(e.target.value)}
                        className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                      >
                        {petManifest.states.map((s) => (
                          <option key={s.id} value={s.id}>{s.label || s.id}</option>
                        ))}
                        <option value="__new__">+ 新建状态…</option>
                      </select>
                      {petTargetState === '__new__' && (
                        <input
                          value={petNewState}
                          onChange={(e) => setPetNewState(e.target.value)}
                          placeholder="新状态名称"
                          className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)] w-28"
                        />
                      )}
                      <button
                        onClick={() => void handleImportPetAsset()}
                        className="btn-press px-3 py-1.5 rounded-lg bg-[var(--element-color-raw)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                      >
                        导入图片/视频
                      </button>
                    </div>
                    {petImportError && (
                      <p className="text-xs text-red-500">导入失败：{petImportError}</p>
                    )}
                    <div className="space-y-2">
                      {petManifest.states.map((s) => (
                        <div key={s.id}>
                          <div className="text-xs text-neutral-500 dark:text-stone-400 mb-1">{s.label || s.id}</div>
                          {s.assets.length === 0 ? (
                            <div className="text-xs text-neutral-400 dark:text-stone-500">暂无素材</div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {s.assets.map((a) => (
                                <div key={a.rel} className="relative group">
                                  <PetAssetThumb rel={a.rel} mime={a.mime} />
                                  <button
                                    onClick={() => removePetAsset(s.id, a.rel)}
                                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="移除"
                                  >
                                    ×
                                  </button>
                                  <div className="text-[10px] text-neutral-400 dark:text-stone-500 mt-0.5 max-w-[48px] truncate">{a.file}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* 预设方案：每个方案（manifest+设置）独立保存，可切换/重命名/删除 */}
                  <div className="p-4 space-y-3 border-t border-neutral-200/50 dark:border-stone-700/50">
                    <div>
                      <span className="text-sm font-medium block">预设方案</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">把当前素材与缩放/透明度存成一套方案，切换时浮窗自动更新；多个方案共享同一批素材。</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={activePresetId ?? ''}
                        onChange={(e) => handleSelectPreset(e.target.value)}
                        className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                      >
                        <option value="">（默认）</option>
                        {presets.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <input
                        value={newPresetName}
                        onChange={(e) => setNewPresetName(e.target.value)}
                        placeholder="方案名"
                        className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)] w-28"
                      />
                      <button
                        onClick={() => handleSavePreset()}
                        className="btn-press px-3 py-1.5 rounded-lg bg-[var(--element-color-raw)] text-white text-sm font-medium hover:opacity-90"
                      >
                        保存当前为新预设
                      </button>
                    </div>
                    {presets.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {presets.map((p) => (
                          <div key={p.id} className="flex items-center gap-1 bg-neutral-100 dark:bg-stone-700 rounded-lg px-2 py-1">
                            <span className="text-xs text-neutral-700 dark:text-stone-200">{p.name}</span>
                            {activePresetId === p.id && <span className="text-[10px] text-emerald-500">当前</span>}
                            <button
                              onClick={() => { const n = window.prompt('重命名方案', p.name); if (n) handleRenamePreset(p.id, n.trim()); }}
                              className="text-xs text-neutral-400 hover:text-amber-500"
                              title="重命名"
                            >改</button>
                            <button
                              onClick={() => handleDeletePreset(p.id)}
                              className="text-xs text-neutral-400 hover:text-red-500"
                              title="删除"
                            >删</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
              {/* 茑萝：RAG 知识库模块在侧边栏的显隐（功能仍保留，仅控制是否在「茑萝」列表展示） */}
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
                  <Puzzle size={14} />
                  茑萝
                </h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">显示 RAG 知识库模块</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">RAG 为内置功能，关闭后从「茑萝」侧边栏列表隐藏，需要时再开启。</p>
                    </div>
                    <Switch
                      checked={ragVisible}
                      onCheckedChange={(val: boolean) => toggleRagModule(val)}
                      className="data-[state=checked]:bg-[var(--element-color-raw)]"
                    />
                  </div>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'themes' && (
            <div className="space-y-6">
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">{t('settings.themes.appearance')}</h2>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { id: 'system' as const, label: t('settings.theme.system'), icon: Monitor },
                    { id: 'light' as const, label: t('settings.theme.light'), icon: Sun },
                    { id: 'dark' as const, label: t('settings.theme.dark'), icon: Moon },
                  ].map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setTheme(m.id)}
                      className={`btn-press h-16 rounded-xl border flex flex-col items-center justify-center transition-all ${
                        theme === m.id
                          ? 'element-muted border-[var(--element-border)]'
                          : 'bg-white dark:bg-stone-800/70 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-white dark:hover:bg-stone-700'
                      }`}
                    >
                      <m.icon size={18} className="mb-1.5" />
                      <span className="text-xs font-medium">{m.label}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">{t('settings.themes.nativeConfig')}</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.themeColor')}</span>
                    <select
                      value={themeColor}
                      onChange={(e) => setThemeColor(e.target.value)}
                      className={`px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]`}
                    >
                      <option value="默认">{t('color.default')}</option>
                      <option value="经典绿">{t('color.green')}</option>
                      <option value="经典蓝">{t('color.blue')}</option>
                      <option value="紫色">{t('color.purple')}</option>
                      <option value="橙色">{t('color.orange')}</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.elementColor')}</span>
                    <select
                      value={elementColor}
                      onChange={(e) => setElementColor(e.target.value)}
                      className={`px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]`}
                    >
                      <option value="默认">{t('color.default')}</option>
                      <option value="经典绿">{t('color.green')}</option>
                      <option value="经典蓝">{t('color.blue')}</option>
                      <option value="紫色">{t('color.purple')}</option>
                      <option value="橙色">{t('color.orange')}</option>
                    </select>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">{t('settings.themes.packConfig')}</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.selectPack')}</span>
                    <select
                      value={themePack}
                      onChange={(e) => setThemePack(e.target.value)}
                      className="px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                    >
                      <option value="默认">{t('color.default')}</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.reverseColor')}</span>
                    <Switch checked={reverseColor} onCheckedChange={setReverseColor} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.customBg')}</span>
                    <div className="flex items-center gap-2">
                      {bgImage && (
                        <button
                          onClick={() => setBgImage(null)}
                          className="btn-press px-3 py-1.5 rounded-lg border border-red-200/50 dark:border-red-500/30 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                        >
                          {t('settings.themes.customBgRemove')}
                        </button>
                      )}
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="btn-press px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
                      >
                        {bgImage ? t('settings.themes.changeImage') : t('settings.themes.selectImage')}
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) setBgEditorSrc(URL.createObjectURL(f));
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>
                  {bgImage && (
                    <div className="px-4 py-3">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.customBgBlur')}</span>
                        <span className="text-xs text-neutral-500 dark:text-stone-400">{bgBlur}px</span>
                      </div>
                      <Slider
                        value={[bgBlur]}
                        onValueChange={([v]: number[]) => setBgBlur(v)}
                        min={0}
                        max={40}
                        step={1}
                      />
                    </div>
                  )}
                </div>
              </section>

              {bgEditorSrc && (
                <BackgroundImageEditor
                  src={bgEditorSrc}
                  onCancel={() => {
                    URL.revokeObjectURL(bgEditorSrc);
                    setBgEditorSrc(null);
                  }}
                  onDone={(dataUrl, angle, flip) => {
                    setBgImage(dataUrl);
                    setBgAngle(angle);
                    setBgFlip(flip);
                    URL.revokeObjectURL(bgEditorSrc);
                    setBgEditorSrc(null);
                  }}
                />
              )}

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">{t('settings.themes.display')}</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.bodyFont')}</span>
                    <div className="relative font-dropdown">
                      <button
                        onClick={() => { setFontDropdownOpen(!fontDropdownOpen); setFontSearch(''); }}
                        className="btn-press flex items-center gap-2 px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-600/50 transition-colors w-56 justify-between"
                      >
                        <span className="truncate">{fontsLoading ? t('settings.themes.detecting') : currentFontDisplay}</span>
                        <ChevronDown size={14} className={`transition-transform ${fontDropdownOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {fontDropdownOpen && (
                        <div className="absolute right-0 top-full mt-1 w-64 bg-white dark:bg-stone-700 border border-neutral-200/50 dark:border-stone-600/50 rounded-xl shadow-lg z-50 overflow-hidden">
                          {/* 搜索框 */}
                          <div className="p-2 border-b border-neutral-200/50 dark:border-stone-600/50">
                            <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-neutral-50 dark:bg-stone-600/50">
                              <Search size={14} className="text-neutral-400 dark:text-stone-500 shrink-0" />
                              <input
                                type="text"
                                placeholder={t('settings.themes.searchFont')}
                                value={fontSearch}
                                onChange={(e) => setFontSearch(e.target.value)}
                                className="flex-1 bg-transparent text-sm text-neutral-700 dark:text-stone-200 outline-none placeholder:text-neutral-400 dark:placeholder:text-stone-500"
                                autoFocus
                              />
                            </div>
                          </div>
                          {/* 字体列表 */}
                          <div className="max-h-64 overflow-y-auto">
                            {/* 系统默认 */}
                            <button
                              onClick={() => { setFontFamily('系统默认'); setFontDropdownOpen(false); }}
                              className={`w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-neutral-50 dark:hover:bg-stone-600/50 transition-colors ${
                                fontFamily === '系统默认' ? 'bg-[var(--element-muted)] text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300'
                              }`}
                            >
                              <span>{t('settings.themes.systemDefault')}</span>
                              <span className="text-xs text-neutral-400 dark:text-stone-500">{t('settings.themes.followSystem')}</span>
                            </button>
                            {fontsLoading ? (
                              <div className="px-4 py-6 text-center text-sm text-neutral-400 dark:text-stone-500">{t('settings.themes.detectingFonts')}</div>
                            ) : filteredFonts.length === 0 ? (
                              <div className="px-4 py-6 text-center text-sm text-neutral-400 dark:text-stone-500">{t('settings.themes.noFont')}</div>
                            ) : (
                              filteredFonts.map((font) => (
                                <button
                                  key={font.family}
                                  onClick={() => { setFontFamily(font.family); setFontDropdownOpen(false); }}
                                  className={`w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-neutral-50 dark:hover:bg-stone-600/50 transition-colors ${
                                    fontFamily === font.family ? 'bg-[var(--element-muted)] text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300'
                                  }`}
                                >
                                  <span className="truncate" style={{ fontFamily: font.family !== '系统默认' ? `"${font.family}", sans-serif` : undefined }}>{font.displayName}</span>
                                  {font.isChinese && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--element-muted)] text-[var(--element-bg)] shrink-0 ml-2">{t('settings.themes.cn')}</span>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.themes.panelOpacity')}</span>
                      <span className="text-xs text-neutral-500 dark:text-stone-400">{panelOpacity}%</span>
                    </div>
                    <Slider
                      value={[panelOpacity]}
                      onValueChange={([v]: number[]) => setPanelOpacity(v)}
                      max={100}
                      min={20}
                      step={5}
                      className="slider-themed"
                    />
                  </div>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'extensions' && (
            <div className="space-y-6">
              <ExtensionManagerPanel />
            </div>
          )}

          {activeTab === 'transfer' && (
            <div className="space-y-6">
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
                  <Archive size={14} />
                  {t('settings.transfer.archiveTitle')}
                </h2>
                <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
                  {t('settings.transfer.archiveDesc')}
                </p>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden">
                  {archiveLoading ? (
                    <div className="p-6 text-center text-sm text-neutral-400 dark:text-stone-500">{t('common.loading')}</div>
                  ) : archives.length === 0 ? (
                    <div className="p-6 text-center text-sm text-neutral-400 dark:text-stone-500">
                      <Archive size={24} className="mx-auto mb-2 text-neutral-300 dark:text-stone-500" />
                      {t('settings.transfer.noArchive')}
                      <p className="text-xs mt-1 text-neutral-300 dark:text-stone-500">{t('settings.transfer.noArchiveDesc')}</p>
                    </div>
                  ) : (
                    <>
                      <div className="px-4 py-2 bg-neutral-50/50 dark:bg-stone-700/50 text-xs font-medium text-neutral-500 dark:text-stone-400 flex items-center justify-between">
                        <span>{t('settings.transfer.snapshotCount', { count: archives.length })}</span>
                        <button
                          onClick={() => {
                            if (confirm(t('settings.transfer.confirmClear'))) {
                              api.clearArchives()
                                .then(() => loadArchives())
                                .catch(err => logger.transferStation.clearFailed(err));
                            }
                          }}
                          className="btn-press text-xs text-red-400 hover:text-red-500 transition-colors"
                        >
                          {t('settings.transfer.clearArchive')}
                        </button>
                      </div>
                      <div className="divide-y divide-neutral-200/50 dark:divide-stone-700/50 max-h-[60vh] overflow-y-auto">
                        {archives.map((a) => (
                          <div key={a.id} className="flex items-center justify-between p-4 hover:bg-neutral-50 dark:hover:bg-neutral-700/30 transition-colors">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-8 h-8 rounded-lg element-muted flex items-center justify-center flex-shrink-0">
                                {a.kind === 'image' ? <File size={16} /> : <FileText size={16} />}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">{a.name}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--element-muted)] text-[var(--element-bg)] flex-shrink-0">{t('kind.' + a.kind)}</span>
                                </div>
                                <div className="text-xs text-neutral-400 dark:text-stone-500 flex items-center gap-2">
                                  <span>{formatArchiveTime(a.modified)}</span>
                                  <span>{(a.size / 1024).toFixed(1)} KB</span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => {
                                  api.restoreArchive(a.id)
                                    .then(() => {
                                      alert(t('settings.transfer.restored', { name: a.name }));
                                      loadArchives();
                                    })
                                    .catch(err => alert(t('settings.transfer.restoreFailed', { err: String(err) })));
                                }}
                                className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                                title={t('settings.transfer.restore')}
                              >
                                <Undo2 size={16} />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(t('settings.transfer.confirmDelete', { name: a.name }))) {
                                    api.deleteArchive(a.id)
                                      .then(() => loadArchives())
                                      .catch(err => logger.transferStation.deleteFailed(a.name, err));
                                  }
                                }}
                                className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                title={t('settings.transfer.delete')}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeTab === 'model' && (
            <ModelSettings />
          )}

          {activeTab === 'blacklist' && (
            <BlacklistManager />
          )}

          {activeTab === 'about' && (
            <div className="space-y-6">
              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-6">
                <div className="flex items-center gap-3 mb-4">
                  <Info size={24} className="text-[var(--element-bg)]" />
                  <h2 className="text-xl font-bold text-neutral-800 dark:text-stone-100">{t('settings.about.title')}</h2>
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-neutral-600 dark:text-stone-300">安得云荟</p>
                  <p className="text-neutral-500 dark:text-stone-400">{t('settings.about.version', { v: '2.2.0' })}</p>
                  <p className="text-neutral-500 dark:text-stone-400">{t('settings.about.author')}</p>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-6">
                <div className="flex items-center gap-3 mb-3">
                  <Eye size={20} className="text-[var(--element-bg)]" />
                  <h2 className="text-lg font-bold text-neutral-800 dark:text-stone-100">{t('settings.about.previewBoot')}</h2>
                </div>
                <p className="text-sm text-neutral-500 dark:text-stone-400 mb-4">
                  {t('settings.about.previewDesc')}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => previewBootScreen('light')}
                    className="btn-press h-16 rounded-xl border flex flex-col items-center justify-center transition-all bg-white dark:bg-stone-800/70 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700"
                  >
                    <Sun size={18} className="mb-1.5" />
                    <span className="text-xs font-medium">{t('settings.theme.light')}</span>
                  </button>
                  <button
                    onClick={() => previewBootScreen('dark')}
                    className="btn-press h-16 rounded-xl border flex flex-col items-center justify-center transition-all bg-white dark:bg-stone-800/70 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700"
                  >
                    <Moon size={18} className="mb-1.5" />
                    <span className="text-xs font-medium">{t('settings.theme.dark')}</span>
                  </button>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                <div className="flex justify-between items-center p-4">
                  <div className="flex items-center gap-2">
                    <ExternalLink size={16} className="text-neutral-400 dark:text-stone-500" />
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.about.githubRelease')}</span>
                  </div>
                  <button
                    className="px-3 py-1.5 rounded-lg bg-neutral-800 text-white text-sm hover:bg-neutral-700 transition-colors"
                    onClick={() => { openUrl('https://github.com/lilyrosary-eng/andeyunhui').catch(() => {}); }}
                  >
                    {t('settings.about.checkUpdate')}
                  </button>
                </div>
                <div className="flex justify-between items-center p-4">
                  <div className="flex items-center gap-2">
                    <ExternalLink size={16} className="text-neutral-400 dark:text-stone-500" />
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.about.officialRelease')}</span>
                  </div>
                  <button
                    className="px-3 py-1.5 rounded-lg bg-neutral-800 text-white text-sm hover:bg-neutral-700 transition-colors"
                    onClick={() => { openUrl('https://adyh.cc.cd').catch(() => {}); }}
                  >
                    {t('settings.about.open')}
                  </button>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                <div className="flex justify-between items-center p-4">
                  <div className="flex items-center gap-2">
                    <Database size={16} className="text-neutral-400 dark:text-stone-500" />
                    <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.about.dataBackup')}</span>
                  </div>
                  <button className="px-3 py-1.5 rounded-lg element-primary text-sm hover:bg-[var(--element-hover)] transition-colors" onClick={async () => {
                    try {
                      const { save } = await import('@tauri-apps/plugin-dialog');
                      const path = await save({
                        defaultPath: 'notes_backup.zip',
                        filters: [{ name: t('settings.about.backupName'), extensions: ['zip'] }],
                      });
                      if (path) {
                        await invoke('export_backup', { path });
                        alert(t('settings.about.exportSuccess'));
                      }
                    } catch (e) {
                      logger.export.failed(e);
                      alert(t('settings.about.exportFailed'));
                    }
                  }}>
                    {t('settings.about.exportBackup')}
                  </button>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                <div className="flex justify-between items-center p-4">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={16} className="text-neutral-400 dark:text-stone-500" />
                    <div>
                      <span className="text-sm text-neutral-600 dark:text-stone-300">{t('settings.about.errorLog')}</span>
                      <p className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">{t('settings.about.errorLogDesc')}</p>
                    </div>
                  </div>
                  <button
                    className="px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-stone-700 text-neutral-600 dark:text-stone-300 text-sm hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors"
                    onClick={() => invoke('open_log_dir').catch(() => {})}
                  >
                    {t('settings.about.openFolder')}
                  </button>
                </div>
              </section>

              {/* 开发者控制台：命令行 REPL，热指令+危险过滤+联网 */}
              <DevConsole />


            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default GlobalSettingsPanel;