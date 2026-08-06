/** 对外展示用的六维关系维度。 */
export interface RelationshipLike {
  warmth?: number;
  trust?: number;
  intimacy?: number;
  intrigue?: number;
  patience?: number;
  /** 张力：不纳入正向加权（保留声明以兼容调用方） */
  tension?: number;
}

/** 综合亲密度（对外唯一口径）：温暖30 / 信任20 / 亲密40 / 好奇5 / 耐心5，round + clamp [0,100]。原两处拷贝归一。 */
export function affinityOf(r: RelationshipLike): number {
  const w =
    (r.warmth ?? 0) * 0.3 + (r.trust ?? 0) * 0.2 + (r.intimacy ?? 0) * 0.4 +
    (r.intrigue ?? 0) * 0.05 + (r.patience ?? 0) * 0.05;
  return Math.round(Math.min(100, Math.max(0, w)));
}