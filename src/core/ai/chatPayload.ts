// 请求载荷构造（从 useAiChat 抽出，2026-10-21）。
//
// 为什么单独成文件：这是"发给模型的东西"的唯一出口，也是最近几轮 bug 的高发区
// （重新生成把旧回复一起发出去、toolNote 回灌、历史无限增长）。放在 hook 里只能靠
// 手点界面验证，抽出来才能写契约测试钉住形状。
import type { ChatMsg } from '@/components/capsule/types';

/** 每次请求携带的历史消息上限（尾部截断），防止长对话/群聊累计历史超出模型上下文。 */
export const CHAT_HISTORY_LIMIT = 40;
/** 群聊：每轮历史含所有伴侣回复，膨胀更快，收紧窗口。 */
export const GROUP_HISTORY_LIMIT = 16;
/** 单条 content 硬切（字符）。 */
export const HARD_MSG_CAP = 8_000;
/** 总 token 硬切（远低于模型上限 1048576）。 */
export const HARD_TOTAL_CAP = 200_000;

/** 估 token：CJK 按 1 字 1 token，其余按 4 字符 1 token（够用的粗估）。 */
export function estTokens(s: string): number {
  // 必须用 \u 转义写 CJK 区间：直接粘全角空格（U+3000）会触发 no-irregular-whitespace
  const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

/**
 * 条数 + 单条长度 + 总 token 三重截断（与后端 `truncate_messages_for_safety` 双保险）。
 *
 * 从尾部保留：越近的对话越重要。
 */
export function safeMessages(
  msgs: Array<{ role: string; content: string }>,
  limit: number = CHAT_HISTORY_LIMIT,
): Array<{ role: string; content: string }> {
  let total = 0;
  let maxLen = 0;
  const rawTotalChars = msgs.reduce((s, m) => s + (m.content?.length || 0), 0);
  const rawCount = msgs.length;
  const recent = rawCount > limit ? msgs.slice(rawCount - limit) : msgs;
  const out: Array<{ role: string; content: string }> = [];
  for (const m of [...recent].reverse()) {
    let content = typeof m.content === 'string' ? m.content : '';
    if (content.length > maxLen) maxLen = content.length;
    if (content.length > HARD_MSG_CAP) content = content.slice(0, HARD_MSG_CAP) + '…（超长已截断）';
    const t = estTokens(content);
    if (total + t > HARD_TOTAL_CAP) break; // 从尾部取，总超则停止（保留最近若干条）
    out.unshift({ role: m.role, content });
    total += t;
  }
  console.log(
    `[ai-chat] safeMessages: 原始条数=${rawCount}(上限${limit}) 原始总字符=${rawTotalChars} 裁剪后=${out.length} 最大单条字符=${maxLen} 估算总token≈${total}`,
  );
  if (rawCount > out.length || maxLen > HARD_MSG_CAP) {
    console.error(
      `[ai-chat] 请求前硬截断生效：原始条数=${rawCount}(上限${limit}) 裁剪后=${out.length} 最大单条字符=${maxLen} 估算总token≈${total}。`
      + `若原始条数远大于 ${limit} 或最大单条接近 ${HARD_MSG_CAP}，说明存在重复拼接/旧bundle未重建。`,
    );
  }
  return out;
}

/**
 * 构造本轮请求的 messages。
 *
 * 三个必须做对的地方（都有对应的单测）：
 *   1. **toolNote / error 不进历史**：`toolNote` 是本地工具输出（如浮岛"攻防"的快捷指令结果），
 *      不是模型或用户的发言；`error` 是本地追加的 `⚠ …` 提示。回灌给模型只会污染上下文、
 *      还把 token 白白烧掉。
 *   2. **重新生成不重复追加 user 消息**：历史里已经包含本轮提问（`skipUserAppend`），
 *      再追加一次会让模型看到同一句话两遍。
 *   3. 图片 OCR 描述与附件正文只拼在**最后一条 user** 上，不改动界面里显示的原文。
 */
export function buildRequestMessages(
  history: ChatMsg[],
  userMsg: ChatMsg,
  opts: { inject?: string; skipUserAppend?: boolean; limit?: number } = {},
): Array<{ role: string; content: string }> {
  const inject = opts.inject ?? '';
  const clean = history.filter((m) => !m.toolNote && !m.error);
  const tail = opts.skipUserAppend
    ? []
    : [{ ...userMsg, content: userMsg.content + inject }];
  const all = clean.concat(tail);
  if (opts.skipUserAppend) {
    const last = all[all.length - 1];
    if (!last || last.role !== 'user') {
      // 重新生成的前提是"历史末尾就是本轮提问"；不满足说明调用方截断错了位置，
      // 发出去会变成"没有问题的请求"，必须显式留痕而不是静默继续。
      console.error(
        '[ai-chat] 重新生成：历史末尾不是 user 消息，请求可能缺少用户问题；roles=',
        all.map((m) => m.role),
      );
    }
  }
  return safeMessages(all.map((m) => ({ role: m.role, content: m.content })), opts.limit);
}
