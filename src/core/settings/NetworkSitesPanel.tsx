import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, Plus, Trash2, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  BUILTIN_SITES,
  NETWORK_MODULE_LABEL,
  addCustomSite,
  loadCustomSites,
  onNetworkSitesChange,
  removeCustomSite,
  type NetworkSite,
  type NetworkSiteModule,
} from '../../../plugins/_shared/networkSites';

/**
 * 「设置 → 茑萝 → 网络拓展」：集中管理各模块「云」抽屉里的站点。
 *
 * 只覆盖「一个模块 = 一行网址」的三处（视频 / 图片 / Web 接口）；
 * 音乐（铃兰）走流媒体 API、笔记（鸢尾花）走四个官方检索 API，它们的「源」不是站点 URL，
 * 因此不在本表里 —— 强行列出来只会让用户以为可以随便加，实际加不了。
 *
 * 数据层在 plugins/_shared/networkSites.ts：
 *   · 内置站点写在代码里（随版本更新，不可删）；
 *   · 用户新增项存 localStorage，插件与宿主共享，改完抽屉立即刷新。
 */
const MODULES: NetworkSiteModule[] = ['video', 'image', 'web'];

export function NetworkSitesPanel() {
  const [custom, setCustom] = useState(() => loadCustomSites());
  const [module, setModule] = useState<NetworkSiteModule>('web');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 订阅变更：其它窗口/标签页改了也同步
  useEffect(() => onNetworkSitesChange(() => setCustom(loadCustomSites())), []);

  const rowsByModule = useMemo(() => {
    const map: Record<NetworkSiteModule, (NetworkSite & { builtin: boolean })[]> = {
      video: [],
      image: [],
      web: [],
    };
    for (const m of MODULES) {
      const merged = new Map<string, NetworkSite & { builtin: boolean }>();
      for (const s of BUILTIN_SITES[m]) merged.set(s.id, { ...s, builtin: true });
      for (const s of custom) {
        if (s.module === m) merged.set(s.id, { ...s, builtin: false });
      }
      map[m] = [...merged.values()];
    }
    return map;
  }, [custom]);

  const submit = useCallback(() => {
    const res = addCustomSite(module, { name, url, desc });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setName('');
    setUrl('');
    setDesc('');
    setCustom(loadCustomSites());
  }, [desc, module, name, url]);

  const inputCls =
    'w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-stone-900 px-3 py-2 text-sm outline-none focus:border-[var(--element-color-raw)]';

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
        <Globe size={14} />
        网络拓展
      </h2>
      <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
        这里管理各模块「云」抽屉里的站点（视频 / 图片 / Web 接口）。内置站点随版本更新、不可删除；
        新增的站点会立刻出现在对应模块的抽屉里。音乐与笔记走的是 API，不在此表。
      </p>

      <div className="space-y-3">
        {MODULES.map((m) => (
          <div
            key={m}
            className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden"
          >
            <div className="px-4 py-2 bg-neutral-50/60 dark:bg-stone-700/40 flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-600 dark:text-stone-300">
                {NETWORK_MODULE_LABEL[m]}
              </span>
              <span className="text-[11px] text-neutral-400 dark:text-stone-500">
                {rowsByModule[m].length} 个站点
              </span>
            </div>
            <ul className="divide-y divide-neutral-200/50 dark:divide-stone-700/50">
              {rowsByModule[m].map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                    style={{ background: s.accent || '#6b7280' }}
                  >
                    {s.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-neutral-800 dark:text-stone-100 truncate">{s.name}</span>
                      <span
                        className={`shrink-0 rounded px-1 py-[1px] text-[10px] ${
                          s.builtin
                            ? 'bg-neutral-200/70 dark:bg-stone-600/60 text-neutral-500 dark:text-stone-300'
                            : 'bg-[var(--element-muted)] text-[var(--element-color-raw)]'
                        }`}
                      >
                        {s.builtin ? '内置' : '自定义'}
                      </span>
                    </div>
                    <button
                      onClick={() => void openUrl(s.url).catch(() => {})}
                      className="mt-0.5 flex max-w-full items-center gap-1 text-[11px] text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)]"
                      title="在系统浏览器打开"
                    >
                      <span className="truncate">{s.url}</span>
                      <ExternalLink size={11} className="shrink-0" />
                    </button>
                  </div>
                  {!s.builtin && (
                    <button
                      onClick={() => {
                        removeCustomSite(s.id);
                        setCustom(loadCustomSites());
                      }}
                      className="btn-press shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="删除该自定义站点"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* 新增站点 */}
      <div className="mt-4 bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plus size={15} className="text-[var(--element-color-raw)]" />
          <span className="text-sm font-medium">添加站点</span>
          {error && <span className="ml-auto text-xs text-red-500">{error}</span>}
        </div>
        <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
          <select
            value={module}
            onChange={(e) => setModule(e.target.value as NetworkSiteModule)}
            className={inputCls}
          >
            {MODULES.map((m) => (
              <option key={m} value={m}>
                {NETWORK_MODULE_LABEL[m]}
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="名称，如：Behance"
            className={inputCls}
          />
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="网址，如：https://www.behance.net（只支持 http/https）"
          className={inputCls}
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="说明（可选，展示在抽屉里）"
          className={inputCls}
        />
        <button
          onClick={submit}
          className="btn-press rounded-lg bg-[var(--element-bg)] px-4 py-2 text-sm font-medium text-white"
        >
          添加
        </button>
      </div>
    </section>
  );
}

export default NetworkSitesPanel;
