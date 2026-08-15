// 黄金棋盘浮岛共享类型（从 Capsule.tsx 抽出，供壳与子面板复用）

export interface PlayInfo {
  title: string;
  artist: string;
  album: string;
  is_playing: boolean;
  media_type: string;
  cover_path: string | null;
  can_prev: boolean;
  can_next: boolean;
  /** 来源：'system' = 整机媒体监视读取的任意 App；缺省/其他 = 本应用经 smtc_update 推送 */
  source?: string;
  /** 会话稳定标识：系统会话=AUMID，本应用="app"。多个媒体间去重/切换用 */
  key?: string;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string; // 思考模式下的思维链（reasoning_content），可折叠遮罩展示
  error?: boolean;
  /** 群聊模式：哪条消息由哪个伴侣说的（companion.id）。单聊模式隐含为当前 active companion。 */
  speakerId?: string;
  /**
   * 成本计量（内部用，绝不向用户暴露 severity 数字或"调侃/争论"字样，避免破坏沉浸感）。
   * 0=省 / 1=中性 / 2=较贵 / 3=很贵。仅用于"本次群聊已调用 N 次 AI"这类烧钱提示，
   * 由 router 在每轮群聊发言规划时给出量级估计。
   */
  severity?: 0 | 1 | 2 | 3;
}

// 多会话：下拉选择 / 新建对话
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMsg[];
  updatedAt: number;
  /** 会话模式：单聊（默认）/ 群聊 */
  mode?: 'single' | 'group';
  /** 群聊参与者：companion.id 列表（顺序即发言顺序）。仅 group 模式使用。 */
  participants?: string[];
  /** 群聊显示名（用于侧栏/标题） */
  groupName?: string;
  /**
   * 群聊成本计量（内部用，不对用户暴露 severity/成本明细，仅汇总成轻量提示）。
   * calls = 本轮群聊累计触发的 AI 调用次数；用户可见的提示是"本次群聊已调用 N 次 AI"。
   */
  groupCost?: { calls: number };
}

// 接收请求载荷（与 Rust transfer.rs 的 transfer-receive-request 事件一致）
export interface ReceiveRequest {
  session_id: string;
  sender_alias: string;
  file_count: number;
  file_names: string[];
  auto_accept: boolean;
}

// AI 模型档案（ai_get_profiles 返回，chat/aide 共用）
export interface AiProfile {
  id: string;
  name?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
}
