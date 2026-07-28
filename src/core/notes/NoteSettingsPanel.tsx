import { useState, useEffect } from 'react';
import { StickyNote, Sparkles } from 'lucide-react';
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { invoke } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';
import { useAppStore } from '@/stores/appStore';
import { ModuleSettingsPanel } from '@/components/ModuleSettingsPanel';
import { useI18n } from '@/lib/i18n';

// AI 润色选项（key 与 NotesEditor 的 localStorage / prompt 映射保持一致，labelKey 走 i18n）
const POLISH_STYLE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'keep', labelKey: 'noteSettings.polishStyle.keep' },
  { value: 'concise', labelKey: 'noteSettings.polishStyle.concise' },
  { value: 'formal', labelKey: 'noteSettings.polishStyle.formal' },
  { value: 'vivid', labelKey: 'noteSettings.polishStyle.vivid' },
  { value: 'casual', labelKey: 'noteSettings.polishStyle.casual' },
  { value: 'professional', labelKey: 'noteSettings.polishStyle.professional' },
];
const POLISH_LENGTH_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'shorter', labelKey: 'noteSettings.polishLength.shorter' },
  { value: 'keep', labelKey: 'noteSettings.polishLength.keep' },
  { value: 'longer', labelKey: 'noteSettings.polishLength.longer' },
];

export function NoteSettingsPanel() {
  const { t } = useI18n();
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
      title={t('notes.moduleTitle')}
      icon={<StickyNote size={20} />}
      onClose={toggleNoteSettings}
    >
      {/* 自动保存 */}
      <div className="glass-panel p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <div>
            <span className="text-sm font-medium block">{t('noteSettings.autoSave')}</span>
            <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">{t('noteSettings.autoSaveDesc')}</p>
          </div>
          <Switch checked={autoSave} onCheckedChange={(val: boolean) => {
            setAutoSave(val);
            syncAutoSave(val, autoSaveInterval[0]);
          }} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
        </div>
        {autoSave && (
          <div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-neutral-600 dark:text-stone-300">{t('noteSettings.saveInterval')}</span>
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
            <span className="text-sm font-medium block">{t('noteSettings.aiPolish')}</span>
            <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">{t('noteSettings.aiPolishDesc')}</p>
          </div>
        </div>
        {/* 润色风格 */}
        <div>
          <span className="text-sm text-neutral-600 dark:text-stone-300 block mb-2">{t('noteSettings.polishStyleLabel')}</span>
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
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
        {/* 篇幅长短 */}
        <div>
          <span className="text-sm text-neutral-600 dark:text-stone-300 block mb-2">{t('noteSettings.polishLengthLabel')}</span>
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
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Vim 模式 */}
      <div className="glass-panel p-4 flex justify-between items-center">
        <div>
          <span className="text-sm font-medium block">{t('noteSettings.vimMode')}</span>
          <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">{t('noteSettings.vimModeDesc')}</p>
        </div>
        <Switch checked={vimMode} onCheckedChange={(v) => onVimModeChange(v)} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
      </div>

      {/* 自动换行 */}
      <div className="glass-panel p-4 flex justify-between items-center">
        <div>
          <span className="text-sm font-medium block">{t('noteSettings.wordWrap')}</span>
          <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">{t('noteSettings.wordWrapDesc')}</p>
        </div>
        <Switch checked={wordWrap} onCheckedChange={onWordWrapChange} className="data-[state=checked]:bg-[var(--element-color-raw)]" />
      </div>
    </ModuleSettingsPanel>
  )
}

export default NoteSettingsPanel;
