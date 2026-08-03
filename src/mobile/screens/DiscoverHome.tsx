/**
 * DiscoverHome — 发现 Tab 根屏。
 *
 * 模块入口页。已接入「茑萝」（设备互联，内含局域网传输）；
 * 其余模块（莲花 / 铃兰 / 薄荷 / 三色堇 / 玉兰）随移动端能力逐步开放。
 */

import { Compass, Sparkles, BookOpen, Boxes, ChevronRight } from 'lucide-react';
import { useNavStore } from '../stores/navStore';
import { NiaoluoScreen } from './NiaoluoScreen';

export function DiscoverHome() {
  const push = useNavStore((s) => s.push);

  const openNiaoluo = () => {
    push('discover', {
      id: 'discover-niaoluo',
      title: '茑萝',
      render: () => <NiaoluoScreen />,
    });
  };

  return (
    <div className="px-4 py-4 flex flex-col gap-4">
      {/* ===== 模块区：已开放的功能模块 ===== */}
      <section>
        <h3
          className="font-medium text-[var(--muted-foreground)] mb-2 px-1"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          模块
        </h3>
        <button
          type="button"
          onClick={openNiaoluo}
          className="flex w-full items-center gap-3 px-3 py-3.5 rounded-2xl bg-[var(--card)] border border-[var(--border)] text-left active:scale-[0.99] transition-transform"
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
            <Compass size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div
              className="font-medium text-[var(--foreground)]"
              style={{ fontSize: 'var(--m-text-body)' }}
            >
              茑萝
            </div>
            <div
              className="text-[var(--muted-foreground)] truncate"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              设备互联 · 局域网传输
            </div>
          </div>
          <ChevronRight size={18} className="text-[var(--muted-foreground)] shrink-0" />
        </button>
      </section>

      {/* ===== 探索区（占位，T08 接入） ===== */}
      <section>
        <h3
          className="font-medium text-[var(--muted-foreground)] mb-2 px-1"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          探索
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <CategoryCard icon={<Sparkles size={24} />} title="AI 模板" desc="对话模板库" />
          <CategoryCard icon={<BookOpen size={24} />} title="阅读资源" desc="书源 · 订阅" />
          <CategoryCard icon={<Boxes size={24} />} title="插件市场" desc="社区插件" />
          <CategoryCard icon={<Compass size={24} />} title="全部" desc="浏览全部" />
        </div>
      </section>
    </div>
  );
}

function CategoryCard({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      className="flex flex-col gap-2 rounded-2xl p-4 bg-[var(--card)] border border-[var(--border)] active:scale-[0.97] transition-transform text-left"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      <span
        className="flex items-center justify-center rounded-xl bg-[var(--element-muted)] text-[var(--element-bg)]"
        style={{ width: '40px', height: '40px' }}
      >
        {icon}
      </span>
      <span
        className="font-medium text-[var(--foreground)]"
        style={{ fontSize: 'var(--m-text-label)' }}
      >
        {title}
      </span>
      <span
        className="text-[var(--muted-foreground)]"
        style={{ fontSize: 'var(--m-text-caption)' }}
      >
        {desc}
      </span>
    </button>
  );
}
