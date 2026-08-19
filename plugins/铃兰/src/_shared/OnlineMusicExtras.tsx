// 在线音乐模块补充模板（VIP 状态卡 / 登录引导 / 空状态）
//
// 这些模板从网易云 / 酷狗的登录页和详情页中抽离出共享视觉结构，
// 供三端（网易云 / 酷狗 / 汽水）统一调用。
//
// 设计原则同 OnlineMusicTemplates.tsx：
//   - 纯布局外壳，不含业务/接口逻辑
//   - accent 参数化品牌色
//   - 数据源各自独立

import React from 'react';
import type { AccentProps } from './OnlineMusicTemplates';

// ============ VIP 会员状态卡片 ============
export interface VipInfoCardProps extends AccentProps {
  loading?: boolean;
  isVip: boolean;
  vipName?: string;       // 如 "黑胶VIP" / "酷狗VIP"
  vipLevel?: number;     // 等级（如 Lv.6）
  expireTime?: number;   // 到期时间戳（秒级或毫秒级，由 toLabel 决定）
  toLabel?: (t: number) => string; // 自定义格式化到期时间
  extras?: { label: string; value: string }[]; // 额外行（如红V等级、音乐包、自动续费）
}

export const VipInfoCard: React.FC<VipInfoCardProps> = ({
  loading,
  isVip,
  vipName,
  vipLevel,
  expireTime,
  toLabel = (t) => new Date(t).toLocaleDateString(),
  extras = [],
  accent = '#f44336',
}) => (
  <div className="p-4 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
    <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100 mb-2">会员状态</h3>
    {loading ? (
      <div className="text-xs text-neutral-400 dark:text-stone-500">查询中…</div>
    ) : isVip ? (
      <div className="flex flex-col gap-1.5 text-xs text-neutral-600 dark:text-stone-300">
        <div className="flex items-center justify-between">
          <span>{vipName || 'VIP'}</span>
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {vipLevel != null && vipLevel > 0 ? `Lv.${vipLevel}` : ''}
            {expireTime ? ` · 至 ${toLabel(expireTime)}` : ''}
          </span>
        </div>
        {extras.map((e, i) => (
          <div key={i} className="flex items-center justify-between">
            <span>{e.label}</span>
            <span className="font-medium">{e.value}</span>
          </div>
        ))}
      </div>
    ) : (
      <div className="text-xs text-neutral-400 dark:text-stone-500">当前账号无会员</div>
    )}
  </div>
);

// ============ 登录引导页（未登录态） ============
export interface LoginPromptProps extends AccentProps {
  brandLabel: string;       // 如 "网易云音乐" / "酷狗音乐"
  description: string;     // 如 "扫码登录后即可使用推荐、歌单、搜索与收藏同步"
  buttonText: string;      // 如 "立即扫码登录"
  loading?: boolean;
  loadingText?: string;    // 如 "生成中…"
  qrImg?: string;          // 二维码图片 URL
  qrStatus?: string;       // 状态文案
  onLogin: () => void;
  onRefreshQr?: () => void;
}

export const LoginPrompt: React.FC<LoginPromptProps> = ({
  brandLabel,
  description,
  buttonText,
  loading,
  loadingText = '生成中…',
  qrImg,
  qrStatus,
  onLogin,
  onRefreshQr,
  accent = '#f44336',
}) => {
  // 已有二维码：展示扫码界面
  if (qrImg) {
    return (
      <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-6 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
        <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">扫码登录{brandLabel}</h2>
        <img src={qrImg} alt="登录二维码" className="w-48 h-48 rounded-xl bg-white p-2" />
        <div className="text-sm text-neutral-500 dark:text-stone-400 text-center min-h-[1.5em]">{qrStatus}</div>
        {onRefreshQr && (
          <button onClick={onRefreshQr} className="btn-press px-4 py-1.5 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors">
            刷新二维码
          </button>
        )}
      </div>
    );
  }
  // 初始态：品牌引导
  return (
    <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-8 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white shadow-lg" style={{ background: accent }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </div>
      <div className="text-center">
        <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100 mb-1">登录{brandLabel}</h2>
        <p className="text-xs text-neutral-500 dark:text-stone-400">{description}</p>
      </div>
      <button onClick={onLogin} disabled={loading} className="btn-press w-full px-5 py-2.5 rounded-xl text-white text-sm font-medium transition-colors disabled:opacity-50" style={{ background: accent }}>
        {loading ? loadingText : buttonText}
      </button>
      {qrStatus && <div className="text-xs text-neutral-400 dark:text-stone-500 text-center min-h-[1.2em]">{qrStatus}</div>}
    </div>
  );
};

// ============ 空状态占位 ============
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, desc }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-400 dark:text-stone-500">
    {icon || (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    )}
    <span className="text-sm">{title}</span>
    {desc && <span className="text-xs text-neutral-400 dark:text-stone-500 max-w-xs text-center">{desc}</span>}
  </div>
);
