// 降级卡片（§4.1.1 · §6.3.3「降级是设计，不是报错」）。
//
// PC 睡眠/掉线是这个产品最高频的失败场景。用 toast 或红字处理它是错的——它不是异常，
// 是常态。处理方式：在消息流中行内插入降级卡片，提供原因猜测 + 两个出口
// （重试 / 改用云端）。用户选择改用云端后，由 ChatScreen 插入来源分隔标记（§4.1.2）。
//
// 整个过程不打断对话流，用户不需要离开页面去设置里改配置。
//
// 规格：
//   背景 --muted
//   左侧 3dp --compute-down 竖条
//   两个按钮 48dp 高

import { RefreshCw, Cloud } from 'lucide-react';

interface DegradeCardProps {
  /** 人因猜测的原因（由 useAiStream.guessReason 生成） */
  reason: string;
  /** 重试上次请求 */
  onRetry: () => void;
  /** 改用云端算力来源 */
  onSwitchCloud: () => void;
  /** 是否存在可用的云端 profile（false 时禁用「改用云端」） */
  cloudAvailable: boolean;
}

export function DegradeCard({ reason, onRetry, onSwitchCloud, cloudAvailable }: DegradeCardProps) {
  return (
    <div
      className="relative w-full rounded-xl overflow-hidden"
      style={{
        backgroundColor: 'var(--muted)',
        borderLeft: '3px solid var(--compute-down)',
        padding: '14px 14px 12px',
        margin: '8px 0',
        // 提示渲染层该卡片独立合成，减少重绘开销
        willChange: 'transform',
      }}
      role="alert"
    >
      {/* 标题行 */}
      <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--foreground)' }}>
        <span style={{ color: 'var(--compute-down)', fontSize: 'var(--m-text-label)' }}>⚠</span>
        <span className="font-medium" style={{ fontSize: 'var(--m-text-label)' }}>
          算力源没有响应
        </span>
      </div>

      {/* 原因猜测 */}
      <p
        className="text-[var(--muted-foreground)] leading-relaxed mb-3"
        style={{ fontSize: 'var(--m-text-caption)' }}
      >
        {reason}
      </p>

      {/* 两个出口：重试 / 改用云端 */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center justify-center gap-1.5 rounded-lg font-medium active:scale-[0.97] transition-transform"
          style={{
            height: 'var(--touch-min)',
            minWidth: '88px',
            backgroundColor: 'var(--element-bg)',
            color: 'var(--element-fg)',
            fontSize: 'var(--m-text-caption)',
          }}
        >
          <RefreshCw size={15} />
          重试
        </button>
        <button
          type="button"
          onClick={onSwitchCloud}
          disabled={!cloudAvailable}
          className="flex items-center justify-center gap-1.5 rounded-lg font-medium active:scale-[0.97] transition-transform disabled:opacity-50 disabled:active:scale-100"
          style={{
            height: 'var(--touch-min)',
            minWidth: '120px',
            backgroundColor: 'var(--compute-cloud)',
            color: 'var(--background)',
            fontSize: 'var(--m-text-caption)',
          }}
        >
          <Cloud size={15} />
          改用云端
        </button>
      </div>
    </div>
  );
}
