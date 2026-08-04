/**
 * ProfileHome — 我的 Tab 根屏。
 *
 * 设置入口列表，点击 push 到「通用设置 / 主题与外观 / 数据与存储 / 关于」二级页。
 * 页面实现见 SettingsScreens.tsx（通用设置 / 主题与外观 / 关于实装；数据与存储占位）。
 */

import { User, Settings, Palette, Database, Info, ChevronRight } from 'lucide-react';
import { useNavStore } from '../stores/navStore';
import {
  GeneralSettingsScreen,
  AppearanceSettingsScreen,
  AboutScreen,
} from './SettingsScreens';

export function ProfileHome() {
  const push = useNavStore((s) => s.push);

  const open = (id: string, title: string, render: () => React.ReactNode) => {
    push('profile', { id, title, render });
  };

  return (
    <div className="px-4 py-6 flex flex-col gap-4">
      {/* 用户卡片 */}
      <section
        className="rounded-2xl p-5 bg-[var(--card)] border border-[var(--border)] flex items-center gap-3"
        style={{ boxShadow: 'var(--shadow-sm)' }}
      >
        <span
          className="flex items-center justify-center rounded-full bg-[var(--element-bg)] text-[var(--element-fg)]"
          style={{ width: '56px', height: '56px' }}
        >
          <User size={28} />
        </span>
        <div>
          <h2
            className="font-semibold text-[var(--foreground)]"
            style={{ fontSize: 'var(--m-text-headline)' }}
          >
            我的
          </h2>
          <p
            className="text-[var(--muted-foreground)]"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            本地账户 · 数据存储于设备
          </p>
        </div>
      </section>

      {/* 设置入口列表 */}
      <section
        className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden"
        style={{ boxShadow: 'var(--shadow-sm)' }}
      >
        <Row
          icon={<Settings size={20} />}
          label="通用设置"
          onClick={() => open('general-settings', '通用设置', () => <GeneralSettingsScreen />)}
        />
        <Row
          icon={<Palette size={20} />}
          label="主题与外观"
          onClick={() => open('appearance-settings', '主题与外观', () => <AppearanceSettingsScreen />)}
        />
        <Row icon={<Database size={20} />} label="数据与存储" />
        <Row
          icon={<Info size={20} />}
          label="关于"
          last
          onClick={() => open('about', '关于', () => <AboutScreen />)}
        />
      </section>

      <p
        className="text-center text-[var(--muted-foreground)]"
        style={{ fontSize: 'var(--m-text-overline)' }}
      >
        安得云荟 · 数据仅存储于本机
      </p>
    </div>
  );
}

function Row({
  icon,
  label,
  onClick,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 text-left active:bg-[var(--muted)]/60 transition-colors"
      style={{
        height: '56px',
        borderBottom: last ? 'none' : '1px solid var(--border)',
      }}
    >
      <span className="text-[var(--element-bg)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
        {icon}
      </span>
      <span
        className="flex-1 text-[var(--foreground)]"
        style={{ fontSize: 'var(--m-text-label)' }}
      >
        {label}
      </span>
      <ChevronRight size={20} className="text-[var(--muted-foreground)]" />
    </button>
  );
}
