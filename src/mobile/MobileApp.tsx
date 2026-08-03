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
import { Plus, MoreVertical, Send, Inbox, Sparkles, Book, Puzzle, Settings2, MessageSquarePlus, type LucideIcon } from 'lucide-react';
import { NiaoluoScreen } from './screens/NiaoluoScreen';

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
 * 抽屉内容：根据当前激活 Tab 渲染「主导航 + 该 Tab 的模块入口」。
 * - transfer/discover Tab：列出该 Tab 下的功能模块（点击跳转/触发）
 * - chat Tab：新建对话 + 打开溢出菜单（chatStore 桥接）
 * - profile Tab：设置入口
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
  const newConversation = useChatStore((s) => s.newConversation);
  const openOverflow = useChatStore((s) => s.openOverflow);

  // 跳转到「传输」模块：切到发现 Tab 并 push 茑萝入口屏（茑萝内可继续进传输）
  const openNiaoluo = () => {
    switchTab('discover');
    push('discover', {
      id: 'niaoluo-home',
      title: '茑萝',
      render: () => <NiaoluoScreen />,
    });
  };

  const TAB_ITEMS: { tab: typeof activeTab; label: string }[] = [
    { tab: 'transfer', label: '中转站' },
    { tab: 'chat', label: 'AI 对话' },
    { tab: 'discover', label: '发现' },
    { tab: 'profile', label: '我的' },
  ];

  const modules: DrawerModule[] = (() => {
    switch (activeTab) {
      case 'transfer':
        return [
          { id: 'transfer', label: '传输', icon: Send, onActivate: openNiaoluo },
        ];
      case 'discover':
        return [
          { id: 'transfer', label: '传输', icon: Send, onActivate: openNiaoluo },
          { id: 'ai', label: 'AI 模板', icon: Sparkles, onActivate: () => { /* TODO: AI 模板模块 */ } },
          { id: 'reading', label: '阅读资源', icon: Book, onActivate: () => { /* TODO */ } },
          { id: 'plugins', label: '插件市场', icon: Puzzle, onActivate: () => { /* TODO */ } },
        ];
      case 'chat':
        return [
          { id: 'new', label: '新建对话', icon: MessageSquarePlus, onActivate: () => newConversation?.() },
          { id: 'more', label: '更多设置', icon: Settings2, onActivate: () => openOverflow?.() },
        ];
      case 'profile':
        return [
          { id: 'settings', label: '设置', icon: Settings2, onActivate: () => { /* TODO */ } },
        ];
      default:
        return [];
    }
  })();

  const currentLabel = TAB_ITEMS.find((i) => i.tab === activeTab)?.label ?? '';

  return (
    <div className="flex flex-col h-full">
      {/* 品牌头 */}
      <div className="p-4 border-b border-[var(--border)]">
        <h2
          className="font-semibold text-[var(--foreground)]"
          style={{ fontSize: 'var(--m-text-title)' }}
        >
          安灯花园
        </h2>
        <p
          className="text-[var(--muted-foreground)]"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          Android v1
        </p>
      </div>

      {/* 主导航（4 Tab） */}
      <nav className="py-2 border-b border-[var(--border)]">
        {TAB_ITEMS.map((item) => {
          const active = activeTab === item.tab;
          return (
            <button
              key={item.tab}
              type="button"
              onClick={() => {
                switchTab(item.tab);
                setDrawerOpen(false);
              }}
              className="flex w-full items-center px-4 text-left active:bg-[var(--muted)]/60 transition-colors"
              style={{
                height: '48px',
                backgroundColor: active ? 'var(--element-muted)' : undefined,
                color: active ? 'var(--element-bg)' : 'var(--foreground)',
                fontSize: 'var(--m-text-label)',
              }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* 当前 Tab 的模块入口 */}
      <nav className="flex-1 overflow-y-auto py-2">
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
      </nav>
    </div>
  );
}
