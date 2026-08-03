/**
 * ChatHome — AI 对话 Tab 根屏。
 *
 * T07：接入真实对话 UI（ChatScreen），含算力来源条、虚拟滚动消息列表、
 * 流式响应、行内降级卡片、来源切换分隔、上下文芯片预留位。
 *
 * AppBar 的 ⊕（新建会话）/ ⋮（溢出）按钮由 MobileApp 经 chatStore 触发，
 * ChatScreen 挂载时把实现注册进 chatStore（见 ChatScreen 的 useEffect）。
 */

import { ChatScreen } from './ChatScreen';

export function ChatHome() {
  return <ChatScreen />;
}
