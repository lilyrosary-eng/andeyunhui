---
name: using-agent-skills
description: 发现并调用 agent 技能。会话开始时、需要发现当前任务适用哪个技能时使用。这是治理其他所有技能的元技能。
---

# 使用 Agent 技能（Using Agent Skills）

## 概述

按开发阶段匹配技能。技能编码了资深工程师遵循的具体流程，防止常见错误。

## 技能发现

按任务阶段匹配：
- 不知想要什么 → interview-me / idea-refine
- 新项目/功能 → spec-driven-development
- 有 spec 需任务 → planning-and-task-breakdown
- 实现代码 → incremental-implementation（子：frontend-ui-engineering / context-engineering / source-driven-development）
- 写/跑测试 → test-driven-development
- 出错了 → debugging-and-error-recovery
- 审查代码 → code-review-and-quality（子：code-simplification / security-and-hardening / performance-optimization）
- 提交/分支 → git-workflow-and-versioning
- CI/CD → ci-cd-and-automation
- 弃用/迁移 → deprecation-and-migration
- 写文档/ADR → documentation-and-adrs
- 加日志/指标/告警 → observability-and-instrumentation

## 六大核心行为（非协商）

### 1. 显式陈述假设
```
ASSUMPTIONS I'M MAKING:
1. [关于需求的假设]
2. [关于架构的假设]
3. [关于范围的假设]
→ 现在纠正我，否则我按这些推进。
```
不静默填补模糊需求。

### 2. 主动管理困惑
遇到不一致/冲突/不清时：STOP → 命名困惑 → 呈现权衡或提问 → 等解决再继续。
- 坏：静默选一个解释并期望是对的
- 好："我在 spec 看到 X 但代码里是 Y，哪个优先？"

### 3. 必要时反推
不 sycophancy。方案有明显问题时：直接指出 → 量化下游影响（"+200ms 延迟"而非"可能更慢"）→ 提替代 → 接受人类在完整信息下的覆盖决定。

### 4. 强制简单
自然倾向是过度复杂化。完成前问：能否更少行？抽象挣得回复杂度吗？Staff engineer 会说"为什么不直接..."？1000 行能 100 行搞定就是失败。

### 5. 范围纪律
只动被要求处。不：移除不理解的注释、顺手清理无关代码、重构相邻系统、删看似未用的代码（无明确批准）、加 spec 外的"有用"功能。

### 6. 验证不假设
每技能有验证步。"看起来对"不够——须有证据（测试通过、构建输出、运行时数据）。

## 技能规则

1. 开工前查适用技能
2. 技能是工作流非建议——按序跟随，不跳验证
3. 多技能可叠加（功能实现可能串：idea-refine → spec → planning → incremental → TDD → review → simplification → git → docs）
4. 存疑时从 spec 开始

## 完整功能生命周期

interview-me → idea-refine → spec-driven-development → planning-and-task-breakdown → context-engineering → source-driven-development → incremental-implementation → observability-and-instrumentation（与 7-9 并行）→ test-driven-development → code-review-and-quality → code-simplification → git-workflow-and-versioning → documentation-and-adrs → deprecation-and-migration → shipping-and-launch

bug 修复可只用：debugging-and-error-recovery → test-driven-development → code-review-and-quality

## 失败模式

1. 未核假设就跑
2. 迷失仍硬冲
3. 不浮现不一致
4. 非显然决策不呈现权衡
5. 对明显有问题的方案 sycophancy
6. 过度复杂化代码与 API
7. 改任务外代码或注释
8. 删不完全理解的东西
9. 以"很明显"为由无 spec 就建
10. 以"看起来对"跳验证
