import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/lib/i18n';

export function CapsuleSettingsPanel() {
  const { t } = useI18n();
  const [alias, setAlias] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [autoAccept, setAutoAccept] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const st = (await invoke('transfer_status').catch(() => ({}))) as { alias?: string };
      const dir = (await invoke('transfer_get_save_dir').catch(() => '')) as string;
      const aa = (await invoke('transfer_get_auto_accept').catch(() => false)) as boolean;
      setAlias(st?.alias || '安得云荟');
      setSaveDir(dir);
      setAutoAccept(aa);
    })();
  }, []);

  const save = async () => {
    if (alias.trim()) await invoke('transfer_set_alias', { alias: alias.trim() }).catch(() => {});
    if (saveDir.trim()) await invoke('transfer_set_save_dir', { dir: saveDir.trim() }).catch(() => {});
    await invoke('transfer_set_auto_accept', { v: autoAccept }).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden main-panel-bg">
      <div className="px-8 pt-6 pb-2 shrink-0">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{t('capsule.settings.title')}</h2>
        <p className="text-xs text-neutral-400 dark:text-stone-500 mt-1">{t('capsule.settings.subtitle')}</p>
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-8 max-w-2xl">
        <section className="mb-6">
          <label className="block text-sm font-medium text-neutral-700 dark:text-stone-300 mb-1">{t('capsule.settings.deviceName')}</label>
          <p className="text-xs text-neutral-400 dark:text-stone-500 mb-2">{t('capsule.settings.deviceNameDesc')}</p>
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            className="w-full rounded-lg border border-white/50 dark:border-stone-600/40 bg-white/60 dark:bg-stone-700/40 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)] focus:border-transparent transition-all"
          />
        </section>

        <section className="mb-6">
          <label className="block text-sm font-medium text-neutral-700 dark:text-stone-300 mb-1">{t('capsule.settings.saveDir')}</label>
          <p className="text-xs text-neutral-400 dark:text-stone-500 mb-2">{t('capsule.settings.saveDirDesc')}</p>
          <div className="flex items-center gap-2">
            <input
              value={saveDir}
              readOnly
              placeholder={t('capsule.settings.saveDirPlaceholder')}
              className="flex-1 rounded-lg border border-white/50 dark:border-stone-600/40 bg-white/40 dark:bg-stone-700/30 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 placeholder:text-neutral-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)] focus:border-transparent transition-all"
            />
            <button
              type="button"
              onClick={async () => {
                const dir = (await invoke('pick_directory').catch(() => null)) as string | null;
                if (dir) setSaveDir(dir);
              }}
              className="shrink-0 px-3 py-2 rounded-lg border border-[var(--element-border)]/40 text-sm text-neutral-700 dark:text-stone-200 hover:bg-white/60 dark:hover:bg-stone-700/40 transition-colors"
            >
              {t('capsule.settings.chooseDir')}
            </button>
          </div>
        </section>

        <section className="mb-6">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoAccept}
              onChange={(e) => setAutoAccept(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium text-neutral-700 dark:text-stone-300">{t('capsule.settings.autoAccept')}</div>
              <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">{t('capsule.settings.autoAcceptDesc')}</div>
            </div>
          </label>
        </section>

        <div className="flex items-center gap-3 mt-8">
          <button
            onClick={save}
            className="px-5 py-2 rounded-lg bg-[var(--element-bg)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            {t('capsule.settings.save')}
          </button>
          {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('capsule.settings.saved')}</span>}
        </div>
      </div>
    </div>
  );
}

export default CapsuleSettingsPanel;