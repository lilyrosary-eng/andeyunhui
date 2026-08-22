// 桌面版伴侣管理 + 人设编辑面板。由安卓 companionStore 驱动，桌面走 Tauri invoke 真后端，
// 浏览器预览降级时自动走本地缓存。所有数据读写经 useCompanionStore，不依赖安卓 var(--*) 变量。
import { useState } from 'react';
import { Plus, Check, Trash2, Heart, ImageIcon } from 'lucide-react';
import {
  useCompanionStore,
  type Companion,
  type Relationship,
} from '@/core/stores/companionStore';
import { Section } from '@/components/bricks/Section';
import { Field, inputCls } from '@/components/bricks/formui';
import { affinityOf } from '@/lib/affinity';

function AvatarView({ avatar, name }: { avatar: string; name: string }) {
  const isImg = avatar.startsWith('data:image/');
  return (
    <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-black/5 text-base dark:bg-white/5">
      {isImg ? <img src={avatar} alt={name} className="h-8 w-8 object-cover" /> : <span>{avatar || '💡'}</span>}
    </div>
  );
}

export function AiChatCompanionSettings() {
  const collection = useCompanionStore((s) => s.collection);
  const companion = useCompanionStore((s) => s.companion);
  const loaded = useCompanionStore((s) => s.loaded);
  const create = useCompanionStore((s) => s.create);
  const select = useCompanionStore((s) => s.select);
  const remove = useCompanionStore((s) => s.remove);
  const update = useCompanionStore((s) => s.update);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [coreText, setCoreText] = useState((companion?.core_memory ?? []).join('\n'));

  if (!loaded) {
    return <div className="p-4 text-sm text-neutral-400 dark:text-stone-500">加载伴侣中…</div>;
  }

  const handleImage = (file: File) => {
    if (!companion) return;
    const reader = new FileReader();
    reader.onload = () => {
      void update({ ...companion, avatar: String(reader.result) });
    };
    reader.readAsDataURL(file);
  };

  const saveCore = () => {
    if (!companion) return;
    void update({
      ...companion,
      core_memory: coreText.split('\n').map((s) => s.trim()).filter(Boolean),
    });
  };

  return (
    <div className="space-y-4">
      <Section title="伴侣">
        <div className="space-y-1.5">
          {collection.companions.map((c) => {
            const active = c.id === collection.active_id;
            const rel = affinityOf(c.relationship);
            const days = c.relationship.first_met_at
              ? Math.floor((Date.now() / 1000 - c.relationship.first_met_at) / 86400)
              : 0;
            return (
              <div
                key={c.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                  active
                    ? 'border-sky-400/50 bg-sky-400/10'
                    : 'border-black/10 dark:border-white/10'
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => void select(c.id)}
                >
                  <AvatarView avatar={c.avatar} name={c.name} />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-neutral-800 dark:text-stone-100">{c.name}</div>
                    <div className="truncate text-xs text-neutral-500 dark:text-stone-400">
                      亲密度 {rel}% · 认识 {days} 天 · {c.memories.length} 段记忆
                    </div>
                  </div>
                </button>
                {active && <Check className="h-4 w-4 shrink-0 text-sky-400" />}
                <button
                  type="button"
                  className="shrink-0 text-neutral-400 hover:text-red-500"
                  onClick={() => void remove(c.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
        {creating ? (
          <div className="flex items-center gap-2">
            <input
              className={inputCls}
              placeholder="伴侣名字"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="btn-press rounded-lg bg-sky-500 px-3 py-2 text-sm text-white"
              onClick={() => {
                if (newName.trim()) void create(newName.trim()).then(() => setCreating(false));
                setNewName('');
              }}
            >
              创建
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm text-neutral-400"
              onClick={() => setCreating(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-press flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm text-neutral-600 dark:border-white/10 dark:text-stone-300"
            onClick={() => setCreating(true)}
          >
            <Plus size={15} /> 创建新伴侣
          </button>
        )}
      </Section>

      {companion && (
        <Section title={`编辑 · ${companion.name}`}>
          <Field label="头像">
            <div className="flex items-center gap-3">
              <AvatarView avatar={companion.avatar} name={companion.name} />
              <input
                className={inputCls}
                value={companion.avatar.startsWith('data:image/') ? '' : companion.avatar}
                placeholder="输入 emoji（如 🐱）或选择图片"
                onChange={(e) => void update({ ...companion, avatar: e.target.value })}
              />
              <label className="btn-press flex cursor-pointer items-center gap-1.5 rounded-lg border border-black/10 px-3 py-2 text-sm text-neutral-600 dark:border-white/10 dark:text-stone-300">
                <ImageIcon size={15} /> 图片
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleImage(e.target.files[0])}
                />
              </label>
            </div>
          </Field>
          <Field label="名字">
            <input
              className={inputCls}
              value={companion.name}
              onChange={(e) => void update({ ...companion, name: e.target.value })}
            />
          </Field>
          <Field label="性格">
            <textarea
              rows={2}
              className={inputCls}
              value={companion.personality}
              onChange={(e) => void update({ ...companion, personality: e.target.value })}
            />
          </Field>
          <Field label="背景">
            <textarea
              rows={2}
              className={inputCls}
              value={companion.background}
              onChange={(e) => void update({ ...companion, background: e.target.value })}
            />
          </Field>
          <Field label="口头禅">
            <input
              className={inputCls}
              value={companion.catchphrase}
              onChange={(e) => void update({ ...companion, catchphrase: e.target.value })}
            />
          </Field>

          <Field label="L2 核心档案（每行一条）">
            <textarea
              rows={4}
              className={inputCls}
              value={coreText}
              onChange={(e) => setCoreText(e.target.value)}
            />
            <button
              type="button"
              className="btn-press mt-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm text-neutral-600 dark:border-white/10 dark:text-stone-300"
              onClick={saveCore}
            >
              保存核心档案
            </button>
          </Field>
        </Section>
      )}
    </div>
  );
}
