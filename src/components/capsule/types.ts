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
}

// 多会话：下拉选择 / 新建对话
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMsg[];
  updatedAt: number;
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
