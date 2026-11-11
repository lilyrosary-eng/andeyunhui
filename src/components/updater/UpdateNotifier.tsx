import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtSize } from '@/lib/formatSize';
import { isWindowsDesktop, useUpdaterStore } from '@/core/updater/updaterStore';

/**
 * 全局更新提示：有新版 / 下载中 / 下载失败显示右下角卡片；
 * 安装阶段显示全屏遮罩；更新完成/失败在下次启动显示状态 toast。
 */
export function UpdateNotifier() {
  const { t } = useI18n();
  const {
    phase,
    info,
    downloaded,
    total,
    speed,
    error,
    dismissed,
    lastStatus,
    init,
    check,
    startUpdate,
    cancel,
    dismiss,
    clearLastStatus,
  } = useUpdaterStore();

  useEffect(() => {
    init();
  }, [init]);

  if (!isWindowsDesktop) return null;

  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const bannerVisible =
    !lastStatus &&
    phase !== 'installing' &&
    !dismissed &&
    (phase === 'available' || phase === 'downloading' || phase === 'error');

  return (
    <>
      {phase === 'installing' && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-white/80 bg-white px-8 py-7 text-center shadow-2xl dark:border-stone-600/60 dark:bg-stone-800">
            <Loader2 size={30} className="mx-auto mb-4 animate-spin text-[var(--element-bg)]" />
            <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">
              {t('updater.installing')}
            </div>
            <div className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-stone-500">
              {t('updater.installHint')}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500">
              {t('updater.installStuckHint')}
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-stone-700">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--element-bg)]" />
            </div>
          </div>
        </div>
      )}

      {lastStatus && phase !== 'installing' && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-[9998] w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-white/80 bg-white/95 p-4 shadow-2xl backdrop-blur dark:border-stone-600/60 dark:bg-stone-800/95"
        >
          <div className="flex items-start gap-3">
            {lastStatus.status === 'success' ? (
              <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-500" />
            ) : (
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">
                {lastStatus.status === 'success'
                  ? t('updater.updated', { v: lastStatus.version || '' })
                  : t('updater.failedKept')}
              </div>
              {lastStatus.status === 'failed' && lastStatus.error && (
                <div className="mt-1 line-clamp-2 break-all text-xs text-neutral-500 dark:text-stone-400">
                  {lastStatus.error}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={clearLastStatus}
              className="btn-press shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:text-stone-500 dark:hover:bg-stone-700 dark:hover:text-stone-300"
              aria-label={t('updater.close')}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {bannerVisible && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-[9998] w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/80 bg-white/95 shadow-2xl backdrop-blur dark:border-stone-600/60 dark:bg-stone-800/95"
        >
          <div className="flex items-start gap-3 p-4">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--element-muted)] text-[var(--element-bg)]">
              {phase === 'downloading' ? (
                <Download size={18} />
              ) : phase === 'error' ? (
                <AlertTriangle size={18} />
              ) : (
                <Sparkles size={18} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">
                  {phase === 'available'
                    ? t('updater.available', { v: info?.version || '' })
                    : phase === 'downloading'
                      ? t('updater.downloading')
                      : t('updater.failed')}
                </div>
                <button
                  type="button"
                  onClick={dismiss}
                  className="btn-press -mr-1 -mt-1 shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:text-stone-500 dark:hover:bg-stone-700 dark:hover:text-stone-300"
                  aria-label={t('updater.close')}
                >
                  <X size={15} />
                </button>
              </div>

              {phase === 'available' && (
                <>
                  {info?.body && (
                    <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:bg-stone-900/40 dark:text-stone-400">
                      {info.body}
                    </div>
                  )}
                  {info?.size ? (
                    <div className="mt-2 text-[11px] text-neutral-400 dark:text-stone-500">
                      {t('updater.packageSize', { size: fmtSize(info.size) })}
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={dismiss}
                      className="btn-press rounded-lg px-3 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-stone-400 dark:hover:bg-stone-700"
                    >
                      {t('updater.later')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void startUpdate()}
                      className="btn-press element-primary rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--element-hover)]"
                    >
                      {t('updater.download')}
                    </button>
                  </div>
                </>
              )}

              {phase === 'downloading' && (
                <>
                  {total > 0 ? (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-stone-700">
                      <div
                        className="h-full rounded-full bg-[var(--element-bg)] transition-all duration-200"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-400 dark:text-stone-500">
                      <Loader2 size={12} className="animate-spin" />
                      {t('updater.preparing')}
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-400 dark:text-stone-500">
                    <span>
                      {total > 0
                        ? t('updater.downloaded', {
                            done: fmtSize(downloaded),
                            total: fmtSize(total),
                          })
                        : fmtSize(downloaded)}
                      {speed > 0 ? ` · ${fmtSize(speed)}/s` : ''}
                    </span>
                    <span className="flex items-center gap-2">
                      {total > 0 && <span>{percent}%</span>}
                      <button
                        type="button"
                        onClick={() => void cancel()}
                        className="btn-press rounded-md px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
                      >
                        {t('updater.cancel')}
                      </button>
                    </span>
                  </div>
                </>
              )}

              {phase === 'error' && (
                <>
                  <div className="mt-2 line-clamp-3 break-all text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                    {error || t('updater.failed')}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void openUrl('https://github.com/lilyrosary-eng/andeyunhui/releases').catch(() => {})}
                      className="btn-press rounded-lg px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-stone-400 dark:hover:bg-stone-700"
                    >
                      {t('updater.openReleases')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void invoke('update_open_logs').catch(() => {})}
                      className="btn-press rounded-lg px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-stone-400 dark:hover:bg-stone-700"
                    >
                      {t('updater.openLogs')}
                    </button>
                    <button
                      type="button"
                      onClick={dismiss}
                      className="btn-press rounded-lg px-3 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-stone-400 dark:hover:bg-stone-700"
                    >
                      {t('updater.close')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (info?.available) void startUpdate();
                        else void check(true);
                      }}
                      className="btn-press element-primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--element-hover)]"
                    >
                      <RefreshCw size={13} />
                      {t('updater.retry')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
