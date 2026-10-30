// 会话媒体的“磁盘化”：localStorage 只存短引用，图片/音频/视频本体落到本地媒体库。
//
// 为什么需要：会话持久化原本把图片 data URL 直接塞进 localStorage，配额一满就被
// `sanitizeConv` 按预算清空，重进对话只剩「未随历史保存」的文字。现在持久化前先把
// 媒体转存成 `image://<id>`（后端 content-addressed 文件），加载时再读回 data URL。
// 这样图片不会因为 localStorage 配额而丢失，也不会把 localStorage 撑爆。
//
// 失败降级：Tauri 命令不可用或转存失败时保留原始 data URL，交回旧的预算逻辑处理。
import { invoke } from '@tauri-apps/api/core';
import type { Conversation, ChatMsg, MsgVersion } from '@/components/capsule/types';
import { loadConversations, persistConversations } from './util';

const REF_PREFIX = 'image://';
const MEDIA_META_KEYS = ['image', 'audio', 'video'] as const;
const MAX_TAIL_DEPTH = 6;

/** data URL → 引用、引用 → data URL 的内存缓存：流式期间会反复走持久化，不能每次都 IPC。 */
const dataUrlToRef = new Map<string, string>();
const refToDataUrl = new Map<string, string>();

function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:');
}
function isRef(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(REF_PREFIX);
}
function remember(map: Map<string, string>, key: string, value: string): void {
  if (map.size > 200) map.clear();
  map.set(key, value);
}

async function storeOne(dataUrl: string): Promise<string> {
  const hit = dataUrlToRef.get(dataUrl);
  if (hit) return hit;
  const ref = await invoke<string | null>('ai_media_store', { dataUrl });
  if (ref) {
    remember(dataUrlToRef, dataUrl, ref);
    remember(refToDataUrl, ref, dataUrl);
    return ref;
  }
  return dataUrl;
}

async function loadOne(ref: string): Promise<string> {
  const hit = refToDataUrl.get(ref);
  if (hit) return hit;
  const dataUrl = await invoke<string | null>('ai_media_load', { r: ref });
  if (dataUrl) {
    remember(refToDataUrl, ref, dataUrl);
    remember(dataUrlToRef, dataUrl, ref);
    return dataUrl;
  }
  return ref;
}

async function mapMedia(m: ChatMsg, mode: 'store' | 'load', depth: number): Promise<ChatMsg> {
  const convert = mode === 'store' ? storeOne : loadOne;
  const should = mode === 'store' ? isDataUrl : isRef;
  let out = m;

  if (Array.isArray(m.images) && m.images.some(should)) {
    const images: string[] = [];
    for (const src of m.images) images.push(should(src) ? await convert(src) : src);
    out = { ...out, images };
  }

  if (Array.isArray(m.agentSteps) && m.agentSteps.length) {
    let touched = false;
    const steps = [];
    for (const step of m.agentSteps) {
      const meta = step?.meta;
      if (!meta) { steps.push(step); continue; }
      let changed = false;
      const nextMeta: Record<string, unknown> = { ...meta };
      for (const key of MEDIA_META_KEYS) {
        const v = nextMeta[key];
        if (should(v)) {
          nextMeta[key] = await convert(v);
          changed = true;
        }
      }
      if (changed) { steps.push({ ...step, meta: nextMeta }); touched = true; }
      else steps.push(step);
    }
    if (touched) out = { ...out, agentSteps: steps };
  }

  if (Array.isArray(m.versions) && m.versions.length && depth < MAX_TAIL_DEPTH) {
    let touched = false;
    const versions: MsgVersion[] = [];
    for (const v of m.versions) {
      if (!v?.tail?.length) { versions.push(v); continue; }
      const tail: ChatMsg[] = [];
      for (const tm of v.tail) tail.push(await mapMedia(tm, mode, depth + 1));
      versions.push({ ...v, tail });
      touched = true;
    }
    if (touched) out = { ...out, versions };
  }

  return out;
}

async function mapConversation(c: Conversation, mode: 'store' | 'load'): Promise<Conversation> {
  let out: Conversation = c;
  if (Array.isArray(c.messages) && c.messages.length) {
    const messages: ChatMsg[] = [];
    for (const m of c.messages) messages.push(await mapMedia(m, mode, 0));
    out = { ...out, messages };
  }
  const nodes = c.aiWork?.nodes;
  if (Array.isArray(nodes) && nodes.length) {
    const convert = mode === 'store' ? storeOne : loadOne;
    const should = mode === 'store' ? isDataUrl : isRef;
    let touched = false;
    const nextNodes = [];
    for (const n of nodes) {
      if (should(n.output)) {
        nextNodes.push({ ...n, output: await convert(n.output) });
        touched = true;
      } else {
        nextNodes.push(n);
      }
    }
    if (touched) out = { ...out, aiWork: { ...c.aiWork!, nodes: nextNodes } };
  }
  return out;
}

/** 持久化前：把媒体 data URL 转成短引用。失败时原样返回（交给旧预算逻辑）。 */
export async function extractMediaFromConversations(list: Conversation[]): Promise<Conversation[]> {
  try {
    const out: Conversation[] = [];
    for (const c of list) out.push(await mapConversation(c, 'store'));
    return out;
  } catch (e) {
    console.warn('[ai-chat] 媒体转存失败，回落为原样持久化（图片可能被配额瘦身）:', e);
    return list;
  }
}

/** 加载后：把短引用读回 data URL，恢复图片渲染。失败时保留引用。 */
export async function hydrateMediaInConversations(list: Conversation[]): Promise<Conversation[]> {
  try {
    const out: Conversation[] = [];
    for (const c of list) out.push(await mapConversation(c, 'load'));
    return out;
  } catch (e) {
    console.warn('[ai-chat] 媒体回填失败，图片可能无法显示:', e);
    return list;
  }
}

const writeSeq = new Map<string, number>();

/** 会话持久化（带媒体转存）。同一 key 的并发写只保留最后一次，避免旧快照后写覆盖新快照。 */
export async function persistConversationsWithMedia(key: string, list: Conversation[]): Promise<void> {
  const seq = (writeSeq.get(key) ?? 0) + 1;
  writeSeq.set(key, seq);
  const prepared = await extractMediaFromConversations(list);
  if ((writeSeq.get(key) ?? 0) !== seq) return;
  persistConversations(key, prepared);
}

/** 会话加载（带媒体回填）。 */
export async function loadConversationsWithMedia(key: string): Promise<Conversation[]> {
  return hydrateMediaInConversations(loadConversations(key));
}
