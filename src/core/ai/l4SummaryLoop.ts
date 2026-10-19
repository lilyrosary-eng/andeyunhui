// 桌面端 L2/L4 记忆闭环：每 N 轮对话做一次摘要（唯一会花 LLM 调用的一环）。
//
// 背景（2026-10-19 审计结论）：
//   - 移动端 `useAiStream` 每条消息都跑 `summarizeMemory`，因此 L2 摘要 / L3 摘要向量 /
//     L4 关系快照在移动端是完整的；
//   - 桌面端此前**只有**每轮 `ingestChatTurn`（原始对话进 L3）+ `autoSyncCompanion`
//     （persona/core 指纹变化才写），**从不产生摘要、也从不产生关系快照** ——
//     L2/L4 在桌面是半个残疾。
//
// 这里按用户拍板的「每 10 轮一次」补齐，设计约束：
//   1. **不阻塞对话**：调用方 fire-and-forget，本模块内部全部 await 但不回传 UI；
//   2. **不重复触发**：轮次从会话消息派生（无状态），已摘要轮次记在 storage 里做水位线；
//      再加进程内 running 锁，避免 ai-done 双触发导致同轮跑两次（那是白烧 token）；
//   3. **失败不污染**：摘要写库前必须确认是真实模型输出，失败只 console.warn，
//      绝不写入占位文本（companionStore.summarizeMemory 的预览降级已同步收紧）。
import { isBrowserPreview, summarizeMemory, useCompanionStore } from '@/core/stores/companionStore';
import { ingestMemory } from '@/core/stores/semanticMemory';
import { storage } from '@/core/storage';

/** 每多少「轮用户提问」触发一次摘要。用户拍板值。 */
export const SUMMARY_EVERY_TURNS = 10;

/** 摘要窗口：只看最近 20 条消息（≈10 轮），避免整段会话反复喂给模型。 */
const WINDOW_MESSAGES = 20;

const MARK_PREFIX = 'andeyunhui.ai.l4mark.';

/** 进程内运行锁：同一会话同一时刻只允许一个摘要任务。 */
const running = new Set<string>();

interface Msg {
  role: string;
  content: string;
  error?: boolean;
}

/** 数用户轮次（只数非空 user 消息）。 */
function countTurns(messages: Msg[]): number {
  return messages.filter((m) => m.role === 'user' && m.content.trim()).length;
}

/**
 * 达到里程碑就异步摘要一次。调用方 fire-and-forget（返回 Promise 只为便于测试）。
 *
 * @param convId   会话 id（水位线按会话隔离，不同会话互不影响）
 * @param messages 该会话当前全部消息（内部只取尾部窗口）
 */
export async function maybeSummarizeConversation(convId: string, messages: Msg[]): Promise<void> {
  if (isBrowserPreview()) return;
  if (!convId || !messages?.length) return;

  const turns = countTurns(messages);
  // 未到里程碑，或刚好在里程碑点上（turns=10/20/30…）才触发。
  if (turns < SUMMARY_EVERY_TURNS || turns % SUMMARY_EVERY_TURNS !== 0) return;

  const markKey = MARK_PREFIX + convId;
  const marked = Number(storage.getString(markKey, '0')) || 0;
  if (marked >= turns) return; // 这一轮已经摘要过（重启/重进会话都不会重跑）
  if (running.has(convId)) return;
  running.add(convId);

  try {
    const window = messages
      .filter((m) => !m.error && m.content.trim())
      .slice(-WINDOW_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    if (window.length < 2) return;

    const res = await summarizeMemory(window);
    // 关键防御：后端失败时 summarizeMemory 会返回 null（预览降级已收紧），
    // 这里再挡一次空摘要，避免把空串写进记忆。
    if (!res || !res.summary?.trim()) {
      console.warn('[l4] 摘要失败或为空，跳过本轮（不写占位文本）');
      return;
    }

    const store = useCompanionStore.getState();
    const companionId = store.companion.id;

    // L2 滚动摘要（store 内部已做近似去重）
    await store.addMemory('summary', res.summary);
    // L3 摘要向量（ingestMemory 内部对 summary 做近似去重）
    await ingestMemory(companionId, 'summary', res.summary);

    // L1 核心事实 / L2 情感增量（后端 EMA 推进关系）
    const milestone = await store.applyDeltas(res.deltas ?? {}, res.coreFacts ?? []);

    // L4 关系脉络快照：AI 之后可以检索「关系过去的状态」
    const rel = useCompanionStore.getState().companion.relationship;
    if (rel) {
      void ingestMemory(
        companionId,
        'snapshot',
        `关系快照：温暖 ${rel.warmth}，信任 ${rel.trust}，亲密 ${rel.intimacy}，好奇 ${rel.intrigue}，耐心 ${rel.patience}，张力 ${rel.tension}`,
        { snapshot: true, at_turns: turns },
      );
    }

    // 水位线最后写：中途失败则下次里程碑重试（宁可重跑一次，也不静默丢记忆）
    storage.setString(markKey, String(turns));
    console.info(
      `[l4] 会话 ${convId} 第 ${turns} 轮摘要完成${milestone ? `（里程碑：${milestone}）` : ''}`,
    );
  } catch (e) {
    console.warn('[l4] 摘要链路异常（不影响对话）:', e);
  } finally {
    running.delete(convId);
  }
}

/** 测试/调试用：清除某会话的水位线。 */
export function resetSummaryMark(convId: string): void {
  storage.remove(MARK_PREFIX + convId);
}
