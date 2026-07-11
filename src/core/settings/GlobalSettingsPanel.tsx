import { useState, useEffect, useCallback } from 'react';
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Settings, Palette, Puzzle, Sun, Moon, Monitor, Keyboard, Info, ExternalLink, Database, Archive, FileText, File, Undo2, Trash2, ChevronDown, ChevronUp, RotateCcw, Search, Ban, Eye } from 'lucide-react'
import { ExtensionManagerPanel } from '@/core/settings/ExtensionManagerPanel'
import { BlacklistManager } from '@/core/settings/BlacklistManager'
import { invoke } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';
import { api, type ArchiveEntry } from '@/lib/api';
import { useTheme } from '@/lib/ThemeProvider';
import { useSystemFonts } from '@/lib/useSystemFonts';
import { previewBootScreen } from '@/lib/bootPreview';

type TabId = 'general' | 'themes' | 'extensions' | 'transfer' | 'blacklist' | 'about';

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

function kindLabel(kind: string): string {
  if (kind === 'note') return '笔记';
  if (kind === 'image') return '图片';
  if (kind === 'file') return '文件';
  return kind;
}

// 存档 modified 形如 "YYYYMMDD_HHMMSS" → "YYYY-MM-DD HH:MM:SS"
function formatArchiveTime(modified: string): string {
  const m = modified.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return modified;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

export function GlobalSettingsPanel() {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const { theme, setTheme, themeColor, setThemeColor, elementColor, setElementColor, reverseColor, setReverseColor, zoom, setZoom, panelOpacity, setPanelOpacity, fontFamily, setFontFamily } = useTheme();
  const [autoSave, setAutoSave] = useState(true);
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

  // 启动时从 Rust 读取实际生效的截图热键，与设置面板展示同步（设置改键会真正注册）
  useEffect(() => {
    invoke<string>('get_screenshot_shortcut')
      .then((sc) => {
        const display = normalizeForDisplay(sc);
        setShortcuts((prev) => {
          const updated = prev.map((s) =>
            s.id === 'screenshot' ? { ...s, keys: display } : s,
          );
          // 把 Rust 权威值写回 localStorage，避免刷新时与后端不一致导致「变回默认」
          saveShortcuts(updated);
          return updated;
        });
      })
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
        // 截图热键：真正注册到系统（解析失败则忽略，保留本地展示）
        if (editingShortcutId === 'screenshot') {
          invoke('set_screenshot_shortcut', { shortcut }).catch((err) => {
            console.error('[截图] 设置热键失败:', err);
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
    // 重置时把截图热键恢复为默认并重新注册
    const sc = DEFAULT_SHORTCUTS.find((s) => s.id === 'screenshot');
    if (sc) invoke('set_screenshot_shortcut', { shortcut: sc.keys }).catch(() => {});
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

  const tabs = [
    { id: 'general' as const, label: '常规', icon: Settings },
    { id: 'themes' as const, label: '主题', icon: Palette },
    { id: 'extensions' as const, label: '茑萝', icon: Puzzle },
    { id: 'transfer' as const, label: '中转', icon: Archive },
    { id: 'blacklist' as const, label: '黑名单', icon: Ban },
    { id: 'about' as const, label: '关于', icon: Info },
  ];

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="flex items-center gap-1 mb-8 bg-white dark:bg-stone-700/60 backdrop-blur border border-white/80 dark:border-stone-700/50 rounded-xl p-1 w-fit">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`btn-press flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm'
                    : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200'
                }`}
              >
                <tab.icon size={14} />
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'general' && (
            <div className="space-y-6">
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">缩放</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-4">
                  <div className="flex justify-between items-center text-sm font-medium mb-3">
                    <span>UI 缩放级别</span>
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
                  快捷键配置
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
                      快捷键列表 ({shortcuts.length})
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleResetShortcuts(); }}
                        className="btn-press p-1 rounded-md text-neutral-400 dark:text-stone-500 hover:text-amber-500 transition-colors"
                        title="恢复默认"
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
                          <span className="text-sm text-neutral-600 dark:text-stone-300">{shortcut.label}</span>
                          {editingShortcutId === shortcut.id ? (
                            <kbd className="px-3 py-1 rounded-md bg-[var(--element-muted)] text-xs font-medium text-[var(--element-bg)] animate-pulse">
                              请按键...
                            </kbd>
                          ) : (
                            <button
                              onClick={() => handleStartEditShortcut(shortcut.id)}
                              className="btn-press px-3 py-1 rounded-md bg-neutral-100 dark:bg-stone-700 text-xs font-medium text-neutral-500 dark:text-stone-400 hover:bg-[var(--element-muted)] hover:text-[var(--element-bg)] transition-colors cursor-pointer"
                              title="点击修改快捷键"
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
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">通用</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">最小化回托盘</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">关闭窗口时隐藏到系统托盘，而非退出程序</p>
                    </div>
                    <Switch
                      checked={trayMode}
                      onCheckedChange={(val: boolean) => {
                        setTrayMode(val);
                        invoke('toggle_tray_mode', { enabled: val }).catch(() => {});
                      }}
                      className="data-[state=checked]:bg-[var(--element-bg)]"
                    />
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <div>
                      <span className="text-sm font-medium block">自动保存</span>
                      <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">检测到更改后自动备份原文件并保存到中转站</p>
                    </div>
                    <Switch checked={autoSave} onCheckedChange={(val: boolean) => {
                      setAutoSave(val);
                      syncAutoSave(val, autoSaveInterval[0]);
                    }} className="data-[state=checked]:bg-[var(--element-bg)]" />
                  </div>
                  {autoSave && (
                    <div className="p-4">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-sm text-neutral-600 dark:text-stone-300">保存间隔（秒）</span>
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
            </div>
          )}

          {activeTab === 'themes' && (
            <div className="space-y-6">
              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">外观</h2>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { id: 'system' as const, label: '跟随系统', icon: Monitor },
                    { id: 'light' as const, label: '浅色', icon: Sun },
                    { id: 'dark' as const, label: '深色', icon: Moon },
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
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">原生主题配置</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">主题配色</span>
                    <select
                      value={themeColor}
                      onChange={(e) => setThemeColor(e.target.value)}
                      className={`px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]`}
                    >
                      <option value="默认">默认</option>
                      <option value="经典绿">经典绿</option>
                      <option value="经典蓝">经典蓝</option>
                      <option value="紫色">紫色</option>
                      <option value="橙色">橙色</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">元素配色</span>
                    <select
                      value={elementColor}
                      onChange={(e) => setElementColor(e.target.value)}
                      className={`px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]`}
                    >
                      <option value="经典绿">经典绿</option>
                      <option value="经典蓝">经典蓝</option>
                      <option value="紫色">紫色</option>
                      <option value="橙色">橙色</option>
                    </select>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">主题包配置</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">选择主题包</span>
                    <select
                      value={themePack}
                      onChange={(e) => setThemePack(e.target.value)}
                      className="px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                    >
                      <option value="默认">默认</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">反转元素配色</span>
                    <Switch checked={reverseColor} onCheckedChange={setReverseColor} className="data-[state=checked]:bg-[var(--element-bg)]" />
                  </div>
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">自定义背景图</span>
                    <button className="btn-press px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors">
                      选择图片
                    </button>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">显示设置</h2>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-sm text-neutral-600 dark:text-stone-300">正文字体</span>
                    <div className="relative font-dropdown">
                      <button
                        onClick={() => { setFontDropdownOpen(!fontDropdownOpen); setFontSearch(''); }}
                        className="btn-press flex items-center gap-2 px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-600/50 transition-colors min-w-[140px] justify-between"
                      >
                        <span className="truncate">{fontsLoading ? '检测中...' : currentFontDisplay}</span>
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
                                placeholder="搜索字体..."
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
                              <span>系统默认</span>
                              <span className="text-xs text-neutral-400 dark:text-stone-500">跟随系统</span>
                            </button>
                            {fontsLoading ? (
                              <div className="px-4 py-6 text-center text-sm text-neutral-400 dark:text-stone-500">正在检测系统字体...</div>
                            ) : filteredFonts.length === 0 ? (
                              <div className="px-4 py-6 text-center text-sm text-neutral-400 dark:text-stone-500">无匹配字体</div>
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
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--element-muted)] text-[var(--element-bg)] shrink-0 ml-2">中</span>
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
                      <span className="text-sm text-neutral-600 dark:text-stone-300">面板透明度</span>
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
                  存档（笔记 / 文件 / 图片）
                </h2>
                <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
                  任何内容变动（编辑笔记、拖入文件）都会立即生成快照，且每个来源只保留最新一份，可随时恢复或删除。
                </p>
                <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden">
                  {archiveLoading ? (
                    <div className="p-6 text-center text-sm text-neutral-400 dark:text-stone-500">加载中...</div>
                  ) : archives.length === 0 ? (
                    <div className="p-6 text-center text-sm text-neutral-400 dark:text-stone-500">
                      <Archive size={24} className="mx-auto mb-2 text-neutral-300 dark:text-stone-500" />
                      暂无存档
                      <p className="text-xs mt-1 text-neutral-300 dark:text-stone-500">编辑或导入内容后会自动生成快照</p>
                    </div>
                  ) : (
                    <>
                      <div className="px-4 py-2 bg-neutral-50/50 dark:bg-stone-700/50 text-xs font-medium text-neutral-500 dark:text-stone-400 flex items-center justify-between">
                        <span>共 {archives.length} 个快照</span>
                        <button
                          onClick={() => {
                            if (confirm('确定清空所有存档快照？此操作不可恢复。')) {
                              api.clearArchives()
                                .then(() => loadArchives())
                                .catch(err => logger.transferStation.clearFailed(err));
                            }
                          }}
                          className="btn-press text-xs text-red-400 hover:text-red-500 transition-colors"
                        >
                          清空存档
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
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--element-muted)] text-[var(--element-bg)] flex-shrink-0">{kindLabel(a.kind)}</span>
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
                                      alert('已恢复：' + a.name);
                                      loadArchives();
                                    })
                                    .catch(err => alert('恢复失败：' + String(err)));
                                }}
                                className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                                title="恢复"
                              >
                                <Undo2 size={16} />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`确定删除存档「${a.name}」？`)) {
                                    api.deleteArchive(a.id)
                                      .then(() => loadArchives())
                                      .catch(err => logger.transferStation.deleteFailed(a.name, err));
                                  }
                                }}
                                className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                title="删除"
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

          {activeTab === 'blacklist' && (
            <BlacklistManager />
          )}

          {activeTab === 'about' && (
            <div className="space-y-6">
              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-6">
                <div className="flex items-center gap-3 mb-4">
                  <Info size={24} className="text-[var(--element-bg)]" />
                  <h2 className="text-xl font-bold text-neutral-800 dark:text-stone-100">关于软件</h2>
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-neutral-600 dark:text-stone-300">岸灯鸢花</p>
                  <p className="text-neutral-500 dark:text-stone-400">版本: 2.0</p>
                  <p className="text-neutral-500 dark:text-stone-400">作者: Rosary · 感谢你的使用</p>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-6">
                <div className="flex items-center gap-3 mb-3">
                  <Eye size={20} className="text-[var(--element-bg)]" />
                  <h2 className="text-lg font-bold text-neutral-800 dark:text-stone-100">预览加载界面</h2>
                </div>
                <p className="text-sm text-neutral-500 dark:text-stone-400 mb-4">
                  选择主题即可全屏预览启动加载动画与进度条效果，点击「返回」或按 Esc 退出。
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => previewBootScreen('light')}
                    className="btn-press h-16 rounded-xl border flex flex-col items-center justify-center transition-all bg-white dark:bg-stone-800/70 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700"
                  >
                    <Sun size={18} className="mb-1.5" />
                    <span className="text-xs font-medium">浅色</span>
                  </button>
                  <button
                    onClick={() => previewBootScreen('dark')}
                    className="btn-press h-16 rounded-xl border flex flex-col items-center justify-center transition-all bg-white dark:bg-stone-800/70 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700"
                  >
                    <Moon size={18} className="mb-1.5" />
                    <span className="text-xs font-medium">深色</span>
                  </button>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                <div className="flex justify-between items-center p-4">
                  <div className="flex items-center gap-2">
                    <ExternalLink size={16} className="text-neutral-400 dark:text-stone-500" />
                    <span className="text-sm text-neutral-600 dark:text-stone-300">前往 GitHub 发布页</span>
                  </div>
                  <button className="px-3 py-1.5 rounded-lg bg-neutral-800 text-white text-sm hover:bg-neutral-700 transition-colors">
                    检查更新
                  </button>
                </div>
              </section>

              <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
                <div className="flex justify-between items-center p-4">
                  <div className="flex items-center gap-2">
                    <Database size={16} className="text-neutral-400 dark:text-stone-500" />
                    <span className="text-sm text-neutral-600 dark:text-stone-300">数据备份</span>
                  </div>
                  <button className="px-3 py-1.5 rounded-lg element-primary text-sm hover:bg-[var(--element-hover)] transition-colors" onClick={async () => {
                    try {
                      const { save } = await import('@tauri-apps/plugin-dialog');
                      const path = await save({
                        defaultPath: 'notes_backup.zip',
                        filters: [{ name: '备份', extensions: ['zip'] }],
                      });
                      if (path) {
                        await invoke('export_backup', { path });
                        alert('备份导出成功！');
                      }
                    } catch (e) {
                      logger.export.failed(e);
                      alert('导出失败，请重试');
                    }
                  }}>
                    导出备份
                  </button>
                </div>
              </section>

              
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default GlobalSettingsPanel;