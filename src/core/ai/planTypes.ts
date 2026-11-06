// Agent 计划快照（Rust plan 工具回传的结构）与前端解析工具。
// 供所有 AI 对话类界面复用（AI 对话模块 / 浮岛 AI 编程 / 移动端聊天等）。

export interface PlanTodo {
  id: string;
  content: string;
  done: boolean;
}

export interface PlanSnapshot {
  title: string;
  /** Rust 侧下一条待办的自增 id（前端只读展示，不参与渲染逻辑） */
  next_id?: number;
  todos: PlanTodo[];
}

/**
 * 计划确认闸门状态（后端 `ai-plan-approval` 事件写入消息）。
 * pending = 等用户点「确认并执行 / 重新规划」；approved / rejected = 已定案。
 */
export interface PlanApproval {
  approvalId: string;
  state: 'pending' | 'approved' | 'rejected';
}

/** 丢弃缺 id 或 content 的脏条目（后端结构不该脏，但事件是宽口径入口）。 */
function parseTodos(src: unknown[]): PlanTodo[] {
  const todos: PlanTodo[] = [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const content = typeof r.content === 'string' ? r.content : '';
    if (!id || !content) continue;
    todos.push({ id, content, done: r.done === true });
  }
  return todos;
}

/**
 * 宽松解析 `ai-agent-step` 事件里的 `plan` 字段：
 * - 非对象 / todos 非数组 → null
 * - 丢弃缺 id 或 content 的脏条目
 * - 空计划 → null（create_plan 刚建、还没 add_todo 时不显示空白面板）
 */
export function parsePlanSnapshot(raw: unknown): PlanSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.todos)) return null;
  const todos = parseTodos(o.todos);
  if (todos.length === 0) return null;
  return {
    title: typeof o.title === 'string' ? o.title : '',
    next_id: typeof o.next_id === 'number' ? o.next_id : undefined,
    todos,
  };
}

/**
 * 解析计划确认事件里的 `plan` 字段（**允许空计划**）。
 *
 * 与 parsePlanSnapshot 的唯一差别就是「空计划」这条规则：确认闸门必须把面板摆出来，
 * 哪怕 create_plan 之后一条 add_todo 都还没有 —— 否则用户看不到「确认并执行」按钮，
 * 后端的等待只能一路走到超时。
 */
export function parsePlanApproval(raw: unknown): PlanSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const todos = Array.isArray(o.todos) ? parseTodos(o.todos) : [];
  return {
    title: typeof o.title === 'string' ? o.title : '',
    next_id: typeof o.next_id === 'number' ? o.next_id : undefined,
    todos,
  };
}
