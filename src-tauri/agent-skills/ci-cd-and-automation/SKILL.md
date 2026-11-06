---
name: ci-cd-and-automation
description: 自动化 CI/CD 流水线。新项目 CI、增改自动化检查、配置部署流水线、调试 CI 失败时使用。
---

# CI/CD 与自动化（CI/CD & Automation）

## 概述

Shift Left（尽早捕获问题）；Faster is Safer（小批量频发版降风险）。任何质量门不可跳过——lint 失败修 lint 而非禁规则。

## 何时使用

- 新项目 CI
- 增改自动化检查
- 配置部署流水线
- 变更应触发自动验证
- 调试 CI 失败

## 质量门流水线

Lint → Type Check → Unit Tests → Build → Integration → E2E（可选）→ Security Audit → Bundle Size

- 任何门不可跳过
- CI 测试库凭据用 GitHub Secrets

## 把 CI 失败反馈给 agent

- 贴具体错误 → agent 修 → push → CI 再跑（闭环）

## 部署策略

- **PR preview 部署**
- **Feature Flag**：解耦部署与发布（含生命周期与清理日期）
- **Staged rollout**：staging → prod → 15 分钟监控 → rollback 或 done
- **必须有 rollback 机制**

## 环境管理

- .env.example 提交、.env 不提交
- .env.test 提交（无真实秘密）
- CI 与生产秘密分离存 vault

## CI 之外

- Dependabot/Renovate 自动更新依赖
- Build Cop 角色（保持 CI 绿）
- PR 检查：必 review、必状态检查、分支保护、auto-merge

## CI 优化（>10 分钟时按影响序）

1. 缓存依赖
2. 并行 job
3. path filter 只跑变更相关
4. matrix 分片
5. 优化测试套件
6. 用更大 runner

## 红旗

- 无 CI
- CI 失败被忽略或静默
- 为让流水线过而禁测试
- 生产部署不经 staging 验证
- 无 rollback 机制
- 秘密存代码或 CI 配置
- CI 长无优化

## 验证

- [ ] 所有质量门存在
- [ ] PR 与 push 到 main 都跑
- [ ] 失败阻止合并（分支保护）
- [ ] CI 结果回流开发环
- [ ] 秘密存 secrets manager
- [ ] 部署有 rollback
- [ ] 流水线测试套件 < 10 分钟
