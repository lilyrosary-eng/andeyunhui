import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, RotateCw, Undo2, Check, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Slider } from '@/components/ui/slider';

interface Props {
  /** 选中图片的对象 URL 或 data URL */
  src: string;
  onCancel: () => void;
  onDone: (dataUrl: string, angle: number, flipH: boolean) => void;
}

interface HistoryEntry {
  angle: number;
  flipH: boolean;
}

const BOX_W = 320;
const BOX_H = 200;
const MAX_OUTPUT = 1600;

/** 图片按角度旋转后的外接矩形尺寸 */
function rotatedBox(w: number, h: number, deg: number): { w: number; h: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: w * c + h * s, h: w * s + h * c };
}

/** 把图片按角度/翻转绘制到画布中心（scale=1 时按自然尺寸绘制） */
function drawImageRotated(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  deg: number,
  flipH: boolean,
  cw: number,
  ch: number,
  scale: number,
) {
  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.scale(flipH ? -1 : 1, 1);
  ctx.scale(scale, scale);
  ctx.drawImage(img, -img.width / 2, -img.height / 2, img.width, img.height);
  ctx.restore();
}

/** 归一化角度到 [-180, 180) */
function normalizeAngle(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

export function BackgroundImageEditor({ src, onCancel, onDone }: Props) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [ready, setReady] = useState(false);
  const [angle, setAngle] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // 加载图片
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setAngle(0);
      setFlipH(false);
      setHistory([]);
      setReady(true);
    };
    img.src = src;
    return () => { img.onload = null; };
  }, [src]);

  // 重绘预览（整图按当前角度/翻转居中显示，自适应缩放）
  useEffect(() => {
    const c = canvasRef.current;
    const img = imgRef.current;
    if (!c || !img || !ready) return;
    const box = rotatedBox(img.width, img.height, angle);
    const scale = Math.min(BOX_W / box.w, BOX_H / box.h, 1);
    c.width = BOX_W;
    c.height = BOX_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    drawImageRotated(ctx, img, angle, flipH, BOX_W, BOX_H, scale);
  }, [angle, flipH, ready]);

  const pushHistory = useCallback(() => {
    setHistory((h) => [...h, { angle, flipH }].slice(-50));
  }, [angle, flipH]);

  const quickRotate = useCallback((dir: number) => {
    pushHistory();
    setAngle((a) => normalizeAngle(a + dir * 90));
  }, [pushHistory]);

  const flip = useCallback(() => {
    pushHistory();
    setFlipH((f) => !f);
  }, [pushHistory]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setAngle(prev.angle);
    setFlipH(prev.flipH);
  }, [history]);

  const handleDone = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    // 导出原图（最长边限制），旋转/翻转交由背景层以 CSS transform 应用，
    // 避免裁掉内容或导出后四角透出底色。
    let ow = img.width;
    let oh = img.height;
    const m = Math.max(ow, oh);
    if (m > MAX_OUTPUT) {
      const k = MAX_OUTPUT / m;
      ow = Math.round(ow * k);
      oh = Math.round(oh * k);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, ow);
    canvas.height = Math.max(1, oh);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, ow, oh);
    onDone(canvas.toDataURL('image/jpeg', 0.85), angle, flipH);
  }, [angle, flipH, onDone]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-stone-800 border border-white/80 dark:border-stone-700/50 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200/60 dark:border-stone-700/50">
          <h3 className="text-sm font-medium text-neutral-700 dark:text-stone-200">{t('settings.themes.bgEditorTitle')}</h3>
          <button onClick={onCancel} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 flex flex-col items-center gap-4">
          <div
            className="rounded-lg overflow-hidden bg-neutral-100 dark:bg-stone-900 flex items-center justify-center"
            style={{ width: BOX_W, height: BOX_H }}
          >
            <canvas ref={canvasRef} style={{ width: BOX_W, height: BOX_H, display: 'block' }} />
          </div>

          <div className="w-full">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-neutral-500 dark:text-stone-400">{t('settings.themes.bgEditorAngle')}</span>
              <span className="text-xs text-neutral-500 dark:text-stone-400">{Math.round(angle)}°</span>
            </div>
            <Slider
              value={[angle]}
              onValueChange={([v]: number[]) => setAngle(v)}
              min={-180}
              max={180}
              step={1}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => quickRotate(-1)}
              title={t('settings.themes.bgEditorRotateLeft')}
              className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700 transition-colors"
            >
              <RotateCcw size={15} /> {t('settings.themes.bgEditorRotateLeft')}
            </button>
            <button
              onClick={flip}
              title={t('settings.themes.bgEditorFlip')}
              className="btn-press px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700 transition-colors"
            >
              {t('settings.themes.bgEditorFlip')}
            </button>
            <button
              onClick={() => quickRotate(1)}
              title={t('settings.themes.bgEditorRotate')}
              className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700 transition-colors"
            >
              <RotateCw size={15} /> {t('settings.themes.bgEditorRotate')}
            </button>
            <button
              onClick={undo}
              disabled={history.length === 0}
              title={t('settings.themes.bgEditorUndo')}
              className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <Undo2 size={15} /> {t('settings.themes.bgEditorUndo')}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-200/60 dark:border-stone-700/50">
          <button
            onClick={onCancel}
            className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700 transition-colors"
          >
            <X size={15} /> {t('settings.themes.bgEditorCancel')}
          </button>
          <button
            onClick={handleDone}
            className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[var(--element-color-raw)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Check size={15} /> {t('settings.themes.bgEditorDone')}
          </button>
        </div>
      </div>
    </div>
  );
}
