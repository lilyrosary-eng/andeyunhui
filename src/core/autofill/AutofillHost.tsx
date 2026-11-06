// 应用内自动填充宿主：聚焦登录字段时在右侧挂一个小钥匙图标，点开是搜索选择面板。
// 设计约束（避免破坏既有观感）：
//  - 只在 type=password 或「同容器内有密码框」的用户名字段上出现；
//  - 图标只在聚焦期间显示，失焦即消失，不占布局、不挡点击；
//  - 不自动填充、不自动保存：每一次填充都必须由用户点选条目。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { navigateTo } from '@/core/navigation/navigation';
import { fuzzyScore } from '@/lib/fuzzy';
import {
  classifyField,
  contextText,
  describeInput,
  findLoginFields,
  isEditable,
  setNativeValue,
} from './fieldDetect';
import { getVaultStatus, listVaultItems, markVaultItemUsed, type VaultItemSummary, type VaultStatus } from './vaultBridge';

interface Point {
  left: number;
  top: number;
}

const PANEL_W = 300;
const PANEL_H = 360;

export function AutofillHost() {
  const [iconPos, setIconPos] = useState<Point | null>(null);
  const [panelPos, setPanelPos] = useState<Point | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItemSummary[]>([]);
  const [query, setQuery] = useState('');
  const [context, setContext] = useState('');
  const [busy, setBusy] = useState(false);
  const [filled, setFilled] = useState<string | null>(null);

  const fieldRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    openRef.current = open;
    // 关闭面板即丢弃内存中的条目明文，缩短敏感数据在 UI 层的驻留时间
    if (!open) setItems([]);
  }, [open]);

  // 聚焦识别：只做分类，不碰后端
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || !isEditable(target)) return;
      // 密码库自己的解锁/编辑框不挂填充图标：在那填主密码或密码本身没有意义
      if (target.closest?.('[data-vault-ui]')) {
        setIconPos(null);
        return;
      }
      const desc = describeInput(target);
      const { role } = classifyField(desc);
      const isLoginField = role === 'password' || (role === 'username' && desc.containerHasPassword);
      if (!isLoginField) {
        setIconPos(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 16) {
        setIconPos(null);
        return;
      }
      fieldRef.current = target;
      setIconPos({
        left: rect.right - 26,
        top: rect.top + rect.height / 2 - 11,
      });
      setContext(contextText(target));
      setFilled(null);
    };

    const onFocusOut = () => {
      // 面板打开时保持图标位置；否则延迟清掉，避免点击图标瞬间消失
      window.setTimeout(() => {
        if (!openRef.current) setIconPos(null);
      }, 120);
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, []);

  // 面板打开期间的定位跟随与关闭
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = fieldRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPanelPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8)),
        top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - PANEL_H - 8)),
      });
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-vault-autofill-icon]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openPanel = useCallback(async () => {
    const el = fieldRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPanelPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8)),
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - PANEL_H - 8)),
    });
    setOpen(true);
    setQuery('');
    setBusy(true);
    try {
      const st = await getVaultStatus();
      setStatus(st);
      setItems(st?.unlocked ? await listVaultItems() : []);
    } finally {
      setBusy(false);
    }
  }, []);

  const visible = useMemo(() => {
    const base = items.filter((i) => i.username || i.kind === 'login');
    const q = query.trim();
    if (q) {
      return base
        .filter((i) => fuzzyScore(q, `${i.title} ${i.username} ${i.urls.join(' ')} ${i.tags.join(' ')}`) > 0)
        .slice(0, 30);
    }
    const ctx = context.toLowerCase();
    return base
      .slice()
      .sort((a, b) => {
        const ca = a.title && ctx.includes(a.title.toLowerCase()) ? 1 : 0;
        const cb = b.title && ctx.includes(b.title.toLowerCase()) ? 1 : 0;
        return cb - ca || Number(b.favorite) - Number(a.favorite) || b.lastUsedAtMs - a.lastUsedAtMs;
      })
      .slice(0, 30);
  }, [items, query, context]);

  const fill = async (item: VaultItemSummary) => {
    const el = fieldRef.current;
    if (!el) return;
    const fields = findLoginFields(el);
    if (fields.username) setNativeValue(fields.username, item.username);
    if (fields.password) setNativeValue(fields.password, item.password);
    // 让受控表单走完 onChange 后再收焦点，避免某些组件在 blur 时回写旧值
    if (fields.password) fields.password.focus();
    await markVaultItemUsed(item.id);
    setFilled(item.title || item.username);
    setOpen(false);
    window.setTimeout(() => setFilled(null), 1600);
  };

  return createPortal(
    <>
      {iconPos && !open && (
        <button
          data-vault-autofill-icon
          title="从密码库填充"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void openPanel()}
          style={{ left: iconPos.left, top: iconPos.top }}
          className="fixed z-[var(--layer-fullscreen)] w-[22px] h-[22px] rounded-md flex items-center justify-center bg-white/90 dark:bg-stone-800/90 border border-neutral-200/80 dark:border-stone-700/70 shadow-sm text-neutral-500 dark:text-stone-400 hover:text-emerald-600 dark:hover:text-emerald-400 opacity-70 hover:opacity-100 transition-opacity"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7.5" cy="15.5" r="5.5" />
            <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
          </svg>
        </button>
      )}

      {filled && (
        <div className="fixed bottom-6 right-6 z-[var(--layer-fullscreen)] px-3 py-2 rounded-lg bg-neutral-900/90 text-white text-xs shadow-lg">
          已填充「{filled}」
        </div>
      )}

      {open && panelPos && (
        <div
          ref={panelRef}
          style={{ left: panelPos.left, top: panelPos.top, width: PANEL_W, maxHeight: PANEL_H }}
          className="fixed z-[var(--layer-fullscreen)] flex flex-col rounded-xl bg-[#f7f6f2] dark:bg-[#1c1917] border border-neutral-200/80 dark:border-stone-700/70 shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-2.5 py-2 border-b border-neutral-200/70 dark:border-stone-700/50">
            <span className="text-[11px] font-medium text-neutral-600 dark:text-stone-300">密码库</span>
            <button onClick={() => setOpen(false)} className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200">
              关闭
            </button>
          </div>

          {busy && <div className="px-3 py-4 text-xs text-neutral-400 dark:text-stone-500">读取中…</div>}

          {!busy && status && !status.exists && (
            <div className="px-3 py-4 flex flex-col gap-2">
              <div className="text-xs text-neutral-500 dark:text-stone-400">还没有创建密码库。</div>
              <button
                onClick={() => {
                  setOpen(false);
                  void navigateTo({ module: 'vault' });
                }}
                className="self-start px-2.5 py-1 rounded-md text-xs bg-[var(--element-muted)] text-[var(--element-bg)]"
              >
                去创建
              </button>
            </div>
          )}

          {!busy && status?.exists && !status.unlocked && (
            <div className="px-3 py-4 flex flex-col gap-2">
              <div className="text-xs text-neutral-500 dark:text-stone-400">密码库已锁定，解锁后才能取用。</div>
              <button
                onClick={() => {
                  setOpen(false);
                  void navigateTo({ module: 'vault' });
                }}
                className="self-start px-2.5 py-1 rounded-md text-xs bg-[var(--element-muted)] text-[var(--element-bg)]"
              >
                去解锁
              </button>
            </div>
          )}

          {!busy && status?.unlocked && (
            <>
              <div className="p-2 border-b border-neutral-200/70 dark:border-stone-700/50">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索条目"
                  className="w-full px-2 py-1.5 rounded-md text-xs bg-white/80 dark:bg-stone-800/70 border border-neutral-200/70 dark:border-stone-700/60 outline-none"
                />
              </div>
              <div className="flex-1 overflow-auto">
                {visible.length === 0 && (
                  <div className="px-3 py-3 text-xs text-neutral-400 dark:text-stone-500">
                    {query ? '没有匹配条目' : '密码库里还没有可填充的账号'}
                  </div>
                )}
                {visible.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => void fill(item)}
                    className="w-full text-left px-2.5 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <div className="flex items-center gap-1.5">
                      {item.favorite && <span className="text-amber-500 text-[10px]">★</span>}
                      <span className="flex-1 text-xs font-medium truncate">{item.title || item.username}</span>
                    </div>
                    <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                      {item.username || '—'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="px-2.5 py-1.5 border-t border-neutral-200/70 dark:border-stone-700/50 text-[10px] text-neutral-400 dark:text-stone-500">
                只填充当前表单的用户名与密码，不会自动提交
              </div>
            </>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
