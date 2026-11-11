import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Globe,
  Plus,
  Trash2,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Pencil,
  RotateCcw,
  Check,
  X,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  CUSTOM_ONLY_MODULES,
  NETWORK_MODULE_LABEL,
  addCustomSite,
  allSites,
  hiddenBuiltinSites,
  isBuiltinSite,
  moveSite,
  onNetworkSitesChange,
  removeSite,
  restoreBuiltinSite,
  updateSite,
  type NetworkSite,
  type NetworkSiteModule,
} from '../../../plugins/_shared/networkSites';

/**
 * 「设置 → 茑萝 → 网络拓展」：集中管理各模块「云」抽屉里的站点。
 *
 * 分组与抽屉一一对应，顺序只在各自组内调整：
 *   · 视频 / 图片 / Web 接口 / 阅读：内置站点 + 自定义站点共用一个网络组；
 *   · 笔记 / 音乐：网络组是固定的 API 源（不在这里、不可编辑），这里只管
 *     「自定义网站」这一组 —— 它单独成组，顺序不会影响 API 源。
 *
 * 内置站点可改名/换址（写入 overrides）与隐藏（写入 removed），
 * 隐藏后仍可在本页「恢复内置」找回；自定义站点直接删除。
 */
const MODULES: NetworkSiteModule[] = ['video', 'image', 'web', 'book', 'note', 'music'];

export function NetworkSitesPanel() {
  const [revision, setRevision] = useState(0);
  const [module, setModule] = useState<NetworkSiteModule>('web');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** 正在行内编辑的站点：`${module}:${id}` */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  // 订阅变更：其它窗口/标签页改了也同步；revision 只作为重算触发信号
  useEffect(() => onNetworkSitesChange(() => setRevision((v) => v + 1)), []);

  const rowsByModule = useMemo(() => {
    const map = {} as Record<NetworkSiteModule, { site: NetworkSite; builtin: boolean }[]>;
    for (const m of MODULES) {
      map[m] = allSites(m).map((site) => ({ site, builtin: isBuiltinSite(m, site.id) }));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const hiddenByModule = useMemo(() => {
    const map = {} as Record<NetworkSiteModule, NetworkSite[]>;
    for (const m of MODULES) map[m] = hiddenBuiltinSites(m);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

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
  }, [desc, module, name, url]);

  const beginEdit = (m: NetworkSiteModule, s: NetworkSite) => {
    setEditingKey(`${m}:${s.id}`);
    setEditName(s.name);
    setEditUrl(s.url);
    setEditDesc(s.desc ?? '');
    setEditError(null);
  };

  const saveEdit = (m: NetworkSiteModule, id: string) => {
    const res = updateSite(m, id, { name: editName, url: editUrl, desc: editDesc });
    if (!res.ok) {
      setEditError(res.error);
      return;
    }
    setEditingKey(null);
    setEditError(null);
  };

  const inputCls =
    'w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-stone-900 px-3 py-2 text-sm outline-none focus:border-[var(--element-color-raw)]';

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
        <Globe size={14} />
        网络拓展
      </h2>
      <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
        这里管理各模块「云」抽屉里的站点。顺序只在本组内调整，不会影响其它分组；
        内置站点可改名、换址或隐藏（隐藏后可用「恢复内置」找回），自定义站点可直接删除。
        笔记与音乐的检索 / 在线源是 API，不在此表；它们只管理单独一组的「自定义网站」。
      </p>

      <div className="space-y-3">
        {MODULES.map((m) => {
          const rows = rowsByModule[m];
          const hidden = hiddenByModule[m];
          return (
            <div
              key={m}
              className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden"
            >
              <div className="px-4 py-2 bg-neutral-50/60 dark:bg-stone-700/40 flex items-center gap-2">
                <span className="text-xs font-medium text-neutral-600 dark:text-stone-300">
                  {NETWORK_MODULE_LABEL[m]}
                </span>
                {CUSTOM_ONLY_MODULES.includes(m) && (
                  <span className="rounded px-1 py-[1px] text-[10px] bg-neutral-200/70 dark:bg-stone-600/60 text-neutral-500 dark:text-stone-300">
                    仅自定义网站
                  </span>
                )}
                <span className="ml-auto text-[11px] text-neutral-400 dark:text-stone-500">
                  {rows.length} 个站点
                </span>
                {hidden.length > 0 && (
                  <button
                    onClick={() => hidden.forEach((s) => restoreBuiltinSite(m, s.id))}
                    className="btn-press flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-neutral-500 dark:text-stone-400 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors"
                    title="恢复被隐藏的内置站点"
                  >
                    <RotateCcw size={11} />
                    恢复内置（{hidden.length}）
                  </button>
                )}
              </div>
              <ul className="divide-y divide-neutral-200/50 dark:divide-stone-700/50">
                {rows.length === 0 && (
                  <li className="px-4 py-3 text-xs text-neutral-400 dark:text-stone-500">
                    暂无站点，可在下方添加。
                  </li>
                )}
                {rows.map(({ site: s, builtin }, idx) => {
                  const key = `${m}:${s.id}`;
                  const editing = editingKey === key;
                  return (
                    <li key={s.id} className="px-4 py-2.5">
                      {editing ? (
                        <div className="space-y-2">
                          <div className="grid gap-2 sm:grid-cols-[1fr_1.6fr]">
                            <input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="名称"
                              className={inputCls}
                              autoFocus
                            />
                            <input
                              value={editUrl}
                              onChange={(e) => setEditUrl(e.target.value)}
                              placeholder="网址（http/https）"
                              className={inputCls}
                            />
                          </div>
                          <input
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="说明（可选）"
                            className={inputCls}
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => saveEdit(m, s.id)}
                              className="btn-press flex items-center gap-1 rounded-lg bg-[var(--element-bg)] px-3 py-1.5 text-xs font-medium text-white"
                            >
                              <Check size={12} />
                              保存
                            </button>
                            <button
                              onClick={() => {
                                setEditingKey(null);
                                setEditError(null);
                              }}
                              className="btn-press flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700/60"
                            >
                              <X size={12} />
                              取消
                            </button>
                            {editError && <span className="ml-auto text-xs text-red-500">{editError}</span>}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                            style={{ background: s.accent || '#6b7280' }}
                          >
                            {s.name.slice(0, 1)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm text-neutral-800 dark:text-stone-100 truncate">
                                {s.name}
                              </span>
                              <span
                                className={`shrink-0 rounded px-1 py-[1px] text-[10px] ${
                                  builtin
                                    ? 'bg-neutral-200/70 dark:bg-stone-600/60 text-neutral-500 dark:text-stone-300'
                                    : 'bg-[var(--element-muted)] text-[var(--element-color-raw)]'
                                }`}
                              >
                                {builtin ? '内置' : '自定义'}
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
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              onClick={() => moveSite(m, s.id, 'up')}
                              disabled={idx === 0}
                              className="btn-press rounded-lg p-1.5 text-neutral-400 hover:text-[var(--element-color-raw)] hover:bg-neutral-100 dark:hover:bg-stone-700/60 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-400 transition-colors"
                              title="在本组内上移"
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              onClick={() => moveSite(m, s.id, 'down')}
                              disabled={idx === rows.length - 1}
                              className="btn-press rounded-lg p-1.5 text-neutral-400 hover:text-[var(--element-color-raw)] hover:bg-neutral-100 dark:hover:bg-stone-700/60 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-400 transition-colors"
                              title="在本组内下移"
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button
                              onClick={() => beginEdit(m, s)}
                              className="btn-press rounded-lg p-1.5 text-neutral-400 hover:text-[var(--element-color-raw)] hover:bg-neutral-100 dark:hover:bg-stone-700/60 transition-colors"
                              title="编辑名称与网址"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => removeSite(m, s.id)}
                              className="btn-press rounded-lg p-1.5 text-neutral-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                              title={builtin ? '隐藏该内置站点（可恢复）' : '删除该自定义站点'}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
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
