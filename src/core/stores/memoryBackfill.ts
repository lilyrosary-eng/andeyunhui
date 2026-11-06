// 历史对话回填向量库（2026-11-05 新增）。
//
// 为什么需要：自动沉淀依赖嵌入端点，端点不可用时那一轮就永久丢了（实测 10-29/10-30 五次会议式
// 对话在库里一条都没有）。这里把磁盘上的会话事件重新配对成「用户 + 助手」轮次，走同一条
// ingestChatTurn 写进向量库，一次性补回可检索的那半层。
//
// 三条不变量：
//   1. **幂等**：uri 用 `chat://backfill/<会话id>/<助手消息序号>` 这种确定性值，
//      配合 rag_ingest 的 `replace` → 重复点按钮只覆盖，不会堆重复来源。
//   2. **不重复嵌**：先按现有来源的正文文本建一个集合，已经沉淀过的轮次直接跳过
//      （老记录用的是 `chat://<时间戳>`，光靠 uri 认不出来，所以按文本认）。
//   3. **不卡界面**：每条之间让出一帧；进度回调给 UI。
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';

import { buildTurnText, ingestChatTurn } from './semanticMemory';

const NAMESPACE = 'ai-chat';

export interface BackfillReport {
  /** 扫到的会话文件数 */
  sessions: number;
  /** 配对出来的轮次总数 */
  turns: number;
  written: number;
  /** 库里已有同样正文，跳过 */
  skippedExisting: number;
  /** 嵌入端点不可用，已转入待重试队列 */
  queued: number;
  failed: number;
}

interface SessionMeta {
  id: string;
  createdAt?: string;
  eventCount?: number;
}

/** 磁盘上的会话文件（事件溯源，不做冗余的消息数组）。 */
interface SessionFile {
  events?: SessionEvent[];
  created_at?: string;
}

type SessionEvent = Record<string, { seq?: number; content?: string } | undefined>;

/** base64 → UTF-8 文本（`atob` 只给 latin1 字节串，中文必须走 TextDecoder）。 */
function decodeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 会话事件 → 轮次。事件是 `{ User: { seq, content } } / { Assistant: { seq, content, tool_calls } } / { Tool }`。
 *
 * 三条规则都有实测依据：
 *   - 助手在工具调用那几条 content 是空的（10-30 那个会话就是这样），所以没正文时
 *     **不清空**待配对的提问，等真正带正文的那条助手消息出现再配对；
 *   - 连续两条用户消息（用户追发/改口）合并成一条，两条都留在记忆里，谁都不丢；
 *   - 始终没有助手正文的轮次（纯工具失败）**不产出**：`用户：X\n助手：` 这种半条记录
 *     只会污染检索结果，回填宁可少写也不写噪声。
 */
export function extractTurns(
  events: Array<Record<string, { seq?: number; content?: string } | undefined>>,
): { user: string; asst: string; seq: number }[] {
  const out: { user: string; asst: string; seq: number }[] = [];
  let pendingUser: string | null = null;
  for (const ev of events) {
    const u = ev?.User;
    const a = ev?.Assistant;
    if (u && typeof u.content === 'string' && u.content.trim()) {
      const t = u.content.trim();
      pendingUser = pendingUser ? `${pendingUser}\n${t}` : t;
      continue;
    }
    if (a && pendingUser !== null && typeof a.content === 'string' && a.content.trim()) {
      out.push({ user: pendingUser, asst: a.content.trim(), seq: a.seq ?? out.length });
      pendingUser = null;
    }
  }
  return out;
}

/** 解析会话文件；不是合法 JSON 就返回 null（调用方跳过该会话并留一条 warn）。 */
function parseSession(raw: string, id: string): SessionFile | null {
  try {
    return JSON.parse(raw) as SessionFile;
  } catch (e) {
    console.warn(`[backfill] 会话 ${id} 不是合法 JSON（跳过）:`, e);
    return null;
  }
}

/** 库里已有的对话正文（按文本认重复）。读不到就返回空集，退化成"只靠 uri 幂等"。 */
async function existingTurnTexts(): Promise<Set<string>> {
  const texts = new Set<string>();
  try {
    const sources = await invoke<Array<{ id: string; type: string }>>('rag_list_sources', { namespace: NAMESPACE });
    for (const s of sources ?? []) {
      if (s.type !== 'chat') continue;
      try {
        const rows = await invoke<Array<{ text: string }>>('rag_list_chunks', { sourceId: s.id, namespace: NAMESPACE });
        for (const r of rows ?? []) if (r?.text) texts.add(r.text);
      } catch (e) {
        console.warn(`[backfill] 读取来源 ${s.id} 的分块失败，跳过其去重信息:`, e);
      }
    }
  } catch (e) {
    console.warn('[backfill] 读取现有来源失败，本次不做正文去重:', e);
  }
  return texts;
}

/** 执行回填。onProgress(done, total) 在每条写入后回调。 */
export async function backfillChatMemory(
  onProgress?: (done: number, total: number) => void,
): Promise<BackfillReport> {
  const report: BackfillReport = { sessions: 0, turns: 0, written: 0, skippedExisting: 0, queued: 0, failed: 0 };
  const metas = JSON.parse(
    (await invoke<string>('ai_agent_sessions', { projectRoot: null })) || '[]',
  ) as SessionMeta[];
  report.sessions = metas.length;
  const dir = await appDataDir();
  const seen = await existingTurnTexts();

  for (const m of metas) {
    let raw: string;
    try {
      const path = await join(dir, 'ai_sessions', `${m.id}.json`);
      raw = decodeBase64(await invoke<string>('read_file_base64', { filePath: path }));
    } catch (e) {
      console.warn(`[backfill] 会话 ${m.id} 读取失败（跳过这个会话）:`, e);
      continue;
    }
    const parsed = parseSession(raw, m.id);
    if (!parsed) continue;
    const rawEvents = parsed.events ?? [];
    const events: SessionEvent[] = Array.isArray(rawEvents) ? rawEvents : [];
    // created_at 形如 "2026-10-21 15:24:10"（本地时间，无时区后缀）
    const at = parsed.created_at ? Date.parse(parsed.created_at.replace(' ', 'T')) : 0;
    // 时间不可用才退回当前时刻，避免回填记录的标题全挤成"今天"
    const base = Number.isFinite(at) && at > 0 ? at : Date.now();
    for (const t of extractTurns(events)) {
      report.turns++;
      const text = buildTurnText(t.user, t.asst);
      if (!text.trim()) continue;
      if (seen.has(text)) {
        report.skippedExisting++;
        onProgress?.(report.written + report.skippedExisting, report.turns);
        continue;
      }
      try {
        const r = await ingestChatTurn(
          t.user,
          t.asst,
          NAMESPACE,
          `chat://backfill/${m.id}/${t.seq}`,
          // 每条错开一秒：标题里的时间要能区分同一会话的不同轮次，而不是全挤在同一刻
          base + t.seq * 1000,
        );
        if (r === 'written') report.written++;
        else if (r === 'queued') report.queued++;
        else report.failed++;
        seen.add(text); // 同一会话里重复出现的同样正文不重复嵌
      } catch (e) {
        console.warn(`[backfill] 第 ${t.seq} 轮写入失败:`, e);
        report.failed++;
      }
      onProgress?.(report.written + report.skippedExisting, report.turns);
      // 让出一帧：几十次嵌入串起来会把界面钉住
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return report;
}
