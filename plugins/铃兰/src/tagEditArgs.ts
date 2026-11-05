/**
 * 编辑弹窗草稿 → `music_edit_track` 参数的映射（纯函数，单独可测）。
 *
 * 为什么要抽出来：Tauri 只认 camelCase 参数名，而数字项与文本项的「空值」语义不同 ——
 * 文本项空串在后端是**清除该字段**，数字项后端没有清除语义（lofty 的 DiscNumber 等只在
 * 有值时写）。两边各写一份映射迟早会漏字段，而漏掉的字段是**静默不生效**的那种错。
 */

/** 草稿里的数字项（其余按文本处理） */
export const NUMERIC_TAG_FIELDS = ['trackNumber', 'trackTotal', 'discNumber', 'discTotal'] as const;

/** 后端 music_service::EditOutcome */
export interface EditOutcome {
  batchId: string;
  dropped: string[];
}

type DraftLike = Record<string, string | undefined>;

/**
 * 把改动过的字段拼成 invoke 参数。
 *
 * - `undefined` 的键直接不传（= 后端保持原值不动）
 * - 文本项原样下发，空串会让后端清除该字段
 * - 数字项：空串/非数字**跳过不传**（后端没有"清空数字帧"的语义，不能假装清掉了）
 */
export function buildEditArgs(filePath: string, fields: DraftLike): Record<string, unknown> {
  const args: Record<string, unknown> = { filePath };
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if ((NUMERIC_TAG_FIELDS as readonly string[]).includes(key)) {
      const t = String(raw).trim();
      if (t === '') continue;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) continue;
      args[key] = Math.trunc(n);
      continue;
    }
    args[key] = raw;
  }
  return args;
}
