import { useState, useEffect } from 'react';
import { StickyNote, Sparkles } from 'lucide-react';
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { invoke } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';
import { useAppStore } from '@/stores/appStore';
import { ModuleSettingsPanel } from '@/components/ModuleSettingsPanel';

// AI 润色选项（key 与 NotesEditor 的 localStorage / prompt 映射保持一致）
const POLISH_STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'keep', label: '保持原风格' },
  { value: 'concise', label: '简洁' },
  { value: 'formal', label: '正式' },
  { value: 'vivid', label: '生动' },
  { value: 'casual', label: '口语化' },
  { value: 'professional', label: '专业' },
];
const POLISH_LENGTH_OPTIONS: { value: string; label: string }[] = [
  { value: 'shorter', label: '更精简' },
  { value: 'keep', label: '保持篇幅' },
  { value: 'longer', label: '更详细' },
];

export function NoteSettingsPanel() {
  const wordWrap = useAppStore(s => s.wordWrap);
  const onWordWrapChange = useAppStore(s => s.setWordWrap);
  const vimMode = useAppStore(s => s.vimMode);
  const onVimModeChange = useAppStore(s => s.setVimMode);
  const toggleNoteSettings = useAppStore(s => s.toggleNoteSettings);
  const [autoSave, setAutoSave] = useState(true);
  const [autoSaveInterval, setAutoSaveInterval] = useState([30]);

  // AI 润色偏好（持久化到 localStorage，NotesEditor 点击润色时读取）
  const [polishStyle, setPolishStyle] = useState(() => localStorage.getItem('ai_polish_style') || 'keep');
  const [polishLength, setPolishLength] = useState(() => localStorage.getItem('ai_polish_length') || 'keep');

  const handlePolishStyle = (v: string) => {
    setPolishStyle(v);
    localStorage.setItem('ai_polish_style', v);
  };
  const handlePolishLength = (v: string) => {
    setPolishLength(v);
    localStorage.setItem('ai_polish_length', v);
  };

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

  const syncAutoSave = (enabled: boolean, interval: number) => {
    invoke('configure_auto_save', { enabled, intervalSecs: interval }).catch((err) => {
      logger.autoSave.syncFailed(err);
    });
  };

  return (
    <ModuleSettingsPanel
      title="鸢尾花"
      icon={<StickyNote size={20} />}
      onClose={toggleNoteSettings}
    >
      {/* 自动保存 */}
      <div className="glass-panel p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <div>
            <span className="text-sm font-medium block">自动保存</span>
            <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">停止输入 1 秒后自动保存</p>
          </div>
          <Switch checked={autoSave} onCheckedChange={(val: boolean) => {
            setAutoSave(val);
            syncAutoSave(val, autoSaveInterval[0]);
          }} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
        </div>
        {autoSave && (
          <div>
            <div className="flex justify-between items-center mb-2">
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

      {/* AI 润色 */}
      <div className="glass-panel p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-[var(--element-color-raw)]" />
          <div>
            <span className="text-sm font-medium block">AI 润色</span>
            <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">工具栏「AI 润色」按钮会按下方偏好，调用全局 AI 润色选中文字</p>
          </div>
        </div>
        {/* 润色风格 */}
        <div>
          <span className="text-sm text-neutral-600 dark:text-stone-300 block mb-2">润色风格</span>
          <div className="flex flex-wrap gap-1.5">
            {POLISH_STYLE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handlePolishStyle(opt.value)}
                className={`btn-press px-3 py-1 rounded-lg text-xs transition-all ${
                  polishStyle === opt.value
                    ? 'bg-[var(--element-bg)] text-white shadow-sm'
                    : 'bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-stone-300 hover:bg-black/10 dark:hover:bg-white/10'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {/* 篇幅长短 */}
        <div>
          <span className="text-sm text-neutral-600 dark:text-stone-300 block mb-2">篇幅长短</span>
          <div className="flex flex-wrap gap-1.5">
            {POLISH_LENGTH_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handlePolishLength(opt.value)}
                className={`btn-press px-3 py-1 rounded-lg text-xs transition-all ${
                  polishLength === opt.value
                    ? 'bg-[var(--element-bg)] text-white shadow-sm'
                    : 'bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-stone-300 hover:bg-black/10 dark:hover:bg-white/10'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Vim 模式 */}
      <div className="glass-panel p-4 flex justify-between items-center">
        <div>
          <span className="text-sm font-medium block">Vim 模式</span>
          <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">在代码编辑器中启用 Vim 键盘绑定</p>
        </div>
        <Switch checked={vimMode} onCheckedChange={(v) => onVimModeChange(v)} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
      </div>

      {/* 自动换行 */}
      <div className="glass-panel p-4 flex justify-between items-center">
        <div>
          <span className="text-sm font-medium block">自动换行</span>
          <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">长行自动换行，无需横向滚动</p>
        </div>
        <Switch checked={wordWrap} onCheckedChange={onWordWrapChange} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
      </div>
    </ModuleSettingsPanel>
  )
}

export default NoteSettingsPanel;
