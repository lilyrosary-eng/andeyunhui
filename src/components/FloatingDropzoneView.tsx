import { useEffect, useState, useRef, type CSSProperties } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { openPath } from '@tauri-apps/plugin-opener';
import { X, Inbox, ScanText, Languages, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { TransferStationPanel, emitDropzoneChange } from '@/components/TransferStationPanel';
import { api, type ImportedFile } from '@/lib/api';
import {
  SOURCE_LANGS,
  TARGET_LANGS,
  loadSourceLang,
  loadTargetLang,
  saveSourceLang,
  saveTargetLang,
} from '@/lib/translateLanguages';

// 本地 PaddleOCR 引擎懒加载（与 TransferStationPanel 共享模式）
let _paddleOcrLoading: Promise<any> | null = null;
async function loadPaddleOcr(): Promise<any> {
  const w = window as any;
  if (w.__EXT_PADDLEOCR__?._v === 2) return w.__EXT_PADDLEOCR__;
  delete w.__EXT_PADDLEOCR__;
  _paddleOcrLoading = null;
  _paddleOcrLoading = (async () => {
    const code = await invoke<string>('read_external_dep_file', { relativePath: '全局/paddleocr/index.js' });
    if (!code) throw new Error('本地 OCR 引擎未找到（external-deps/全局/paddleocr/index.js 不存在）');
    new Function(code)();
    if (!w.__EXT_PADDLEOCR__) throw new Error('OCR 引擎已读取但挂载失败（window.__EXT_PADDLEOCR__ 未定义）');
    return w.__EXT_PADDLEOCR__;
  })();
  return _paddleOcrLoading;
}

const win = getCurrentWindow();

// 浮窗顶栏按钮样式
const hdrBtn: CSSProperties = {
  background: 'rgba(208,232,214,0.5)',
  border: '1px solid rgba(110,175,135,0.5)',
  color: 'rgba(35,64,47,0.85)',
  cursor: 'pointer',
  padding: '3px 8px',
  borderRadius: 6,
  fontSize: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
};
const miniBtn: CSSProperties = {
  background: 'rgba(208,232,214,0.7)',
  border: '1px solid rgba(110,175,135,0.5)',
  color: '#23402f',
  cursor: 'pointer',
  padding: '3px 10px',
  borderRadius: 6,
  fontSize: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};
const miniBtnPrimary: CSSProperties = {
  ...miniBtn,
  background: 'rgba(110,175,135,0.85)',
  color: '#fff',
  fontWeight: 600,
};
const taStyle: CSSProperties = {
  flex: 1,
  resize: 'none',
  borderRadius: 10,
  border: '1px solid rgba(110,175,135,0.4)',
  padding: 8,
  fontSize: 13,
  fontFamily: 'inherit',
  background: 'rgba(255,255,255,0.5)',
  color: '#23402f',
  minHeight: 0,
  outline: 'none',
};

/**
 * 中转站浮窗子窗口 — 与图标栏「中转站」共享同一后端数据源（dropzone 目录），
 * 后端所有写入/删除命令都会 emit `dropzone-changed`，主窗口与浮窗各自监听后实时刷新，保持一致。
 *
 * 浮窗自身也支持拖入 / 粘贴文件（走与主窗口一致的 addBytesToDropzone），并暴露文本文件的「打开」按钮。
 */
export function FloatingDropzoneView() {
  // 是否正在从外部拖入文件（OS 拖放进行中）。用 ref 而非 state，避免触发重渲染。
  // 关键：拖放进行中调用 win.setSize 会让 Windows 取消本次拖放，故切换模式时需跳过 resize。
  const draggingRef = useRef(false);

  // 浮窗透明效果
  useEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
  }, []);

  // 后端写入中转站后会 emit `dropzone-changed`，触发面板重新拉取（与图标栏同步）
  useEffect(() => {
    const un = listen<null>('dropzone-changed', () => {
      emitDropzoneChange();
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // 浮窗内拖入 / 粘贴文件 → 导入中转站（与主窗口拖放一致）
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        draggingRef.current = true;
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        draggingRef.current = true;
        e.preventDefault();
      }
    };
    const endDrag = () => {
      draggingRef.current = false;
    };
    const onDrop = async (e: DragEvent) => {
      // 拖到 OCR 工作区时由工作区自行处理（OCR），不要在这里导入中转站
      if ((e.target as HTMLElement).closest('[data-ocr-drop]')) return;
      const dt = e.dataTransfer;
      if (!dt || dt.files.length === 0) return;
      e.preventDefault();
      for (const file of Array.from(dt.files)) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          await api.addBytesToDropzone(dataUrl, file.name);
        } catch (err) {
          console.error('[浮窗] 导入失败:', err);
        }
      }
    };
    const onPaste = async (e: ClipboardEvent) => {
      // 聚焦在 OCR 工作区或翻译输入框时不拦截粘贴，交由对应组件处理
      if ((e.target as HTMLElement).closest('[data-ocr-drop]') || (e.target as HTMLElement).closest('textarea, input')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      // 优先处理剪贴板中的文件
      for (const it of Array.from(items)) {
        if (it.kind === 'file') {
          const file = it.getAsFile();
          if (!file) continue;
          e.preventDefault();
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await api.addBytesToDropzone(dataUrl, file.name);
          } catch (err) {
            console.error('[浮窗] 粘贴导入失败:', err);
          }
          return;
        }
      }
      // 纯文本：以 .txt 存入中转站
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        const name = `剪贴板_${Date.now()}.txt`;
        const b64 = 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(text)));
        try {
          await api.addBytesToDropzone(b64, name);
        } catch (err) {
          console.error('[浮窗] 文本粘贴失败:', err);
        }
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', endDrag);
    window.addEventListener('drop', onDrop);
    window.addEventListener('drop', endDrag);
    window.addEventListener('dragend', endDrag);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', endDrag);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('drop', endDrag);
      window.removeEventListener('dragend', endDrag);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  const handleClose = () => {
    try {
      void win.destroy();
    } catch {
      try {
        void win.close();
      } catch {
        /* ignore */
      }
    }
  };

  const handleTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    void win.startDragging();
  };

  // 浮窗环境无笔记编辑器，文本文件「打开」直接用系统默认应用打开
  const handleOpenReadableFile = async (file: ImportedFile, _content: string) => {
    try {
      if (file.absolutePath) await openPath(file.absolutePath);
    } catch (err) {
      console.error('[浮窗] 打开文件失败:', err);
    }
  };

  // OCR / 翻译 拓展模式：点击后展开浮窗为独立工作区（不局限于中转站已存文件）
  const [mode, setMode] = useState<'list' | 'ocr' | 'translate'>('list');
  const switchMode = async (m: 'list' | 'ocr' | 'translate') => {
    setMode(m);
    // 切换 OCR / 翻译 工作区时保持浮窗原尺寸，不再扩展为大窗。
    // 注意：拖放进行中（draggingRef）严禁调用 setSize —— Windows 会在窗口尺寸变化时
    // 取消正在进行的 OS 拖放，导致文件无法落入 OCR 工作区。拖放结束后由 drop 处理再决定尺寸。
    if (draggingRef.current) return;
    const w = 420;
    const h = 520;
    try {
      await win.setSize(new LogicalSize(w, h));
    } catch {
      /* 非致命：窗口尺寸调整失败时忽略，内容仍可滚动 */
    }
  };

  return (
    <div
      className="floating-dropzone-root"
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'transparent',
        color: '#23402f',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        borderRadius: '16px',
        overflow: 'hidden',
        border: '1px solid rgba(110, 175, 135, 0.55)',
      }}
    >
      {/* 顶部拖拽条 + 关闭 */}
      <div
        onMouseDown={handleTitleMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          height: '30px',
          flexShrink: 0,
          padding: '0 8px',
          cursor: 'move',
          userSelect: 'none',
          background: 'rgba(208, 232, 214, 0.5)',
          borderBottom: '1px solid rgba(110, 175, 135, 0.4)',
        }}
      >
        <Inbox size={14} style={{ opacity: 0.7, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: '12px', letterSpacing: '0.5px' }}>
          中转站
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => switchMode('list')}
          title="返回中转站文件列表"
          style={{ ...hdrBtn, background: mode === 'list' ? 'rgba(110,175,135,0.4)' : hdrBtn.background }}
        >
          <Inbox size={13} /> 中转站
        </button>
        <button
          onClick={() => switchMode(mode === 'ocr' ? 'list' : 'ocr')}
          onDragEnter={(e) => {
            e.preventDefault();
            if (mode !== 'ocr') void switchMode('ocr');
          }}
          onDragOver={(e) => {
            e.preventDefault();
            // 拖拽文件悬停时持续触发，作为 onDragEnter 的可靠补充，确保自动进入 OCR 页
            if (mode !== 'ocr') void switchMode('ocr');
          }}
          onDrop={(e) => {
            // 直接丢在按钮上时不导入中转站，交由已切换的 OCR 工作区处理（阻止冒泡到 window 导入逻辑）
            e.preventDefault();
            e.stopPropagation();
          }}
          title="拓展为 OCR 工作区：拖入 / 选择图片即识别文字（拖拽文件悬停此处自动进入）"
          style={{ ...hdrBtn, background: mode === 'ocr' ? 'rgba(110,175,135,0.4)' : hdrBtn.background }}
        >
          <ScanText size={13} /> OCR
        </button>
        <button
          onClick={() => switchMode(mode === 'translate' ? 'list' : 'translate')}
          title="拓展为翻译工作区：粘贴文字即翻译"
          style={{ ...hdrBtn, background: mode === 'translate' ? 'rgba(110,175,135,0.4)' : hdrBtn.background }}
        >
          <Languages size={13} /> 翻译
        </button>
        <button
          onClick={handleClose}
          title="关闭"
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(35,64,47,0.6)',
            cursor: 'pointer',
            padding: '4px',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* 中转站主体 / OCR / 翻译 工作区（OCR·翻译 为独立拓展框，不局限于已存文件） */}
      <div style={{ flex: 1, overflow: 'hidden', background: 'rgba(224, 240, 228, 0.45)', display: 'flex' }}>
        {mode === 'list' ? (
          <TransferStationPanel variant="floating" onOpenReadableFile={handleOpenReadableFile} />
        ) : mode === 'ocr' ? (
          <OcrBox />
        ) : (
          <TranslateBox />
        )}
      </div>
    </div>
  );
}

/** OCR 工作区：拖入 / 选择图片 → AI 视觉 OCR，结果可复制或存入中转站（不局限于已存文件） */
function OcrBox() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDataUrl, setLastDataUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (dataUrl: string) => {
    setLoading(true);
    setError(null);
    setLastDataUrl(dataUrl);
    try {
      const [meta, b64] = dataUrl.split(',');
      const mime = (meta.match(/data:([^;]+)/)?.[1]) || 'image/png';
      const res = await api.aiVisionOcr(b64, mime);
      setText(res || '');
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as any)?.message || 'OCR 失败，请检查 AI 配置';
      // 与中转站主站一致：云端未配置 API Key 时自动降级到本地 PaddleOCR 引擎
      if (msg.includes('未配置') || msg.includes('API Key')) {
        try {
          const local = await loadPaddleOcr();
          const text = await local.recognize(dataUrl);
          setText(text || '');
          setError(null);
          return;
        } catch (e2) {
          setError('本地 OCR 引擎识别失败：' + (typeof e2 === 'string' ? e2 : (e2 as any)?.message || e2));
          return;
        }
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => run(r.result as string);
    r.readAsDataURL(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => run(r.result as string);
    r.readAsDataURL(f);
  };

  const store = async () => {
    if (!lastDataUrl) return;
    try {
      await api.addBytesToDropzone(lastDataUrl, `ocr_${Date.now()}.png`);
    } catch {
      setError('存入中转站失败');
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 }}>
      <div
        data-ocr-drop
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{
          border: `1.5px dashed ${dragOver ? '#6eaf87' : 'rgba(110,175,135,0.5)'}`,
          borderRadius: 12,
          padding: '18px 12px',
          textAlign: 'center',
          cursor: 'pointer',
          color: 'rgba(35,64,47,0.7)',
          fontSize: 12,
          background: dragOver ? 'rgba(110,175,135,0.12)' : 'transparent',
          flexShrink: 0,
        }}
      >
        {loading ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Loader2 size={16} className="animate-spin" /> 识别中…
          </span>
        ) : (
          '拖入图片 / 点击选择图片 → AI 视觉 OCR'
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
      </div>
      {error && <div style={{ color: '#b45309', fontSize: 12, flexShrink: 0 }}>{error}</div>}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.7 }}>识别结果</span>
          <div style={{ flex: 1 }} />
          <button onClick={() => text && navigator.clipboard.writeText(text)} disabled={!text} style={miniBtn}>
            复制
          </button>
          <button onClick={store} disabled={!lastDataUrl} style={miniBtn}>
            存入中转站
          </button>
        </div>
        <textarea
          readOnly
          value={text}
          placeholder="OCR 文本将显示在这里…"
          style={taStyle}
        />
      </div>
    </div>
  );
}

/** 翻译工作区：粘贴 / 输入文字 → AI 翻译，结果可复制（不局限于已存文件） */
function TranslateBox() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceLang, setSourceLang] = useState<string>(() => loadSourceLang());
  const [targetLang, setTargetLang] = useState<string>(() => loadTargetLang());

  const run = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.translateText(input, targetLang, sourceLang);
      setOutput(res || '');
    } catch (e) {
      setError(typeof e === 'string' ? e : '翻译失败，请检查 AI 配置');
    } finally {
      setLoading(false);
    }
  };

  const langLabelStyle: CSSProperties = { fontSize: 12, opacity: 0.7, flexShrink: 0 };
  const langSelStyle: CSSProperties = {
    fontSize: 12,
    padding: '3px 8px',
    borderRadius: 8,
    border: '1px solid rgba(110,175,135,0.5)',
    background: 'rgba(255,255,255,0.7)',
    color: '#23402f',
    outline: 'none',
    flex: 1,
    minWidth: 0,
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 }}>
      {/* 当前语言：放在上方输入框（原文）上面，含「自动识别」 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={langLabelStyle}>当前语言</span>
        <select
          value={sourceLang}
          onChange={(e) => {
            setSourceLang(e.target.value);
            saveSourceLang(e.target.value);
          }}
          style={langSelStyle}
        >
          {SOURCE_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.7 }}>原文</span>
        <div style={{ flex: 1 }} />
        <button onClick={run} disabled={loading || !input.trim()} style={miniBtnPrimary}>
          <Languages size={13} /> 翻译
        </button>
      </div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="粘贴或输入要翻译的文字…"
        style={taStyle}
      />
      {error && <div style={{ color: '#b45309', fontSize: 12, flexShrink: 0 }}>{error}</div>}
      {/* 目标语言：放在下方输入框（译文）上面，无「自动识别」 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={langLabelStyle}>目标语言</span>
        <select
          value={targetLang}
          onChange={(e) => {
            setTargetLang(e.target.value);
            saveTargetLang(e.target.value);
          }}
          style={langSelStyle}
        >
          {TARGET_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.7 }}>译文</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => output && navigator.clipboard.writeText(output)} disabled={!output} style={miniBtn}>
          复制
        </button>
      </div>
      <textarea readOnly value={output} placeholder="译文将显示在这里…" style={taStyle} />
    </div>
  );
}

export default FloatingDropzoneView;
