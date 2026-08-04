// 伴侣卡 + 编辑面板（人机恋记忆点，阶段 1 · Android 优先）。
//
// 伴侣卡：AI 对话 Tab 顶部一条轻量横卡，展示名字 / 亲密度 / 信任 / 默契 / 记忆数，
// 点击打开编辑面板。
// 编辑面板：编辑人格字段（名字 / 头像 emoji / 性格 / 背景 / 口头禅）+ 查看长期记忆列表。

import { useRef, useState } from 'react';
import { Heart, Brain, Sparkles, Check, X, ImagePlus } from 'lucide-react';
import { BottomSheet } from '../BottomSheet';
import { useCompanionStore, type Companion } from '../../stores/companionStore';

/** 把选中的图片文件读成 data URL（限制 3MB，避免 JSON 膨胀） */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 3 * 1024 * 1024) {
      reject(new Error('图片过大（>3MB），请换一张'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/** 头像渲染：data URL（图片/GIF）走 img，否则当 emoji 文本 */
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

/**
 * 综合亲密度（对外唯一展示口径，不暴露六维细节）。
 * 加权：亲密 40% + 温暖 30% + 信任 20% + 好奇/耐心 10%。（张力不纳入正向）
 */
function overallAffinity(r: { warmth: number; trust: number; intimacy: number; intrigue: number; patience: number; tension?: number }): number {
  const w = (r.warmth ?? 0) * 0.3 + (r.trust ?? 0) * 0.2 + (r.intimacy ?? 0) * 0.4 + (r.intrigue ?? 0) * 0.05 + (r.patience ?? 0) * 0.05;
  return Math.round(Math.min(100, Math.max(0, w)));
}

/** 顶部伴侣卡（常驻在算力来源条下方） */
export function CompanionCard({ onPress }: { onPress: () => void }) {
  const companion = useCompanionStore((s) => s.companion);
  const r = companion.relationship;

  return (
    <button
      type="button"
      onClick={onPress}
      className="mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)]/80 px-3 py-2 active:opacity-70 transition-opacity"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      <Avatar value={companion.avatar || ''} size={28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-[var(--foreground)] truncate" style={{ fontSize: 'var(--m-text-label)' }}>
            {companion.name || '未命名'}
          </span>
          <span className="text-[var(--muted-foreground)] shrink-0" style={{ fontSize: 'var(--m-text-overline)' }}>
            {companion.memories.length} 段记忆
          </span>
        </div>
        {/* 亲密度进度条（综合值，不暴露六维细节） */}
        <div className="mt-1 flex items-center gap-1.5">
          <Heart size={12} className="shrink-0 text-[var(--element-bg)]" />
          <div className="h-1.5 flex-1 rounded-full bg-[var(--muted)]/50 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${overallAffinity(r)}%`, background: 'var(--element-bg)' }}
            />
          </div>
          <span className="text-[var(--muted-foreground)] shrink-0" style={{ fontSize: 'var(--m-text-overline)' }}>
            亲密度 {overallAffinity(r)}%
          </span>
        </div>
      </div>
      <Sparkles size={16} className="shrink-0 text-[var(--muted-foreground)]" />
    </button>
  );
}

/** 伴侣编辑面板 */
export function CompanionEditSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (c: Companion) => Promise<void>;
}) {
  const companion = useCompanionStore((s) => s.companion);
  const [draft, setDraft] = useState({
    name: companion.name,
    avatar: companion.avatar,
    personality: companion.personality,
    background: companion.background,
    catchphrase: companion.catchphrase,
  });
  const [saving, setSaving] = useState(false);

  // open 变化时同步草稿（避免 stale）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setDraft({
        name: companion.name,
        avatar: companion.avatar,
        personality: companion.personality,
        background: companion.background,
        catchphrase: companion.catchphrase,
      });
    }
  }

  const r = companion.relationship;
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState('');

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...companion, ...draft });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setDraft((d) => ({ ...d, avatar: dataUrl }));
      setAvatarError('');
    } catch (e) {
      setAvatarError(String((e as Error)?.message ?? '读取失败'));
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
    multiline = false,
  ) => (
    <label className="block">
      <span className="block text-[var(--muted-foreground)] mb-1" style={{ fontSize: 'var(--m-text-caption)' }}>
        {label}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)] resize-none"
          style={{ fontSize: 'var(--m-text-body)' }}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
          style={{ fontSize: 'var(--m-text-body)' }}
        />
      )}
    </label>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title="伴侣">
      <div className="px-4 pb-5 flex flex-col gap-3 max-h-[65vh] overflow-y-auto">
        {/* 关系状态卡（对外只展示综合亲密度，六维为内部机制） */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--input)]/40 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Heart size={16} className="text-[var(--element-bg)]" />
            <span className="text-[var(--foreground)] font-medium" style={{ fontSize: 'var(--m-text-label)' }}>
              关系亲密度
            </span>
            <span className="ml-auto text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
              认识 {r.first_met_at ? Math.max(1, Math.floor((Date.now() / 1000 - r.first_met_at) / 86400)) : 0} 天
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-[var(--muted)]/50 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${overallAffinity(r)}%`, background: 'var(--element-bg)' }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-medium text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
              {overallAffinity(r)}%
            </span>
          </div>
          <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
            关系会随对话慢慢变亲近，长时间不聊会变淡。
          </p>
        </div>

        {/* 人格编辑 */}
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-[var(--element-bg)]" />
          <span className="text-[var(--foreground)] font-medium" style={{ fontSize: 'var(--m-text-label)' }}>
            人格设定
          </span>
        </div>
        {field('名字', draft.name, (v) => setDraft((d) => ({ ...d, name: v })), '小灯')}

        {/* 头像：emoji 或图片/GIF 上传 */}
        <div>
          <span className="block text-[var(--muted-foreground)] mb-1" style={{ fontSize: 'var(--m-text-caption)' }}>
            头像（emoji 或图片/GIF）
          </span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft.avatar.startsWith('data:image/') ? '' : draft.avatar}
              onChange={(e) => setDraft((d) => ({ ...d, avatar: e.target.value }))}
              placeholder="输入 emoji，如 💡"
              className="flex-1 rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
              style={{ fontSize: 'var(--m-text-body)' }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-lg px-3 py-2 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-95 transition-transform flex items-center gap-1.5"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              <ImagePlus size={16} /> 上传
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.gif"
              className="hidden"
              onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>
          {avatarError && (
            <p className="mt-1 text-[var(--danger)]" style={{ fontSize: 'var(--m-text-caption)' }}>
              {avatarError}
            </p>
          )}
          {draft.avatar.startsWith('data:image/') && (
            <div className="mt-2 flex items-center gap-2">
              <Avatar value={draft.avatar} size={40} />
              <span className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                已选择图片
              </span>
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, avatar: '' }))}
                className="text-[var(--danger)] ml-auto"
                style={{ fontSize: 'var(--m-text-caption)' }}
              >
                移除
              </button>
            </div>
          )}
        </div>

        {field('性格', draft.personality, (v) => setDraft((d) => ({ ...d, personality: v })), '温柔体贴、善解人意…', true)}
        {field('背景故事', draft.background, (v) => setDraft((d) => ({ ...d, background: v })), '你是「安得云荟」里的 AI 伴侣…', true)}
        {field('口头禅（可选）', draft.catchphrase, (v) => setDraft((d) => ({ ...d, catchphrase: v })), '')}

        {/* 记忆列表 */}
        <div className="flex items-center gap-2 mt-1">
          <Sparkles size={16} className="text-[var(--element-bg)]" />
          <span className="text-[var(--foreground)] font-medium" style={{ fontSize: 'var(--m-text-label)' }}>
            长期记忆（{companion.memories.length}）
          </span>
        </div>
        {companion.memories.length === 0 ? (
          <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
            还没有记忆。和 TA 多聊几轮，TA 会自动把重要的事记下来。
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {companion.memories.slice(0, 30).map((m) => (
              <div key={m.id} className="rounded-lg border border-[var(--border)] bg-[var(--input)]/30 px-2.5 py-2">
                <div className="text-[var(--foreground)] leading-snug" style={{ fontSize: 'var(--m-text-caption)' }}>
                  {m.content}
                </div>
                <div className="mt-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
                  {new Date(m.created_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
            style={{ fontSize: 'var(--m-text-label)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform disabled:opacity-50"
            style={{ fontSize: 'var(--m-text-label)', background: 'var(--element-bg)', color: 'var(--element-fg)' }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
