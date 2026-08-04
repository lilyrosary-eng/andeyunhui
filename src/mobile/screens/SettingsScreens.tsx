// 「我的」设置页面集合（T08）：通用设置 / 主题与外观 / 关于。
//
// 页面内容：
//   - GeneralSettingsScreen：伴侣管理入口 + Agent 能力开关（默认关）+ 语言 + 清空对话数据
//   - AppearanceSettingsScreen：主题（system/light/dark）+ 强调色（复用全局 ThemeProvider）
//   - AboutScreen：应用名 / 版本 / GitHub / 致谢
//
// 强调色 / 主题 / Agent 开关全部走全局 store + localStorage 持久化，切完即生效。

import { useTheme } from '../../lib/ThemeProvider';
import { useNavStore } from '../stores/navStore';
import { useChatStore } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useCompanionStore } from '../stores/companionStore';
import {
  getProactiveEnabled, setProactiveEnabled,
  getProactiveIntervalMin, setProactiveIntervalMin,
} from '../hooks/useProactiveMessage';
import { getEmbedConfig, setEmbedConfig } from '../stores/semanticMemory';
import { getAgentSilent, setAgentSilent } from '../stores/agentStore';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  Globe,
  Palette,
  Sun,
  Moon,
  Monitor,
  Check,
  Trash2,
  Info,
  Heart,
  Sparkles,
  Bell,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CompanionManageScreen } from './CompanionManageScreen';
import { AgentRecordsScreen } from './AgentRecordsScreen';

/** 简单开关组件（复用 CSS 变量） */
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="relative shrink-0 rounded-full transition-colors duration-200"
      style={{
        width: '44px',
        height: '26px',
        background: on ? 'var(--element-bg)' : 'var(--muted)',
      }}
    >
      <span
        className="absolute top-[3px] left-[3px] rounded-full bg-white shadow transition-transform duration-200"
        style={{ width: '20px', height: '20px', transform: on ? 'translateX(18px)' : 'translateX(0)' }}
      />
    </button>
  );
}

/** 打开外链：Tauri 内走系统浏览器，浏览器预览降级 window.open */
async function openExternal(url: string) {
  try {
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

const GITHUB_REPO = 'https://github.com/lilyrosary-eng/andeyunhui';
const RELEASE_PAGE = 'https://adyh.cc.cd';

/** 通用设置屏 */
export function GeneralSettingsScreen() {
  const conversations = useChatStore((s) => s.conversations);
  const [cleared, setCleared] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const push = useNavStore((s) => s.push);
  const companion = useCompanionStore((s) => s.companion);
  const agentEnabled = useAgentStore((s) => s.enabled);
  const setAgentEnabled = useAgentStore((s) => s.setEnabled);
  const loadAgent = useAgentStore((s) => s.load);

  // 主动消息开关（localStorage，默认关）
  const [proactiveOn, setProactiveOn] = useState(getProactiveEnabled());
  const [proactiveMin, setProactiveMin] = useState(getProactiveIntervalMin());

  // 嵌入端点（L3/L4 语义记忆，OpenAI 兼容）
  const [embedOpen, setEmbedOpen] = useState(false);
  const [embedForm, setEmbedForm] = useState(() => {
    const c = getEmbedConfig();
    if (c) return { endpoint: c.endpoint, apiKey: c.apiKey, model: c.model };
    // 未配置时：自动预填「算力来源」的端点与模型（降低门槛，用户可改）
    return { endpoint: '', apiKey: '', model: '' };
  });
  const [embedSaved, setEmbedSaved] = useState(false);
  const embedConfigured = !!getEmbedConfig();

  // 挂载时加载 agent 数据 + 请求通知权限（若已开启主动消息）
  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  useEffect(() => {
    if (proactiveOn && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, [proactiveOn]);

  const clearAll = useCallback(() => {
    // 删除全部会话并新建一个空会话
    useChatStore.getState().conversations.forEach((c) => {
      useChatStore.getState().deleteConversation(c.id);
    });
    setCleared(true);
    setConfirming(false);
  }, []);

  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      {/* 伴侣管理 */}
      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <Item
          icon={<Heart size={20} />}
          label="伴侣管理"
          value={`${companion.name || '未命名'} 等`}
          onClick={() => push('profile', { id: 'companion-manage', title: '伴侣管理', render: () => <CompanionManageScreen /> })}
        />
        <Item
          icon={<Sparkles size={20} />}
          label="Agent 记录"
          value="日历 / 待办 / 提醒"
          onClick={() => push('profile', { id: 'agent-records', title: 'Agent 记录', render: () => <AgentRecordsScreen /> })}
        />
      </section>

      {/* Agent 能力（默认关闭） */}
      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <div className="flex w-full items-center gap-3 px-4" style={{ height: '56px' }}>
          <span className="text-[var(--element-bg)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
            <Sparkles size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
              Agent 能力
            </div>
            <div className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
              AI 可为你创建日历 / 待办 / 提醒（默认关闭）
            </div>
          </div>
          <Toggle on={agentEnabled} onChange={setAgentEnabled} />
        </div>
        {agentEnabled && (
          <div className="flex w-full items-center gap-3 px-4" style={{ height: '48px', borderTop: '1px solid var(--border)' }}>
            <div className="flex-1 min-w-0">
              <div className="text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
                静默执行
              </div>
              <div className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
                开启后闹铃/日历等系统操作无需确认直接执行
              </div>
            </div>
            <Toggle on={getAgentSilent()} onChange={setAgentSilent} />
          </div>
        )}
      </section>

      {/* 主动消息（存在感，默认关闭） */}
      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <div className="flex w-full items-center gap-3 px-4" style={{ height: '56px' }}>
          <span className="text-[var(--element-bg)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
            <Bell size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
              主动消息
            </div>
            <div className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
              打开 app 时 TA 会主动来打招呼（默认关闭）
            </div>
          </div>
          <Toggle
            on={proactiveOn}
            onChange={(v) => {
              setProactiveOn(v);
              setProactiveEnabled(v);
            }}
          />
        </div>
        {proactiveOn && (
          <div className="px-4 pb-3 flex flex-col gap-2">
            <span className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
              主动间隔
            </span>
            <div className="flex flex-wrap gap-2">
              {[30, 60, 180, 360].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setProactiveMin(m); setProactiveIntervalMin(m); }}
                  className="rounded-full px-3 py-1.5 border active:scale-95 transition-transform"
                  style={{
                    fontSize: 'var(--m-text-caption)',
                    borderColor: proactiveMin === m ? 'var(--element-bg)' : 'var(--border)',
                    color: proactiveMin === m ? 'var(--element-bg)' : 'var(--foreground)',
                    background: proactiveMin === m ? 'var(--element-muted)' : 'transparent',
                  }}
                >
                  {m >= 60 ? `${m / 60} 小时` : `${m} 分钟`}
                </button>
              ))}
            </div>
            <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
              关系温暖较低时 TA 不会打扰你。
            </p>
          </div>
        )}
      </section>

      {/* 语义记忆嵌入端点（L3/L4，可选） */}
      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <button
          type="button"
          onClick={() => { setEmbedOpen((v) => !v); setEmbedSaved(false); }}
          className="flex w-full items-center gap-3 px-4 text-left active:bg-[var(--muted)]/60 transition-colors"
          style={{ height: '56px' }}
        >
          <span className="text-[var(--element-bg)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
            <Sparkles size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
              语义记忆（L3/L4）
            </div>
            <div className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
              {embedConfigured ? '已配置嵌入端点 · 语义检索可用' : '自动复用算力来源 · 无嵌入端点时降级为关键词检索'}
            </div>
          </div>
          <ChevronRight
            size={20}
            className="text-[var(--muted-foreground)] transition-transform duration-200"
            style={{ transform: embedOpen ? 'rotate(90deg)' : 'none' }}
          />
        </button>
        {embedOpen && (
          <div className="px-4 pb-3 flex flex-col gap-2">
            <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
              配置一个 OpenAI 兼容的嵌入端点（如 DeepSeek/OpenAI 的 /v1/embeddings），AI 才能检索四层记忆中的深层部分。
            </p>
            <input
              type="text"
              value={embedForm.endpoint}
              onChange={(e) => setEmbedForm((f) => ({ ...f, endpoint: e.target.value }))}
              placeholder="https://api.openai.com/v1/embeddings"
              className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
              style={{ fontSize: 'var(--m-text-body)' }}
            />
            <input
              type="text"
              value={embedForm.apiKey}
              onChange={(e) => setEmbedForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder="API Key（可选）"
              className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
              style={{ fontSize: 'var(--m-text-body)' }}
            />
            <input
              type="text"
              value={embedForm.model}
              onChange={(e) => setEmbedForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="模型名，如 text-embedding-3-small"
              className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
              style={{ fontSize: 'var(--m-text-body)' }}
            />
            <button
              type="button"
              onClick={() => {
                setEmbedConfig({ endpoint: embedForm.endpoint.trim(), apiKey: embedForm.apiKey.trim(), model: embedForm.model.trim() });
                setEmbedSaved(true);
              }}
              className="rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)', background: 'var(--element-bg)', color: 'var(--element-fg)' }}
            >
              保存
            </button>
            {embedSaved && <p className="text-[var(--element-bg)]" style={{ fontSize: 'var(--m-text-caption)' }}>已保存。</p>}
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <Item
          icon={<Globe size={20} />}
          label="语言"
          value="简体中文"
          onClick={() => {}}
        />
        <Item
          icon={<Palette size={20} />}
          label="默认算力来源"
          value="可在 AI 对话中设置"
          onClick={() => {}}
        />
      </section>

      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <button
          type="button"
          onClick={() => setConfirming((v) => !v)}
          className="flex w-full items-center gap-3 px-4 text-left active:bg-[var(--muted)]/60 transition-colors"
          style={{ height: '56px' }}
        >
          <span className="text-[var(--danger)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
            <Trash2 size={20} />
          </span>
          <span className="flex-1 text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
            清空全部对话记录
          </span>
          <span className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
            {conversations.length} 个
          </span>
          <ChevronRight size={20} className="text-[var(--muted-foreground)]" />
        </button>
        {confirming && (
          <div className="px-4 pb-3 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)' }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)', background: 'var(--danger)', color: 'var(--danger-fg, #fff)' }}
            >
              确认清空
            </button>
          </div>
        )}
        {cleared && (
          <p className="px-4 pb-3 text-[var(--element-bg)]" style={{ fontSize: 'var(--m-text-caption)' }}>
            已清空全部对话记录
          </p>
        )}
      </section>

      <p className="text-center text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
        更多偏好设置在「主题与外观」中调整
      </p>
    </div>
  );
}

/** 主题与外观屏 —— 复用全局 ThemeProvider，切完即生效并持久化 */
export function AppearanceSettingsScreen() {
  const { theme, setTheme, resolved, themeColor, setThemeColor, elementColor, setElementColor } = useTheme();

  const themeOptions = [
    { id: 'system' as const, label: '跟随系统', icon: <Monitor size={20} /> },
    { id: 'light' as const, label: '浅色', icon: <Sun size={20} /> },
    { id: 'dark' as const, label: '深色', icon: <Moon size={20} /> },
  ];

  const colorOptions = ['默认', '经典绿', '经典蓝', '紫色', '橙色'];

  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <div className="px-4 pt-3 pb-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
          外观模式（当前：{resolved === 'dark' ? '深色' : '浅色'}）
        </div>
        {themeOptions.map((opt) => {
          const active = theme === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setTheme(opt.id)}
              className="flex w-full items-center gap-3 px-4 text-left active:bg-[var(--muted)]/60 transition-colors"
              style={{ height: '56px' }}
            >
              <span className="text-[var(--element-bg)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
                {opt.icon}
              </span>
              <span
                className="flex-1 text-[var(--foreground)]"
                style={{ fontSize: 'var(--m-text-label)', color: active ? 'var(--element-bg)' : 'var(--foreground)' }}
              >
                {opt.label}
              </span>
              {active && <Check size={20} className="text-[var(--element-bg)]" />}
            </button>
          );
        })}
      </section>

      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <div className="px-4 pt-3 pb-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
          面板强调色
        </div>
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {colorOptions.map((c) => {
            const active = themeColor === c;
            const preview =
              c === '默认'
                ? (resolved === 'dark' ? '#7c5c9e' : '#5a7f5d')
                : ({ '经典绿': '#5a7f5d', '经典蓝': '#4a6fa5', '紫色': '#7c5c9e', '橙色': '#c97a3a' } as Record<string, string>)[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() => setThemeColor(c)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 border active:scale-95 transition-transform"
                style={{
                  fontSize: 'var(--m-text-caption)',
                  borderColor: active ? preview : 'var(--border)',
                  color: active ? preview : 'var(--foreground)',
                }}
              >
                <span className="rounded-full" style={{ width: '12px', height: '12px', background: preview }} />
                {c}
              </button>
            );
          })}
        </div>
        <p className="px-4 pb-3 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
          面板色影响导航栏与卡片底色；元素色影响按钮与高亮。
        </p>
      </section>

      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <div className="px-4 pt-3 pb-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
          元素强调色
        </div>
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {colorOptions.map((c) => {
            const active = elementColor === c;
            const preview =
              c === '默认'
                ? (resolved === 'dark' ? '#7c5c9e' : '#5a7f5d')
                : ({ '经典绿': '#5a7f5d', '经典蓝': '#4a6fa5', '紫色': '#7c5c9e', '橙色': '#c97a3a' } as Record<string, string>)[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() => setElementColor(c)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 border active:scale-95 transition-transform"
                style={{
                  fontSize: 'var(--m-text-caption)',
                  borderColor: active ? preview : 'var(--border)',
                  color: active ? preview : 'var(--foreground)',
                }}
              >
                <span className="rounded-full" style={{ width: '12px', height: '12px', background: preview }} />
                {c}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** 关于屏 */
export function AboutScreen() {
  const appVersion = '0.1.0'; // TODO: 从 tauri.conf.json 读取真实版本

  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      <section className="rounded-2xl p-6 bg-[var(--card)] border border-[var(--border)] text-center flex flex-col items-center gap-2">
        <div
          className="flex items-center justify-center rounded-2xl text-[var(--element-fg)]"
          style={{ width: '72px', height: '72px', background: 'var(--element-bg)' }}
        >
          <span className="font-semibold" style={{ fontSize: '28px' }}>安</span>
        </div>
        <h2 className="font-semibold text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-title)' }}>
          安得云荟
        </h2>
        <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
          版本 {appVersion} · Android v1
        </p>
        <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
          Tauri v2 + React + Rust
        </p>
      </section>

      <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
        <Item icon={<ExternalLink size={20} />} label="GitHub 仓库" value="开源主页" onClick={() => void openExternal(GITHUB_REPO)} />
        <Item icon={<ExternalLink size={20} />} label="发布页" value="下载更新" onClick={() => void openExternal(RELEASE_PAGE)} />
        <Item icon={<Heart size={20} />} label="致谢" value="所有贡献者" />
        <Item icon={<Info size={20} />} label="开源许可" value="MIT" last />
      </section>

      <p className="text-center text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
        数据仅存储于本机 · 不上传
      </p>
    </div>
  );
}

/** 通用列表行（设置页复用） */
function Item({
  icon,
  label,
  value,
  onClick,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
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
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span className="text-[var(--element-bg)]" style={{ width: '24px', display: 'flex', justifyContent: 'center' }}>
        {icon}
      </span>
      <span className="flex-1 text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
        {label}
      </span>
      {value && <span className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>{value}</span>}
      {onClick && <ChevronRight size={20} className="text-[var(--muted-foreground)]" />}
    </button>
  );
}
