/**
 * MobileApp — 移动端根组件（T05）。
 *
 * 与桌面 App.tsx 并列，不改造桌面主体。结构：
 *   ┌────────────────────┐
 *   │  AppBar (顶部)     │  ← 当前 Tab 栈顶屏的 title
 *   ├────────────────────┤
 *   │  NavStack (内容)   │  ← 当前 Tab 栈顶屏 render()
 *   ├────────────────────┤
 *   │  TabBar (底部 4 Tab)│
 *   └────────────────────┘
 *   + GlobalDrawer (左抽屉，覆盖层)
 *
 * 职责：
 *   1. 挂载时一次性初始化 4 个 Tab 的根 Screen（initRoots）
 *   2. 监听 Android 返回键事件 'android-back-pressed'，按优先级处理
 *
 * 返回键优先级（§6.3）：
 *   BottomSheet 打开 → 关闭
 *   抽屉打开 → 关闭
 *   当前 Tab 栈深 > 1 → pop
 *   当前 Tab 非中转站 → 切到中转站
 *   当前 Tab 是中转站根 → 退出 App
 */

import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useNavStore } from './stores/navStore';
import { AppBar } from './components/AppBar';
import { TabBar } from './navigation/TabBar';
import { NavStack } from './navigation/NavStack';
import { GlobalDrawer } from './navigation/GlobalDrawer';
import { StationHome } from './screens/StationHome';
import { ChatHome } from './screens/ChatHome';
import { DiscoverHome } from './screens/DiscoverHome';
import { ProfileHome } from './screens/ProfileHome';
import { useChatStore } from './stores/chatStore';
import { useDrawerSwipe } from './hooks/useDrawerSwipe';
import { Plus, MoreVertical, Send, Inbox, Sparkles, Book, Puzzle, Settings2, MessageSquarePlus, MessageSquare, Trash2, type LucideIcon } from 'lucide-react';
import { NiaoluoScreen } from './screens/NiaoluoScreen';
import { TransferScreen } from './screens/TransferScreen';

export default function MobileApp() {
  // 一次性初始化各 Tab 根 Screen。
  // 用 ref 守卫 + 渲染期初始化模式（React 官方推荐），避免 useEffect 二次渲染闪烁。
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    useNavStore.getState().initRoots({
      transfer: {
        id: 'station-home',
        title: '中转站',
        render: () => <StationHome />,
      },
      chat: {
        id: 'chat-home',
        title: 'AI 对话',
        render: () => <ChatHome />,
        // AppBar 右侧动作：⊕ 新建会话 / ⋮ 溢出菜单。
        // 实现由 ChatScreen 挂载时注册进 chatStore，此处仅转发调用（chatStore 桥接模式）。
        appBarActions: [
          {
            icon: <Plus size={22} />,
            label: '新建会话',
            onClick: () => { useChatStore.getState().newConversation?.(); },
          },
          {
            icon: <MoreVertical size={22} />,
            label: '更多',
            onClick: () => { useChatStore.getState().openOverflow?.(); },
          },
        ],
      },
      discover: {
        id: 'discover-home',
        title: '发现',
        render: () => <DiscoverHome />,
      },
      profile: {
        id: 'profile-home',
        title: '我的',
        render: () => <ProfileHome />,
      },
    });
  }

  const activeTab = useNavStore((s) => s.activeTab);
  const tabs = useNavStore((s) => s.tabs);
  const setDrawerOpen = useNavStore((s) => s.setDrawerOpen);
  const drawerOpen = useNavStore((s) => s.drawerOpen);
  const pop = useNavStore((s) => s.pop);

  // 内容区「左 → 右」横滑打开抽屉（等同点击左上角 ☰）。
  // 抽屉已打开时禁用，关闭手势由 GlobalDrawer 自身的 drag 负责。
  const contentRef = useRef<HTMLDivElement>(null);
  useDrawerSwipe(contentRef, !drawerOpen);

  const stack = tabs[activeTab];
  const current = stack[stack.length - 1];
  const isRoot = stack.length <= 1;

  // Android 返回键拦截
  // Kotlin 侧 MainActivity 通过 webView.evaluateJavascript dispatch window CustomEvent，
  // 前端用 window.addEventListener 接收。不依赖 Tauri event 总线 → 桌面端零影响。
  useEffect(() => {
    const handler = () => {
      const s = useNavStore.getState();
      // 优先级 1：BottomSheet 打开 → 关闭
      if (s.bottomSheetOpen) {
        s.setBottomSheetOpen(false);
        return;
      }
      // 优先级 2：抽屉打开 → 关闭
      if (s.drawerOpen) {
        s.setDrawerOpen(false);
        return;
      }
      // 优先级 3：当前 Tab 栈深 > 1 → pop
      const curStack = s.tabs[s.activeTab];
      if (curStack.length > 1) {
        s.pop(s.activeTab);
        return;
      }
      // 优先级 4：当前 Tab 非中转站 → 切到中转站
      if (s.activeTab !== 'transfer') {
        s.switchTab('transfer');
        return;
      }
      // 优先级 5：中转站根屏 → 退出 App
      getCurrentWindow().destroy().catch(() => {
        // 兜底：destroy 失败时关闭窗口
        getCurrentWindow().close().catch(() => {});
      });
    };
    window.addEventListener('android-back-pressed', handler);
    return () => window.removeEventListener('android-back-pressed', handler);
  }, []);

  // 系统分享 → 自动进入传输发送流程：切到中转站 + 打开传输页，用户直接选目标即可发。
  // 全局挂 __shareFilesPicked（MainActivity 冷启动/热启动都可能触发，此时 useTransfer 未必挂载，
  // 所以用 localStorage 中转，useTransfer 挂载时读取；同时派发 share-ready 引导导航）。
  useEffect(() => {
    const w = window as unknown as {
      __shareFilesPicked?: (paths: string[]) => void;
    };
    if (!w.__shareFilesPicked) {
      w.__shareFilesPicked = (paths) => {
        if (!paths?.length) return;
        try {
          const prev = JSON.parse(localStorage.getItem('andeyunhui.mobile.share') || '[]') as string[];
          localStorage.setItem('andeyunhui.mobile.share', JSON.stringify(Array.from(new Set([...prev, ...paths]))));
        } catch { /* 忽略 */ }
        // 派发事件：若传输页已挂载（useTransfer 监听），立即加入暂存并切页
        window.dispatchEvent(new CustomEvent('share-ready', { detail: { count: paths.length } }));
      };
    }
    return () => { /* 全局单例，不清理 */ };
  }, []);

  // share-ready：切到中转站 + 打开传输页（用户选目标即可发送）
  useEffect(() => {
    const onShare = () => {
      const n = useNavStore.getState();
      if (n.activeTab !== 'transfer') n.switchTab('transfer');
      // 已在传输页则不重复 push（防分享事件多次触发导致栈异常/白屏）
      const stack = n.tabs['transfer'];
      const top = stack[stack.length - 1];
      if (top?.id === 'transfer-screen') return;
      n.push('transfer', {
        id: 'transfer-screen',
        title: '传输',
        render: () => <TransferScreen />,
      });
    };
    window.addEventListener('share-ready', onShare);
    return () => window.removeEventListener('share-ready', onShare);
  }, []);

  return (
    <div
      className="flex flex-col h-[100dvh] bg-[var(--main-panel-bg)] overflow-hidden"
      style={{ contain: 'layout paint' }}
    >
      <AppBar
        title={current?.title ?? ''}
        onBack={isRoot ? undefined : () => pop(activeTab)}
        onMenu={() => setDrawerOpen(true)}
        actions={current?.appBarActions}
      />

      {/* 内容区：ref 交给 NavStack 的滚动容器本身，
          useDrawerSwipe 在其上捕获中央区域的左→右横滑以打开抽屉。 */}
      <NavStack containerRef={contentRef} />

      <TabBar />

      <GlobalDrawer>
        <DrawerContent />
      </GlobalDrawer>
    </div>
  );
}

/**
 * 抽屉内容：按当前 Tab 展示相关内容，不重复底部 TabBar 的主导航。
 * - transfer 中转站抽屉：快捷入口「中转站 / AI对话 / 传输」——传输直接进传输页
 *   （不再绕茑萝），中转站/AI对话 切换底部 Tab。
 * - chat AI对话抽屉：会话历史列表（多会话，chatStore），点击切换会话；底部附
 *   「新建对话」按钮。
 * - discover 发现抽屉：模块入口（传输/AI模板/阅读资源/插件市场）。
 * - profile 我的抽屉：设置入口。
 */
interface DrawerModule {
  id: string;
  label: string;
  icon: LucideIcon;
  onActivate: () => void;
}

function DrawerContent() {
  const switchTab = useNavStore((s) => s.switchTab);
  const push = useNavStore((s) => s.push);
  const setDrawerOpen = useNavStore((s) => s.setDrawerOpen);
  const activeTab = useNavStore((s) => s.activeTab);
  const openOverflow = useChatStore((s) => s.openOverflow);
  const conversations = useChatStore((s) => s.conversations);
  const activeConvId = useChatStore((s) => s.activeConvId);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const createConversation = useChatStore((s) => s.createConversation);

  // 直接进「传输」页：push 到当前（transfer/discover）Tab 栈
  const openTransferDirect = () => {
    push(activeTab, {
      id: 'transfer-screen',
      title: '传输',
      render: () => <TransferScreen />,
    });
  };

  // 跳转到「传输」模块（发现 Tab）：切到发现 Tab 并 push 茑萝入口屏（茑萝内可继续进传输）
  const openNiaoluo = () => {
    switchTab('discover');
    push('discover', {
      id: 'niaoluo-home',
      title: '茑萝',
      render: () => <NiaoluoScreen />,
    });
  };

  const TAB_LABELS: Record<typeof activeTab, string> = {
    transfer: '中转站',
    chat: 'AI 对话',
    discover: '发现',
    profile: '我的',
  };
  const currentLabel = TAB_LABELS[activeTab] ?? '';

  /** 快速 Tab 切换（transfer 抽屉的「中转站/AI对话」） */
  const quickTabs: { id: typeof activeTab; label: string; icon: LucideIcon }[] = [
    { id: 'transfer', label: '中转站', icon: Send },
    { id: 'chat', label: 'AI对话', icon: MessageSquare },
  ];

  const modules: DrawerModule[] = (() => {
    switch (activeTab) {
      case 'transfer':
        return [
          { id: 'transfer', label: '传输', icon: Send, onActivate: openTransferDirect },
        ];
      case 'discover':
        return [
          { id: 'transfer', label: '传输', icon: Send, onActivate: openNiaoluo },
          { id: 'ai', label: 'AI 模板', icon: Sparkles, onActivate: () => { /* TODO: AI 模板模块 */ } },
          { id: 'reading', label: '阅读资源', icon: Book, onActivate: () => { /* TODO */ } },
          { id: 'plugins', label: '插件市场', icon: Puzzle, onActivate: () => { /* TODO */ } },
        ];
      case 'chat':
        // 会话历史列表由下方 chat 分支渲染，此处无需 modules
        return [];
      case 'profile':
        return [
          { id: 'settings', label: '设置', icon: Settings2, onActivate: () => { /* TODO */ } },
        ];
      default:
        return [];
    }
  })();

  return (
    <div className="flex flex-col h-full">
      {/* 品牌头 */}
      <div className="p-4 border-b border-[var(--border)]">
        <h2
          className="font-semibold text-[var(--foreground)]"
          style={{ fontSize: 'var(--m-text-title)' }}
        >
          安得云荟
        </h2>
        <p
          className="text-[var(--muted-foreground)]"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          Android v1
        </p>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {/* 中转站抽屉：快捷入口（中转站 / AI对话 / 传输） */}
        {activeTab === 'transfer' && (
          <div className="mb-1">
            <div
              className="px-4 pb-1 text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              快捷入口
            </div>
            {quickTabs.map((t) => {
              const Icon = t.icon;
              const isCurrent = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    if (!isCurrent) switchTab(t.id);
                    setDrawerOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 text-left active:bg-[var(--muted)]/60 transition-colors"
                  style={{
                    height: '48px',
                    fontSize: 'var(--m-text-label)',
                    color: isCurrent ? 'var(--element-bg)' : 'var(--foreground)',
                  }}
                >
                  <Icon size={20} className="text-[var(--muted-foreground)]" />
                  {t.label}
                  {isCurrent && <span className="ml-auto text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>当前</span>}
                </button>
              );
            })}
            {modules.map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    m.onActivate();
                    setDrawerOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 text-left text-[var(--foreground)] active:bg-[var(--muted)]/60 transition-colors"
                  style={{ height: '48px', fontSize: 'var(--m-text-label)' }}
                >
                  <Icon size={20} className="text-[var(--muted-foreground)]" />
                  {m.label}
                </button>
              );
            })}
          </div>
        )}

        {/* chat 抽屉：会话历史列表（多会话） */}
        {activeTab === 'chat' && (
          <div>
            <div
              className="px-4 pb-1 text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              {currentLabel} · 对话记录（{conversations.length}）
            </div>
            {conversations.map((c) => {
              const active = c.id === activeConvId;
              // 标题为空时用首条消息内容兜底
              const title = c.title || '新对话';
              const preview =
                c.timeline.find((it) => it.type === 'message')?.msg.content || '（空对话）';
              return (
                <div key={c.id} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      selectConversation(c.id);
                      setDrawerOpen(false);
                    }}
                    className="flex-1 min-w-0 px-4 py-2.5 text-left active:bg-[var(--muted)]/60 transition-colors"
                  >
                    <div
                      className="truncate font-medium"
                      style={{
                        fontSize: 'var(--m-text-label)',
                        color: active ? 'var(--element-bg)' : 'var(--foreground)',
                      }}
                    >
                      {title}
                    </div>
                    <div className="truncate text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                      {preview}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteConversation(c.id)}
                    className="shrink-0 p-3 text-[var(--muted-foreground)] active:scale-90 transition-transform"
                    aria-label="删除对话"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => {
                createConversation();
                setDrawerOpen(false);
              }}
              className="flex w-full items-center gap-3 px-4 text-left text-[var(--element-bg)] active:bg-[var(--muted)]/60 transition-colors"
              style={{ height: '48px', fontSize: 'var(--m-text-label)' }}
            >
              <Plus size={20} />
              新建对话
            </button>
          </div>
        )}

        {/* 其他 Tab（discover/profile）的模块入口 */}
        {activeTab !== 'transfer' && activeTab !== 'chat' && (
          <>
            <div
              className="px-4 pb-1 text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              {currentLabel} · 模块
            </div>
            {modules.map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    m.onActivate();
                    setDrawerOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 text-left text-[var(--foreground)] active:bg-[var(--muted)]/60 transition-colors"
                  style={{ height: '48px', fontSize: 'var(--m-text-label)' }}
                >
                  <Icon size={20} className="text-[var(--muted-foreground)]" />
                  {m.label}
                </button>
              );
            })}
          </>
        )}
      </nav>
    </div>
  );
}
