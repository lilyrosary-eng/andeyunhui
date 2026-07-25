// 摄取对话框（设置页内可见）：选择本地文件或粘贴文本，摄取进知识库。

const React = window.__HOST_REACT__;
const { useState } = React;

import { ingestDocument } from '../ingest/ingest-pipeline';
import type { RagSourceInfo } from '../api/host';

interface IngestDialogProps {
  onIngested?: (info: RagSourceInfo) => void;
}

function fileNameFromPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return norm.split('/').pop() || p;
}

export function IngestDialog({ onIngested }: IngestDialogProps) {
  const [title, setTitle] = useState('');
  const [filePath, setFilePath] = useState('');
  const [pasted, setPasted] = useState('');
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function pickFile() {
    try {
      const files = await window.__HOST_API__.invoke<string[]>('pick_file', {
        title: '选择要摄取的文档',
        filters: [
          { name: '文档', extensions: ['txt', 'md', 'pdf', 'docx', 'pptx', 'xlsx', 'epub', 'csv'] },
          { name: '全部', extensions: ['*'] },
        ],
      });
      if (files && files.length > 0) {
        setFilePath(files[0]);
        if (!title.trim()) setTitle(fileNameFromPath(files[0]));
      }
    } catch {
      /* 用户取消 */
    }
  }

  async function doIngest() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'file') {
        if (!filePath.trim()) throw new Error('请先选择文件');
        const info = await ingestDocument({
          title: title.trim() || fileNameFromPath(filePath),
          uri: filePath,
          filePath,
          type: 'file',
        });
        setMsg({ kind: 'ok', text: `已摄取「${title || fileNameFromPath(filePath)}」（${info.chunk_count} 块）` });
        onIngested?.({
          id: info.source_id,
          title: title || fileNameFromPath(filePath),
          uri: filePath,
          type: 'file',
          created_at: new Date().toISOString(),
          chunk_count: info.chunk_count,
          status: 'ready',
        });
      } else {
        if (!pasted.trim()) throw new Error('请粘贴文本');
        const t = title.trim() || `粘贴文本 ${new Date().toLocaleString()}`;
        const info = await ingestDocument({
          title: t,
          uri: 'pasted:' + Date.now(),
          text: pasted,
          type: 'text',
        });
        setMsg({ kind: 'ok', text: `已摄取「${t}」（${info.chunk_count} 块）` });
        onIngested?.({
          id: info.source_id,
          title: t,
          uri: 'pasted:' + Date.now(),
          type: 'text',
          created_at: new Date().toISOString(),
          chunk_count: info.chunk_count,
          status: 'ready',
        });
        setPasted('');
      }
      setTitle('');
      setFilePath('');
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <button
          onClick={() => setMode('file')}
          className={`btn-press px-3 py-1.5 rounded-lg text-sm ${mode === 'file' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
        >
          本地文件
        </button>
        <button
          onClick={() => setMode('text')}
          className={`btn-press px-3 py-1.5 rounded-lg text-sm ${mode === 'text' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
        >
          粘贴文本
        </button>
      </div>

      <input
        value={title}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
        placeholder="来源标题（可选，默认用文件名）"
        className="rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/70 dark:bg-stone-800/70 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]"
      />

      {mode === 'file' ? (
        <div className="flex gap-2">
          <input
            value={filePath}
            readOnly
            placeholder="未选择文件"
            className="flex-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/40 px-3 py-2 text-sm text-neutral-500 dark:text-stone-400 truncate"
          />
          <button
            onClick={pickFile}
            className="btn-press px-3 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700"
          >
            选择…
          </button>
        </div>
      ) : (
        <textarea
          value={pasted}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasted(e.target.value)}
          placeholder="粘贴要摄取的纯文本 / Markdown…"
          rows={5}
          className="rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/70 dark:bg-stone-800/70 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)] resize-none"
        />
      )}

      <button
        onClick={doIngest}
        disabled={busy}
        className="btn-press px-4 py-2 rounded-lg bg-[var(--element-bg)] text-white text-sm disabled:opacity-50"
      >
        {busy ? '摄取中…' : '摄取到知识库'}
      </button>

      {msg && (
        <div className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-600' : 'text-red-500'}`}>
          {msg.kind === 'ok' ? '✓ ' : '⚠ '}
          {msg.text}
        </div>
      )}
    </div>
  );
}
