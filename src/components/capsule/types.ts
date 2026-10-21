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

/** 附件类型：image=图片(走视觉理解)；text=文本类(读内容给AI)；file=其它二进制(仅陈列文件名) */
export type AttachmentKind = 'image' | 'text' | 'file';

/** 消息里陈列的附件元数据（仅存名字/类型/大小，不落大体积内容，避免撑爆 localStorage） */
export interface AttachmentMeta {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size?: number;
}

/** 发送时的附件（带临时内容：text 附件的文本内容，仅发送阶段持有，不落库） */
export interface SendAttachment {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size?: number;
  /** text 附件：读取到的文本内容（发送时注入请求，之后丢弃） */
  text?: string;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 多模态：用户发送的图片（data URL 列表）。图片本体不发给后端，后端只收到 OCR 描述。 */
  images?: string[];
  /** 非图片附件（文本/二进制）陈列元数据：文本内容已注入请求、二进制仅展示文件名。 */
  attachments?: AttachmentMeta[];
  reasoning?: string; // 思考模式下的思维链（reasoning_content），可折叠遮罩展示
  /**
   * 用户对这条回复的评价（点赞/点踩）。
   *
   * 挂在消息上而不是单独存文件：评价天然属于"这一条回复"，跟着会话一起持久化，
   * 删会话即一起消失，不需要额外的生命周期管理。
   */
  feedback?: 'up' | 'down';
  /**
   * 同一轮回复的**历史版本**（重新生成产生）。
   *
   * 语义：`versions` 长度 = 版本数，最后一个槽位就是"当前这版"；
   * `content` 永远等于 `versions[versionIndex]`（流式期间是正在生成的那一版）。
   * 为什么不用"新消息"表示新版本：那会把两条回复都塞进历史，模型下一轮会同时
   * 看到自己两版答案。同一条消息内换文本，历史只有一条，语义才对。
   */
  versions?: string[];
  /** 当前显示的是第几版（0 起）。缺省 = 最后一版。 */
  versionIndex?: number;
  error?: boolean;
  /**
   * 工具/命令产出的本地记录（非模型发言）。
   *
   * 用途：浮岛「攻防」面板的快捷指令（启动/状态/扫描…）是**直接 invoke** 的，
   * 结果要留在对话里供用户回看，但它既不是 user 也不是 assistant 的话。
   * 渲染成灰底等宽样式，且**不进模型历史**（发请求前按此标记过滤）。
   */
  toolNote?: boolean;
  /** 群聊模式：哪条消息由哪个伴侣说的（companion.id）。单聊模式隐含为当前 active companion。 */
  speakerId?: string;
  /**
   * 成本计量（内部用，绝不向用户暴露 severity 数字或"调侃/争论"字样，避免破坏沉浸感）。
   * 0=省 / 1=中性 / 2=较贵 / 3=很贵。仅用于"本次群聊已调用 N 次 AI"这类烧钱提示，
   * 由 router 在每轮群聊发言规划时给出量级估计。
   */
  severity?: 0 | 1 | 2 | 3;
  /**
   * Agent 执行会话 id（= 本次请求的 requestId，落盘于 app_data/ai_sessions/<id>.json）。
   * 有值时消息气泡显示「执行轨迹」入口，可查看事件日志（工具调用/压缩/中断修复）。
   */
  traceId?: string;
  /** Agent 执行步骤（ai-agent-step 事件实时累积；轨迹面板在落盘前也能展示）。 */
  agentSteps?: AgentStep[];
}

/** 一条 agent 工具步骤（后端 ai-agent-step 事件载荷）。 */
export interface AgentStep {
  stage: string;
  name: string;
  ok: boolean;
  detail: string;
  /** 结构化呈现 meta（后端 ToolExecResult.meta / present_result）。
   *  生图工具为 { card:'image', image:<dataURL>, title, source }，气泡内直接渲染图片。
   *  注意：落盘日志里 image 已被后端替换为占位标记（避免多 MB base64 膨胀），
   *  实时事件（内存）里才是完整 data URL。 */
  meta?: Record<string, unknown>;
}

// ==== AIWork / AIWorkflow 共用任务蓝图类型 ====
// AIWork（流式对话）与 AIWorkflow（节点画布）编辑的是「同一条任务」。
// 该任务即一条 Conversation：messages 承载流式对话历史，aiWork 承载节点蓝图，
// 两个视图（对话工作台 / 蓝图编辑器）读写同一份记录，切换即可控制粒度并预览效果。
export type WfNodeType = 'prompt' | 'llm' | 'image' | 'output';

export interface WfNode {
  id: string;
  type: WfNodeType;
  label: string;
  /** 画布相对坐标 */
  x: number;
  y: number;
  params: Record<string, string>;
  status: 'idle' | 'running' | 'ok' | 'error';
  output?: string;
}

export interface WfEdge {
  id: string;
  /** source 节点的输出 → target 节点的输入 */
  source: string;
  target: string;
}

/** 统一任务内嵌的 AIWorkflow 蓝图（流式对话 + 节点画布编辑同一任务）。 */
export interface AiWorkBlueprint {
  /** 任务一句话描述（AIWorkflow「按任务生成蓝图」用） */
  task?: string;
  nodes: WfNode[];
  edges: WfEdge[];
}

// 多会话：下拉选择 / 新建对话
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMsg[];
  updatedAt: number;
  /** 统一任务：AIWorkflow 节点蓝图（AIWork 对话 与 AIWorkflow 画布共用一条任务） */
  aiWork?: AiWorkBlueprint;
  /** 会话模式：单聊（默认）/ 群聊 */
  mode?: 'single' | 'group';
  /** 群聊参与者：companion.id 列表（顺序即发言顺序）。仅 group 模式使用。 */
  participants?: string[];
  /** 群聊显示名（用于侧栏/标题） */
  groupName?: string;
  /**
   * 标题是否已被用户手动改过（或由程序显式命名，如「xxx · 分支」）。
   *
   * 自动命名只在**标题为空**时发生；这个标记是额外的保险 ——
   * 用户起的名字不该被任何"自动"逻辑覆盖。
   */
  titleLocked?: boolean;
  /**
   * 群聊成本计量（内部用，不对用户暴露 severity/成本明细，仅汇总成轻量提示）。
   * calls = 本轮群聊累计触发的 AI 调用次数；用户可见的提示是"本次群聊已调用 N 次 AI"。
   */
  groupCost?: { calls: number };
  /**
   * 本条会话的**思考档位覆盖**（"off"/"low"/"medium"/"high"）。
   *
   * 留空 = 跟随模型配置（配置页里那个档位）。之所以存在**会话**上而不是改配置：
   * 「这次想让它多想一点」是这一轮对话的诉求，不是对这个模型的长期设定 ——
   * 写进配置会让两个入口互相覆盖，还会让"临时试一下"永久污染模型配置。
   * 后端按该模型的支持集合**收敛**越界值（见 `ResolvedTarget::effort_with_override`）。
   */
  effort?: string;
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
