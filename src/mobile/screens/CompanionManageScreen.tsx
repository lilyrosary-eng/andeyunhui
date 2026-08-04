// 伴侣管理设置页（人机恋多伴侣，Android 优先）。
//
// 创建 / 选择 / 删除伴侣，选择后即成为活跃伴侣（ChatScreen 顶部伴侣卡随之切换）。
// 入口：设置（我的）→ 通用设置 → 伴侣管理。

import { useState } from 'react';
import { Plus, Check, Trash2, Heart } from 'lucide-react';
import { useCompanionStore, type Companion } from '../stores/companionStore';

function Avatar({ value, size }: { value: string; size: number }) {
  if (value.startsWith('data:image/')) {
    return (
      <img
        src={value}
        alt="avatar"
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return <span style={{ fontSize: size * 0.72, lineHeight: 1 }}>{value || '💡'}</span>;
}

/** 综合亲密度（对外唯一口径；六维为内部机制不展示） */
function affinityOf(c: Companion): number {
  const r = c.relationship;
  const w =
    (r.warmth ?? 0) * 0.3 + (r.trust ?? 0) * 0.2 + (r.intimacy ?? 0) * 0.4 +
    (r.intrigue ?? 0) * 0.05 + (r.patience ?? 0) * 0.05;
  return Math.round(Math.min(100, Math.max(0, w)));
}

export function CompanionManageScreen() {
  const collection = useCompanionStore((s) => s.collection);
  const companion = useCompanionStore((s) => s.companion);
  const create = useCompanionStore((s) => s.create);
  const select = useCompanionStore((s) => s.select);
  const remove = useCompanionStore((s) => s.remove);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const doCreate = async () => {
    await create(name);
    setCreating(false);
    setName('');
  };

  const days = (c: Companion) =>
    c.relationship.first_met_at
      ? Math.max(1, Math.floor((Date.now() / 1000 - c.relationship.first_met_at) / 86400))
      : 0;

  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
        可创建多个伴侣，但同一时间只选择一个作为当前陪伴对象。选择后 AI 对话页会展示对应的伴侣。
      </p>

      {/* 创建 */}
      {!creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center justify-center gap-2 rounded-xl py-2.5 font-medium border border-dashed border-[var(--border)] text-[var(--element-bg)] active:scale-[0.98] transition-transform"
          style={{ fontSize: 'var(--m-text-label)' }}
        >
          <Plus size={18} /> 创建新伴侣
        </button>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--input)]/40 p-3 flex flex-col gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="给 TA 起个名字…"
            autoFocus
            className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
            style={{ fontSize: 'var(--m-text-body)' }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setCreating(false); setName(''); }}
              className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)' }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void doCreate()}
              disabled={!name.trim()}
              className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform disabled:opacity-50"
              style={{ fontSize: 'var(--m-text-label)', background: 'var(--element-bg)', color: 'var(--element-fg)' }}
            >
              创建
            </button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        {collection.companions.map((c) => {
          const active = c.id === companion.id;
          return (
            <div
              key={c.id}
              className="flex items-center gap-3 px-4 py-3 active:bg-[var(--muted)]/60 transition-colors"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <Avatar value={c.avatar} size={36} />
              <button
                type="button"
                onClick={() => void select(c.id)}
                className="flex-1 min-w-0 text-left"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="truncate font-medium"
                    style={{ fontSize: 'var(--m-text-label)', color: active ? 'var(--element-bg)' : 'var(--foreground)' }}
                  >
                    {c.name || '未命名'}
                  </span>
                  {active && <Check size={14} className="shrink-0 text-[var(--element-bg)]" />}
                </div>
                <div className="flex items-center gap-1.5 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                  <Heart size={12} />
                  亲密度 {affinityOf(c)}% · 认识 {days(c)} 天 · {c.memories.length} 段记忆
                </div>
              </button>
              <button
                type="button"
                onClick={() => void remove(c.id)}
                className="shrink-0 p-2 text-[var(--danger)] active:scale-90 transition-transform"
                aria-label="删除伴侣"
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </section>

      <p className="text-center text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
        人格 / 头像 / 记忆的编辑在 AI 对话页点击顶部伴侣卡
      </p>
    </div>
  );
}
