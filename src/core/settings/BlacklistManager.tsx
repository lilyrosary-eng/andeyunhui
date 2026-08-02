import { useState, useEffect, useCallback } from 'react';
import { ShieldOff, RotateCcw, Image, Music2, Video, Ban } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface BlacklistEntry {
  path: string;
  module: string;
  display_name: string;
  blocked_at: string;
}

import { useI18n } from '@/lib/i18n';

const MODULE_LABELS: Record<string, { labelKey: string; icon: typeof Image }> = {
  image: { labelKey: 'module.image', icon: Image },
  music: { labelKey: 'module.music', icon: Music2 },
  video: { labelKey: 'module.video', icon: Video },
};

export function BlacklistManager() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadEntries = useCallback(() => {
    setLoading(true);
    invoke<BlacklistEntry[]>('get_all_blacklist')
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const handleRemove = useCallback(async (entry: BlacklistEntry) => {
    try {
      await invoke('remove_from_blacklist', { module: entry.module, path: entry.path });
      setEntries(prev => prev.filter(e => !(e.path === entry.path && e.module === entry.module)));
    } catch (e) {
      console.error('移除黑名单失败:', e);
    }
  }, []);

  const handleClearModule = useCallback(async (module: string) => {
    const moduleEntries = entries.filter(e => e.module === module);
    for (const entry of moduleEntries) {
      try {
        await invoke('remove_from_blacklist', { module: entry.module, path: entry.path });
      } catch { /* 忽略移除失败 */ }
    }
    setEntries(prev => prev.filter(e => e.module !== module));
  }, [entries]);

  // 按模块分组
  const grouped = entries.reduce((acc, entry) => {
    if (!acc[entry.module]) acc[entry.module] = [];
    acc[entry.module].push(entry);
    return acc;
  }, {} as Record<string, BlacklistEntry[]>);

  const groupedModules = Object.entries(grouped);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
          <Ban size={14} />
          {t('blacklist.title')}
        </h2>
        <p className="text-xs text-neutral-400 dark:text-stone-500 mb-4">
          {t('blacklist.desc')}
        </p>

        {loading ? (
          <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-6 text-center text-sm text-neutral-400 dark:text-stone-500">
            {t('common.loading')}
          </div>
        ) : groupedModules.length === 0 ? (
          <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-8 text-center">
            <ShieldOff size={32} className="mx-auto mb-3 text-neutral-300 dark:text-stone-500" />
            <p className="text-sm text-neutral-500 dark:text-stone-400">{t('blacklist.empty')}</p>
            <p className="text-xs text-neutral-400 dark:text-stone-500 mt-1">{t('blacklist.emptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {groupedModules.map(([module, items]) => {
              const modInfo = MODULE_LABELS[module] || { labelKey: module, icon: ShieldOff };
              const Icon = modInfo.icon;

              return (
                <div key={module} className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden">
                  {/* 模块头部 */}
                  <div className="flex items-center justify-between px-4 py-3 bg-neutral-50/50 dark:bg-stone-700/50 border-b border-neutral-200/30 dark:border-stone-700/30">
                    <div className="flex items-center gap-2">
                      <Icon size={16} className="text-[var(--element-bg)]" />
                      <span className="text-sm font-medium text-neutral-700 dark:text-stone-200">{t(modInfo.labelKey)}</span>
                      <span className="text-xs text-neutral-400 dark:text-stone-500">({items.length})</span>
                    </div>
                    <button
                      onClick={() => {
                        if (confirm(t('blacklist.confirmRestoreAll', { name: t(modInfo.labelKey), n: items.length }))) {
                          handleClearModule(module);
                        }
                      }}
                      className="btn-press flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <RotateCcw size={12} />
                      {t('blacklist.restoreAll')}
                    </button>
                  </div>

                  {/* 条目列表 */}
                  <div className="divide-y divide-neutral-200/30 dark:divide-stone-700/30">
                    {items.map((entry) => (
                      <div key={entry.path} className="flex items-center justify-between px-4 py-3 hover:bg-neutral-50 dark:hover:bg-stone-700/30 transition-colors">
                        <div className="min-w-0 flex-1 mr-4">
                          <div className="text-sm text-neutral-700 dark:text-stone-200 truncate">{entry.display_name}</div>
                          <div className="text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5" title={entry.path}>
                            {entry.path}
                          </div>
                          <div className="text-[10px] text-neutral-300 dark:text-stone-600 mt-0.5">
                            {t('blacklist.blockedAt', { time: entry.blocked_at })}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemove(entry)}
                          className="btn-press flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors flex-shrink-0"
                          title={t('blacklist.restoreFolder')}
                        >
                          <RotateCcw size={12} />
                          {t('blacklist.restore')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 操作提示 */}
      {groupedModules.length > 0 && (
        <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-4">
          <p className="text-xs text-neutral-400 dark:text-stone-500">
            {t('blacklist.tip')}
          </p>
        </section>
      )}
    </div>
  );
}

export default BlacklistManager;
