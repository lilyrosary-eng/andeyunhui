/// <reference path="../../../global.d.ts" />
// 条目编辑器：新建与编辑共用。历史版本只做「复制回表单」，保存后才真正落盘，
// 这样误点历史不会产生额外写入与备份。
const React = window.__HOST_REACT__;
const { useEffect, useState } = React;

import { KIND_LABEL, type CustomField, type ItemKind, type VaultItem } from './api';
import { PasswordGenerator } from '../../../_shared/PasswordGenerator';
import { TotpCode } from '../../../_shared/TotpCode';

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70 outline-none focus:border-[var(--element-muted)]';
const labelCls = 'mb-1 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-stone-500';
const sectionCls = 'rounded-xl bg-white/60 dark:bg-stone-900/40 p-3.5';

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface ItemEditorProps {
  item: VaultItem;
  isNew: boolean;
  saving: boolean;
  onSave: (item: VaultItem) => Promise<string | null>;
  onDelete: (item: VaultItem) => void;
  onClose: () => void;
}

export function ItemEditor({ item, isNew, saving, onSave, onDelete, onClose }: ItemEditorProps) {
  const [draft, setDraft] = useState<VaultItem>(item);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [urlsText, setUrlsText] = useState(item.urls.join('\n'));
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraft(item);
    setUrlsText(item.urls.join('\n'));
    setTagsText(item.tags.join(', '));
    setLocalError(null);
    setConfirmDelete(false);
  }, [item]);

  const patch = (p: Partial<VaultItem>) => setDraft((d) => ({ ...d, ...p }));

  const patchField = (index: number, p: Partial<CustomField>) => {
    const next = draft.fields.slice();
    next[index] = { ...next[index], ...p };
    patch({ fields: next });
  };

  const save = async () => {
    setLocalError(null);
    if (!draft.title.trim() && !draft.username.trim()) {
      setLocalError('标题与用户名不能同时为空');
      return;
    }
    const urls = urlsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = tagsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const err = await onSave({ ...draft, urls, tags });
    if (err) setLocalError(err);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/80 dark:border-stone-700/50">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">
            {isNew ? '新建条目' : draft.title || draft.username || '未命名'}
          </div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500">
            {isNew ? '保存后立即加密落盘' : `创建 ${fmtTime(draft.createdAtMs)} · 更新 ${fmtTime(draft.updatedAtMs)}`}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isNew && (
            <button
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  setTimeout(() => setConfirmDelete(false), 3000);
                  return;
                }
                onDelete(draft);
              }}
              className="text-xs text-red-500 hover:text-red-600 px-2 py-1 rounded-md hover:bg-red-500/10"
            >
              {confirmDelete ? '确认删除？' : '删除'}
            </button>
          )}
          <button onClick={onClose} className="text-xs px-2 py-1 rounded-md hairline hover:bg-black/5 dark:hover:bg-white/10">
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded-md bg-[var(--element-muted)] text-[var(--element-bg)] disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col gap-3">
        <div className={sectionCls}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className={labelCls}>类型</div>
              <select
                value={draft.kind}
                onChange={(e) => patch({ kind: e.target.value as ItemKind })}
                className={inputCls}
              >
                {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className={labelCls}>标题</div>
              <input
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="例如 GitHub"
                className={inputCls}
              />
            </div>
            <div>
              <div className={labelCls}>用户名 / 账号</div>
              <input
                value={draft.username}
                onChange={(e) => patch({ username: e.target.value })}
                className={inputCls}
              />
            </div>
            <div>
              <div className={labelCls}>网址（每行一个）</div>
              <textarea
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                rows={2}
                placeholder="https://github.com"
                className={`${inputCls} resize-y`}
              />
            </div>
          </div>
        </div>

        <div className={sectionCls}>
          <div className="flex items-center justify-between">
            <div className={labelCls}>密码 / 密钥</div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowPassword((v) => !v)}
                className="text-[11px] px-2 py-0.5 rounded-md hairline hover:bg-black/5 dark:hover:bg-white/10"
              >
                {showPassword ? '隐藏' : '显示'}
              </button>
              <button
                onClick={() => setShowGenerator((v) => !v)}
                className="text-[11px] px-2 py-0.5 rounded-md hairline hover:bg-black/5 dark:hover:bg-white/10"
              >
                {showGenerator ? '收起生成器' : '生成'}
              </button>
            </div>
          </div>
          <div className="mt-1.5 flex gap-2">
            <input
              type={showPassword ? 'text' : 'password'}
              value={draft.password}
              onChange={(e) => patch({ password: e.target.value })}
              className={`${inputCls} font-mono`}
              autoComplete="off"
            />
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(draft.password);
                } catch {
                  /* 剪贴板不可用时静默；用户仍可手动选择复制 */
                }
              }}
              className="shrink-0 px-3 rounded-lg text-xs hairline hover:bg-black/5 dark:hover:bg-white/10"
            >
              复制
            </button>
          </div>
          {showGenerator && (
            <div className="mt-3 pt-3 border-t border-neutral-200/70 dark:border-stone-700/50">
              <PasswordGenerator
                compact
                onUse={(value) => {
                  patch({ password: value });
                  setShowPassword(true);
                  setShowGenerator(false);
                }}
              />
            </div>
          )}
        </div>

        <div className={sectionCls}>
          <div className={labelCls}>TOTP 种子（可选，base32）</div>
          <input
            value={draft.totpSecret}
            onChange={(e) => patch({ totpSecret: e.target.value.trim() })}
            placeholder="JBSWY3DPEHPK3PXP"
            className={`${inputCls} font-mono`}
          />
          {draft.totpSecret.trim().length >= 8 && <TotpCode secret={draft.totpSecret.trim()} />}

          <div className={`${labelCls} mt-3`}>标签（逗号分隔）</div>
          <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} className={inputCls} />

          <div className={`${labelCls} mt-3`}>备注</div>
          <textarea
            value={draft.notes}
            onChange={(e) => patch({ notes: e.target.value })}
            rows={3}
            className={`${inputCls} resize-y`}
          />

          <label className="mt-3 flex items-center gap-2 text-xs text-neutral-600 dark:text-stone-300">
            <input type="checkbox" checked={draft.favorite} onChange={(e) => patch({ favorite: e.target.checked })} />
            标记为收藏
          </label>
        </div>

        <div className={sectionCls}>
          <div className="flex items-center justify-between">
            <div className={labelCls}>自定义字段</div>
            <button
              onClick={() => patch({ fields: [...draft.fields, { name: '', value: '', hidden: false }] })}
              className="text-[11px] px-2 py-0.5 rounded-md hairline hover:bg-black/5 dark:hover:bg-white/10"
            >
              + 添加
            </button>
          </div>
          {draft.fields.length === 0 && (
            <div className="text-xs text-neutral-400 dark:text-stone-500">没有自定义字段</div>
          )}
          <div className="mt-1.5 flex flex-col gap-2">
            {draft.fields.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={f.name}
                  onChange={(e) => patchField(i, { name: e.target.value })}
                  placeholder="字段名"
                  className={`${inputCls} w-32 shrink-0`}
                />
                <input
                  type={f.hidden ? 'password' : 'text'}
                  value={f.value}
                  onChange={(e) => patchField(i, { value: e.target.value })}
                  placeholder="值"
                  className={`${inputCls} flex-1`}
                />
                <label className="shrink-0 flex items-center gap-1 text-[11px] text-neutral-500 dark:text-stone-400">
                  <input
                    type="checkbox"
                    checked={f.hidden}
                    onChange={(e) => patchField(i, { hidden: e.target.checked })}
                  />
                  隐藏
                </label>
                <button
                  onClick={() => patch({ fields: draft.fields.filter((_, idx) => idx !== i) })}
                  className="shrink-0 text-xs text-neutral-400 hover:text-red-500 px-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        {draft.history.length > 0 && (
          <div className={sectionCls}>
            <div className={labelCls}>历史版本（保留最近 {draft.history.length} 条）</div>
            <div className="flex flex-col gap-1">
              {draft.history
                .slice()
                .reverse()
                .slice(0, 5)
                .map((v, i) => (
                  <div key={`${v.atMs}-${i}`} className="flex items-center gap-2 text-xs">
                    <span className="text-neutral-400 dark:text-stone-500 w-32 shrink-0">{fmtTime(v.atMs)}</span>
                    <span className="flex-1 truncate font-mono">{v.password ? '••••••' : '（无密码）'}</span>
                    <button
                      onClick={() =>
                        patch({ title: v.title, username: v.username, password: v.password })
                      }
                      className="shrink-0 text-[11px] px-2 py-0.5 rounded-md hairline hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      复制到表单
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {localError && (
        <div className="px-4 py-2 text-xs text-red-600 dark:text-red-400 border-t border-red-500/20">
          {localError}
        </div>
      )}
    </div>
  );
}
