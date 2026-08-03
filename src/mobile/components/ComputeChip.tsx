/**
 * ComputeChip — 算力来源状态芯片（§7.9.2）。
 *
 * 规格：
 *   双行布局，项高 56dp
 *   左边框 3dp 状态色 + 12% 透明背景
 *   状态色令牌：--compute-local / --compute-cloud / --compute-device / --compute-down
 *
 * 状态语义：
 *   local       我的电脑 · 绿 · 未出网
 *   cloud       云端 · 琥珀 · 数据出网
 *   device      本机 · 蓝 · 完全离线
 *   down        不可达 · 中性灰
 *   unconfigured  未配置算力源
 *
 * 设计依据：ANDROID-V1-HANDOFF §7.2.3 / §7.9.2。
 */

import type { ReactNode } from 'react';

export type ComputeKind = 'local' | 'cloud' | 'device' | 'down' | 'unconfigured';

interface ComputeChipProps {
  /** 算力来源类型 */
  kind: ComputeKind;
  /** 主文案（如「我的电脑」「云端 GPU」），不传用默认 */
  label?: string;
  /** 副文案（如「NVIDIA RTX 4060」「延迟 80ms」） */
  description?: string;
  /** 右侧可放操作按钮（如「切换」「设置」） */
  trailing?: ReactNode;
  /** 点击整行回调 */
  onClick?: () => void;
}

const KIND_META: Record<ComputeKind, { color: string; defaultLabel: string; defaultDesc: string }> = {
  local: { color: 'var(--compute-local)', defaultLabel: '我的电脑', defaultDesc: '本地算力 · 数据未出网' },
  cloud: { color: 'var(--compute-cloud)', defaultLabel: '云端', defaultDesc: '云端算力 · 数据出网' },
  device: { color: 'var(--compute-device)', defaultLabel: '本机', defaultDesc: '设备算力 · 完全离线' },
  down: { color: 'var(--compute-down)', defaultLabel: '不可达', defaultDesc: '算力源无响应' },
  unconfigured: { color: 'var(--muted-foreground)', defaultLabel: '未配置', defaultDesc: '点此配置算力来源' },
};

export function ComputeChip({ kind, label, description, trailing, onClick }: ComputeChipProps) {
  const meta = KIND_META[kind];
  const isButton = !!onClick;

  // 12% 透明背景：color-mix 不可直接在 inline style 中混 var，用同色 alpha 叠加层。
  // 这里用两层 div：底层 12% 同色，前景内容透明，左边框 3dp 状态色。
  const Tag: keyof JSX.IntrinsicElements = isButton ? 'button' : 'div';

  return (
    <Tag
      type={isButton ? 'button' : undefined}
      onClick={onClick}
      className="relative w-full flex items-center text-left overflow-hidden active:scale-[0.99] transition-transform"
      style={{
        height: '56px',
        borderLeft: `3px solid ${meta.color}`,
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* 12% 透明状态色背景层 */}
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundColor: meta.color,
          opacity: 0.12,
        }}
      />
      {/* 内容层 */}
      <span className="relative flex-1 min-w-0 px-3 flex flex-col justify-center">
        <span
          className="block truncate font-medium text-[var(--foreground)]"
          style={{ fontSize: 'var(--m-text-label)' }}
        >
          {label ?? meta.defaultLabel}
        </span>
        <span
          className="block truncate text-[var(--muted-foreground)]"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          {description ?? meta.defaultDesc}
        </span>
      </span>
      {trailing && (
        <span className="relative shrink-0 pr-3 flex items-center">{trailing}</span>
      )}
    </Tag>
  );
}
