// 来源切换分隔标记（§4.1.2）。
//
// 会话中途切换算力来源后插入，让用户清楚「以下内容由谁生成」——这是可审计性，
// 不是装饰（§6.3.2 支点 2：用户需知道哪些内容出过网）。
//
// 规格：11px 文本，来源状态色，两侧细分隔线。

import type { ComputeSource } from '../../types/chat';

const KIND_COLOR: Record<ComputeSource['kind'], string> = {
  local: 'var(--compute-local)',
  cloud: 'var(--compute-cloud)',
  device: 'var(--compute-device)',
  down: 'var(--compute-down)',
  unconfigured: 'var(--muted-foreground)',
};

const KIND_ICON: Record<ComputeSource['kind'], string> = {
  local: '🖥',
  cloud: '☁',
  device: '📱',
  down: '⚠',
  unconfigured: '○',
};

interface SourceDividerProps {
  source: ComputeSource;
}

export function SourceDivider({ source }: SourceDividerProps) {
  const color = KIND_COLOR[source.kind];
  const icon = KIND_ICON[source.kind];
  return (
    <div
      className="flex items-center gap-2 w-full select-none"
      style={{
        color,
        fontSize: 'var(--m-text-overline)',
        padding: '10px 4px',
      }}
      role="separator"
      aria-label={`以下改由 ${source.label} 处理`}
    >
      <span className="flex-1 h-px" style={{ backgroundColor: 'color-mix(in srgb, currentColor 30%, transparent)' }} />
      <span className="shrink-0 whitespace-nowrap">
        以下改由 {icon} {source.label} 处理
      </span>
      <span className="flex-1 h-px" style={{ backgroundColor: 'color-mix(in srgb, currentColor 30%, transparent)' }} />
    </div>
  );
}
