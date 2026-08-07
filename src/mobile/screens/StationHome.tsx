/**
 * StationHome — 中转站 Tab 根屏（对齐桌面「中转站」语义）。
 *
 * 中转站 = 文件暂存箱，不是传输面板。与桌面 TransferStationPanel 同一语义、同一存储：
 *   `<app_data>/transfer_station/dropzone/`
 * 桌面通过窗口拖入投递文件，移动端则由「传输接收落地」与后续分享入口投递。
 *
 * 能力（移动端最小可用子集）：
 *   - 列出暂存文件（大小 / 时间 / 类型）
 *   - 文本类文件点击预览（BottomSheet，上限 2MB）
 *   - 单个删除 / 全部清空
 *
 * 传输能力（发现设备、发送、接收）已移至：发现 → 茑萝 → 传输（TransferScreen）。
 * 二者职责分离，避免中转站被当成传输面板。
 *
 * 后端命令由 src-tauri/src/android/dropzone.rs 提供（桌面同名能力在 commands.rs，
 * 因该模块为 Windows 专属故移动端另行提供跨平台子集，存储布局完全一致）。
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fmtSize } from '../../lib/formatSize';
import {
  Inbox,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  File as FileIcon,
  Trash2,
  RefreshCw,
  Eye,
} from 'lucide-react';
import { BottomSheet } from '../components/BottomSheet';
import { useNavStore } from '../stores/navStore';
import { EVENTS } from '@/core/events/schema';

/** 与 Rust DropzoneFile 对应（serde camelCase）。 */
interface DropzoneFile {
  fileId: string;
  originalName: string;
  extension: string;
  size: number;
  storedPath: string;
  absolutePath: string;
  importedAt: string;
  isReadable: boolean;
}

function fmtTime(ms: string): string {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  const now = Date.now();
  const diff = now - n;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'];
const AUDIO_EXTS = ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'];
const ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz'];

function FileTypeIcon({ ext, readable }: { ext: string; readable: boolean }) {
  const size = 20;
  if (IMAGE_EXTS.includes(ext)) return <ImageIcon size={size} />;
  if (VIDEO_EXTS.includes(ext)) return <Film size={size} />;
  if (AUDIO_EXTS.includes(ext)) return <Music size={size} />;
  if (ARCHIVE_EXTS.includes(ext)) return <Archive size={size} />;
  if (readable) return <FileText size={size} />;
  return <FileIcon size={size} />;
}

export function StationHome() {
  const [files, setFiles] = useState<DropzoneFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const setBottomSheetOpen = useNavStore((s) => s.setBottomSheetOpen);
  const bottomSheetOpen = useNavStore((s) => s.bottomSheetOpen);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<DropzoneFile[]>('dropzone_list');
      setFiles(list);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 传输接收完成后文件落入中转站 → 自动刷新列表
    const un = listen(EVENTS.transfer.progress, (e) => {
      const p = e.payload as { done?: boolean; direction?: string };
      if (p?.done && p.direction === 'recv') void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  // BottomSheet 开合同步（供 Android 返回键拦截）
  const anySheet = !!preview || confirmClear;
  useEffect(() => {
    setBottomSheetOpen(anySheet);
    return () => setBottomSheetOpen(false);
  }, [anySheet, setBottomSheetOpen]);

  // 反向同步：返回键置 false 时关闭本地 sheet
  useEffect(() => {
    if (!bottomSheetOpen && anySheet) {
      setPreview(null);
      setConfirmClear(false);
    }
  }, [bottomSheetOpen, anySheet]);

  const onPreview = async (f: DropzoneFile) => {
    if (!f.isReadable) return;
    try {
      const content = await invoke<string>('dropzone_read_text', { storedPath: f.storedPath });
      setPreview({ name: f.originalName, content });
    } catch (err) {
      setPreview({ name: f.originalName, content: `读取失败：${String(err)}` });
    }
  };

  const onDelete = async (f: DropzoneFile) => {
    try {
      await invoke('dropzone_delete', { storedPath: f.storedPath });
      setFiles((prev) => prev.filter((x) => x.storedPath !== f.storedPath));
    } catch {
      /* 忽略：下次刷新会纠正 */
    }
  };

  const onClear = async () => {
    try {
      await invoke('dropzone_clear');
      setFiles([]);
    } catch {
      /* 忽略 */
    }
    setConfirmClear(false);
  };

  const totalSize = files.reduce((s, f) => s + f.size, 0);

  return (
    <div
      className="flex flex-col h-full overflow-y-auto overscroll-contain"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      {/* ===== 概览卡 ===== */}
      <section className="px-4 pt-3">
        <div
          className="rounded-2xl p-4 bg-[var(--card)] border border-[var(--border)] flex items-center gap-3"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <span
            className="flex items-center justify-center rounded-xl shrink-0"
            style={{
              width: '44px',
              height: '44px',
              background: 'var(--element-muted)',
              color: 'var(--element-bg)',
            }}
          >
            <Inbox size={22} />
          </span>
          <div className="flex-1 min-w-0">
            <div
              className="font-semibold text-[var(--foreground)]"
              style={{ fontSize: 'var(--m-text-headline)' }}
            >
              暂存 {files.length} 个文件
            </div>
            <div
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              共 {fmtSize(totalSize)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="刷新"
            className="flex items-center justify-center shrink-0 text-[var(--foreground)] active:scale-95 transition-transform"
            style={{ width: 'var(--touch-min)', height: 'var(--touch-min)' }}
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
          {files.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              aria-label="清空"
              className="flex items-center justify-center shrink-0 text-[var(--muted-foreground)] active:scale-95 transition-transform"
              style={{ width: 'var(--touch-min)', height: 'var(--touch-min)' }}
            >
              <Trash2 size={20} />
            </button>
          )}
        </div>
      </section>

      {/* ===== 文件列表 ===== */}
      <section className="px-4 pt-3 pb-4">
        {loading ? null : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-14 rounded-2xl border border-dashed border-[var(--border)]">
            <Inbox size={40} className="text-[var(--muted-foreground)] mb-3" />
            <p className="text-[var(--foreground)] mb-1" style={{ fontSize: 'var(--m-text-body)' }}>
              中转站是空的
            </p>
            <p
              className="text-[var(--muted-foreground)] px-8"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              通过「发现 → 茑萝 → 传输」接收的文件会自动存放到这里
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {files.map((f) => (
              <div
                key={f.storedPath}
                className="flex items-center gap-3 px-3 py-3 rounded-2xl bg-[var(--card)] border border-[var(--border)]"
              >
                <span
                  className="flex items-center justify-center rounded-xl shrink-0"
                  style={{
                    width: '40px',
                    height: '40px',
                    background: 'var(--element-muted)',
                    color: 'var(--element-bg)',
                  }}
                >
                  <FileTypeIcon ext={f.extension} readable={f.isReadable} />
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    className="font-medium text-[var(--foreground)] truncate"
                    style={{ fontSize: 'var(--m-text-body)' }}
                  >
                    {f.originalName}
                  </div>
                  <div
                    className="text-[var(--muted-foreground)]"
                    style={{ fontSize: 'var(--m-text-caption)' }}
                  >
                    {fmtSize(f.size)}
                    {f.importedAt ? ` · ${fmtTime(f.importedAt)}` : ''}
                  </div>
                </div>
                {f.isReadable && (
                  <button
                    type="button"
                    onClick={() => void onPreview(f)}
                    aria-label="预览"
                    className="flex items-center justify-center shrink-0 text-[var(--muted-foreground)] active:scale-90 transition-transform"
                    style={{ width: '40px', height: '40px' }}
                  >
                    <Eye size={18} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onDelete(f)}
                  aria-label="删除"
                  className="flex items-center justify-center shrink-0 text-[var(--muted-foreground)] active:scale-90 transition-transform"
                  style={{ width: '40px', height: '40px' }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== 文本预览 ===== */}
      <BottomSheet
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.name ?? ''}
      >
        <div className="px-4 pb-4">
          <pre
            className="whitespace-pre-wrap break-all text-[var(--foreground)] max-h-[55vh] overflow-y-auto rounded-xl p-3"
            style={{ fontSize: 'var(--m-text-caption)', background: 'var(--muted)' }}
          >
            {preview?.content}
          </pre>
        </div>
      </BottomSheet>

      {/* ===== 清空确认 ===== */}
      <BottomSheet open={confirmClear} onClose={() => setConfirmClear(false)} title="清空中转站">
        <div className="px-4 pb-4">
          <p
            className="text-[var(--muted-foreground)] mb-4"
            style={{ fontSize: 'var(--m-text-body)' }}
          >
            将删除全部 {files.length} 个暂存文件，此操作不可撤销。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)' }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void onClear()}
              className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform"
              style={{
                fontSize: 'var(--m-text-label)',
                background: 'var(--destructive)',
                color: 'var(--destructive-foreground)',
              }}
            >
              清空
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
