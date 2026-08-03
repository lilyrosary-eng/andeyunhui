/**
 * NiaoluoScreen — 茑萝模块屏（发现 Tab 子屏）。
 *
 * 导航位置：发现 → 茑萝。桌面端「茑萝」是网络/连接类模块，
 * 局域网传输（黄金棋盘 · 传输）归属于此，而非中转站。
 *
 * 当前提供「传输」入口；后续茑萝其他能力在此追加即可。
 */

import { Send, ChevronRight } from 'lucide-react';
import { useNavStore } from '../stores/navStore';
import { TransferScreen } from './TransferScreen';

export function NiaoluoScreen() {
  const push = useNavStore((s) => s.push);

  const openTransfer = () => {
    push('discover', {
      id: 'niaoluo-transfer',
      title: '传输',
      render: () => <TransferScreen />,
    });
  };

  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <p
        className="text-[var(--muted-foreground)] px-1"
        style={{ fontSize: 'var(--m-text-caption)' }}
      >
        设备互联与数据流转
      </p>

      <button
        type="button"
        onClick={openTransfer}
        className="flex items-center gap-3 px-3 py-3.5 rounded-2xl bg-[var(--card)] border border-[var(--border)] text-left active:scale-[0.99] transition-transform"
        style={{ boxShadow: 'var(--shadow-sm)' }}
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
          <Send size={20} />
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="font-medium text-[var(--foreground)]"
            style={{ fontSize: 'var(--m-text-body)' }}
          >
            传输
          </div>
          <div
            className="text-[var(--muted-foreground)] truncate"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            局域网点对点收发文件
          </div>
        </div>
        <ChevronRight size={18} className="text-[var(--muted-foreground)] shrink-0" />
      </button>
    </div>
  );
}
