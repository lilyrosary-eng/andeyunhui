import { useState, useEffect } from 'react';
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { invoke } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';
import { useAppStore } from '@/stores/appStore';

export function NoteSettingsPanel() {
  const wordWrap = useAppStore(s => s.wordWrap);
  const onWordWrapChange = useAppStore(s => s.setWordWrap);
  const vimMode = useAppStore(s => s.vimMode);
  const onVimModeChange = useAppStore(s => s.setVimMode);
  const [autoSave, setAutoSave] = useState(true);
  const [autoSaveInterval, setAutoSaveInterval] = useState([30]);

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
    <div className="max-w-4xl mx-auto w-full h-full flex flex-col gap-6 pt-8 px-4 overflow-y-auto">
      <h1 className="text-2xl font-bold tracking-tight text-neutral-800 dark:text-stone-100">笔记设置</h1>
      
      <div className="space-y-2">
        <div className="bg-white/70 backdrop-blur rounded-xl border border-white/80 p-4 flex flex-col gap-3 dark:bg-stone-800/60 dark:border-stone-600/50">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-sm font-medium block">自动保存</span>
              <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">停止输入 1 秒后自动保存</p>
            </div>
            <Switch checked={autoSave} onCheckedChange={(val: boolean) => {
              setAutoSave(val);
              syncAutoSave(val, autoSaveInterval[0]);
            }} className="data-[state=checked]:bg-[var(--element-bg)]" />
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

        <div className="bg-white/70 backdrop-blur rounded-xl border border-white/80 p-4 flex justify-between items-center dark:bg-stone-800/60 dark:border-stone-600/50">
          <div>
            <span className="text-sm font-medium block">Vim 模式</span>
            <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">在代码编辑器中启用 Vim 键盘绑定</p>
          </div>
          <Switch checked={vimMode} onCheckedChange={(v) => onVimModeChange(v)} className="data-[state=checked]:bg-[var(--element-bg)]" />
        </div>

        <div className="bg-white/70 backdrop-blur rounded-xl border border-white/80 p-4 flex justify-between items-center dark:bg-stone-800/60 dark:border-stone-600/50">
          <div>
            <span className="text-sm font-medium block">自动换行</span>
            <p className="text-xs text-neutral-500 dark:text-stone-500 mt-0.5">长行自动换行，无需横向滚动</p>
          </div>
          <Switch checked={wordWrap} onCheckedChange={onWordWrapChange} className="data-[state=checked]:bg-[var(--element-bg)]" />
        </div>
      </div>
    </div>
  )
}

export default NoteSettingsPanel;