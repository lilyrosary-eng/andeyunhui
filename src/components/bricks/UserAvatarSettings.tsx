// 用户头像设置卡（通用积木）：emoji 单字符 或 上传图片（缩到 256x256 data:image/png），
// 实时同步到 localStorage + window 'user-avatar-changed' 事件 + useUserAvatar 订阅。
// 跨模块通用能力：设置 / AI 对话 / 伴侣 等模块都可复用。
import { useRef, useState } from 'react';
import { Upload, RotateCcw } from 'lucide-react';
import { useUserAvatar, setUserAvatar } from '@/core/avatar/userAvatar';
import { inputCls } from '@/components/bricks/formui';

const MAX_DIM = 256;
const JPEG_QUALITY = 0.85;

/** 把任意图片 file 缩到 ≤256x256 并导出 data:image/jpeg。 */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onerror = () => reject(new Error('图片解析失败'));
    im.onload = () => resolve(im);
    im.src = dataUrl;
  });
  const { width, height } = img;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

export function UserAvatarSettings() {
  const current = useUserAvatar();
  const [emoji, setEmoji] = useState<string>(() =>
    current.startsWith('data:image/') ? '你' : current,
  );
  const [hint, setHint] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isImage = current.startsWith('data:image/');

  const applyEmoji = () => {
    const v = emoji.trim() || '你';
    setUserAvatar(v);
    setHint(`已设为「${v.slice(0, 4)}」`);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setUserAvatar(dataUrl);
      setHint('已用上传的图片');
    } catch (e) {
      setHint(`上传失败：${String(e).slice(0, 60)}`);
    }
  };

  const reset = () => {
    setUserAvatar('你');
    setEmoji('你');
    setHint('已恢复默认');
  };

  return (
    <div className="rounded-xl border border-black/10 p-4 dark:border-white/10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">用户头像</div>
          <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">
            对话气泡里你的头像。emoji 单字符，或上传图片（自动缩到 256×256）。
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isImage ? (
            <img
              src={current}
              alt="你"
              className="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-black/5 dark:ring-white/10"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-700 text-base font-bold text-white dark:bg-stone-600">
              {(current || '你').slice(0, 2)}
            </div>
          )}
          <button
            type="button"
            onClick={reset}
            title="恢复默认"
            className="btn-press flex h-9 w-9 items-center justify-center rounded-lg border border-black/10 text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/5"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputCls} flex-1 min-w-[120px]`}
          value={emoji}
          maxLength={8}
          placeholder="emoji 或 1–2 字（默认「你」）"
          onChange={(e) => setEmoji(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyEmoji();
          }}
        />
        <button
          type="button"
          onClick={applyEmoji}
          className="btn-press rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white"
        >
          应用
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/5"
        >
          <Upload size={14} />上传图片
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {hint && (
        <div className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">{hint}</div>
      )}
    </div>
  );
}