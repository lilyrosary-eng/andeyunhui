---
name: idea-refine
description: 通过结构化发散与收敛思维把模糊想法精炼为锐利可执行的概念。想法仍模糊、需在定计划前压测假设、想在收敛前扩展选项时使用。
---

# 想法精炼（Idea Refine）

## 概述

三阶段：发散（理解与扩展）→ 收敛（评估与聚焦）→ 产出（锐化与交付）。简单即极致精炼；从用户体验倒推技术；对 1000 件事说不。

## 何时使用

- 想法仍模糊
- 需在定计划前压测假设
- 想在收敛前扩展选项
- 触发词："ideate" / "refine this idea" / "stress-test my plan"

## Phase 1：理解与扩展（发散）

1. **重述为"How Might We"问题陈述**——强制明确到底在解决什么
2. **问 3-5 个 sharpening questions**（不超 5 个）：
   - 谁是这个的用户，具体？
   - 成功长什么样？
   - 真实约束（时间/技术/资源）？
   - 之前试过什么？
   - 为何现在？
3. **用 7 个 lens 生成 5-8 个变体**：
   - Inversion（反过来做？）
   - Constraint removal（去掉预算/时间/技术约束？）
   - Audience shift（换用户群？）
   - Combination（与相邻想法合并？）
   - Simplification（10x 更简的版本？）
   - 10x version（大规模时什么样？）
   - Expert lens（领域专家觉得显然而外行不觉得的？）
4. 代码库内用 Glob/Grep/Read 扫既有架构与先例，接地气

## Phase 2：评估与收敛

1. 把共鸣想法聚成 2-3 个方向（每个应感觉实质不同）
2. 按三标准压测：
   - **用户价值**：谁受益、受益多少？止痛药还是维生素？
   - **可行性**：技术与资源成本？最难的部分？
   - **差异化**：凭什么让人切换？
3. **显式列出隐藏假设**：
   - 押注为真但未验证的
   - 能杀死想法的
   - 选择忽略的及理由

**诚实而非附和**。弱想法就直说，带善意带具体。

## Phase 3：锐化与交付

产出 markdown one-pager：
- Problem Statement（How Might We 一句话）
- Recommended Direction（2-3 段）
- Key Assumptions to Validate（带验证方法）
- MVP Scope（测核心假设的最小版本，做什么不做什么）
- Not Doing（及原因）——**最有价值的部分**
- Open Questions

## 红旗

- 生成 20+ 浅变体而非 5-8 个深思熟虑的
- 跳过"为谁"
- 定方向前不浮现假设
- 对弱想法 yes-machine
- 产出计划无"Not Doing"列表
- 项目内忽略既有代码库约束
- 跳过 Phase 1/2 直接产出 Phase 3

## 验证

- [ ] 清晰"How Might We"问题陈述
- [ ] 目标用户与成功标准已定义
- [ ] 探索过多方向而非仅首个
- [ ] 隐藏假设显式列出带验证策略
- [ ] "Not Doing"列表使权衡明确
- [ ] 产出为具体 markdown one-pager 而非仅对话
- [ ] 用户在实现前已确认最终方向
