---
name: git-workflow-and-versioning
description: 结构化 Git 工作流。提交、分支、合并、冲突解决、并行多流工作时使用；切割发布、选语义版本号、打 tag、写 changelog 时使用。
---

# Git 工作流与版本控制

## 概述

Git 是安全网。把提交当存点、分支当沙箱、历史当文档。AI 高速生成代码时，纪律化的版本控制是让变更可管理、可审查、可回滚的关键。

## 何时使用

始终。每次代码变更都流经 git。

## 核心原则

### 主干开发（推荐）
- `main` 永远可部署。特性分支 1-3 天内合并回主干。长生命周期分支是隐藏成本——会偏离、产冲突、延迟集成。
- 用 gitflow 的团队可适配原则（原子提交、小变更、描述性信息），提交纪律比具体分支策略更重要。

### 尽早提交、频繁提交
- 每个成功增量即一个存点。测试通过 → 提交 → 下一片。失败即 revert，不在坏状态上叠加。

### 原子化提交
- 一个提交只做一件事。用 Conventional Commits：feat / fix / refactor / test / docs / chore。
- 信息解释 why 而非 what。重构与功能分提交；格式化与行为变更分提交。
- 变更尺寸目标 ~100 行；超 1000 行应拆分。

### Worktrees 并行
- 用 `git worktree` 实现多 agent/多任务并行，避免分支切换开销。

## 发版与版本控制

- 语义化版本（SemVer）：major(破坏) / minor(兼容新功能) / patch(兼容修复)。
- 从 tag 派生版本号。changelog 按影响分组（Added/Changed/Fixed/Deprecated/Removed/Security），不直接倒 commit log。
- 破坏性变更不伪装成 minor/patch。

## 红旗

- 大量未提交变更累积
- "fix"/"update" 类无信息提交
- 格式与行为混改
- 提交 node_modules / .env / 无 .gitignore
- 长寿分支显著偏离 main
- 强推共享分支
- 发版无 tag；changelog 直接 dump commit

## 验证

- [ ] 每次提交原子性：只做一件事
- [ ] 信息含 why；测试通过；无秘密
- [ ] 无纯格式混入；.gitignore 完备
- [ ] 发版：版本号匹配变更性质；tag 与版本一致
- [ ] changelog 按影响分组的可读条目
