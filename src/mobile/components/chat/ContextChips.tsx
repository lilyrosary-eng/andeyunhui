// 上下文芯片区（§6.3.4 · PRD P1-06 上下文注入协议 UI 预留位）。
//
// 输入框上方可堆叠「上下文芯片」。首发阶段该跨模块协议没有真实调用方，
// 故此处仅支持「本地选文件」这一种注入（§6.3.4 注释：避免为未验证契约过度设计）。
//
// L6 预留：组件接口已抽象为 { items, onRemove }，未来接入跨模块上下文注入时，
// 只需让上游往 items 里追加来源不同的芯片，本组件无需改动。

import { X, FileText, Image as ImageIcon } from 'lucide-react';

export interface ContextChipItem {
  id: string;
  /** 芯片显示文本（如文件名） */
  label: string;
  /** 来源类型（L6 预留：local-file / module-data / tool-output 等） */
  source?: 'local-file' | 'module' | 'tool';
  /** 图片预览（data URL，多模态阶段 5） */
  preview?: string;
}

interface ContextChipsProps {
  items: ContextChipItem[];
  onRemove: (id: string) => void;
}

export function ContextChips({ items, onRemove }: ContextChipsProps) {
  if (items.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1.5 px-3 pt-2.5"
      // 芯片区最多 2 行，超出滚动，避免占据过多输入区空间
      style={{ maxHeight: '64px', overflowY: 'auto' }}
    >
      {items.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex items-center gap-1.5 rounded-full shrink-0"
          style={{
            backgroundColor: 'var(--element-bg)',
            color: 'var(--element-fg)',
            fontSize: 'var(--m-text-overline)',
            padding: '4px 8px 4px 4px',
            maxWidth: '60vw',
          }}
        >
          {chip.preview ? (
            <img
              src={chip.preview}
              alt=""
              className="rounded-full shrink-0 object-cover"
              style={{ width: '20px', height: '20px' }}
            />
          ) : (
            <FileText size={12} className="shrink-0 opacity-70" />
          )}
          <span className="truncate">{chip.label}</span>
          <button
            type="button"
            onClick={() => onRemove(chip.id)}
            className="shrink-0 flex items-center justify-center rounded-full active:scale-90 transition-transform"
            style={{ width: '16px', height: '16px' }}
            aria-label={`移除 ${chip.label}`}
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
