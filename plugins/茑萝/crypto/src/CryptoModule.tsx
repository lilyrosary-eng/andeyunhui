/// <reference path="../../../global.d.ts" />
// 茑萝 · 加密解密主容器
// 职责：四个 Tab（RSA / PGP / 审计 / 字典）切换 + 通用工具栏
// 风格对齐 GongjuxiangModule / GongfangModule
const React = window.__HOST_REACT__;
const { useState } = React;

import { RsaTool } from './RsaTool';
import { PgpTool } from './PgpTool';
import { PasswordAudit } from './PasswordAudit';
import { DictionaryGen } from './DictionaryGen';

type TabKey = 'rsa' | 'pgp' | 'audit' | 'dict';

const RsaIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
  </svg>
);
const PgpIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const AuditIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="m9 15 2 2 4-4" />
  </svg>
);
const DictIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
  </svg>
);

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
        active
          ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
          : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function CryptoModule() {
  const [tab, setTab] = useState<TabKey>('rsa');

  return (
    <div className="flex-1 flex flex-col h-full bg-[#f5f5f0] dark:bg-[#1c1917]">
      <div className="flex items-center gap-1 px-5 py-2.5 border-b border-white/80 dark:border-stone-700/50">
        <TabButton active={tab === 'rsa'} onClick={() => setTab('rsa')} icon={RsaIcon} label="RSA 密钥对" />
        <TabButton active={tab === 'pgp'} onClick={() => setTab('pgp')} icon={PgpIcon} label="PGP 信封" />
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')} icon={AuditIcon} label="密码强度审计" />
        <TabButton active={tab === 'dict'} onClick={() => setTab('dict')} icon={DictIcon} label="字典生成" />
      </div>

      <div className="flex-1 h-full overflow-auto">
        {tab === 'rsa' && <RsaTool />}
        {tab === 'pgp' && <PgpTool />}
        {tab === 'audit' && <PasswordAudit />}
        {tab === 'dict' && <DictionaryGen />}
      </div>
    </div>
  );
}

// 占位侧边栏（茑萝统一风格）
function CryptoSidebar() {
  return (
    <div className="p-4 text-xs text-neutral-400 dark:text-stone-500">
      加密套件 · v0.1
      <div className="mt-2">茑萝 · 加密安全子模块</div>
    </div>
  );
}

export { CryptoModule, CryptoSidebar };
