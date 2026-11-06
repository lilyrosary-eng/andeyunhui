---
name: documentation-and-adrs
description: 记录决策与文档。做架构决策、改公共 API、发布改变用户行为的功能、onboarding 新人/agent、发现自己反复解释同一件事时使用。
---

# 文档与架构决策记录（Documentation & ADRs）

## 概述

文档记"why"而非"what"：code 显示做了什么，文档解释为什么这么做、考虑过哪些替代。

## 何时使用

- 重要架构决策、在竞争方案间选择
- 增改公共 API
- 发布改变用户行为的功能
- onboarding 新人/agent
- 发现自己反复解释同一件事

**何时不用**：不为显而易见的代码写文档；不复述代码的注释；不为一次性原型写文档。

## ADR（架构决策记录）

### 何时写 ADR
- 选框架/库、设计数据模型、选 auth 策略、选 API 架构、选构建工具/托管、难以逆转的决策

### 写前先匹配仓库约定
- 位置/格式/编号/命名/标题集；冲突时上呈而非私自引入新方案
- 无约定才用默认：`docs/decisions/` 顺序编号

### ADR 模板
- **Status**：PROPOSED → ACCEPTED →（SUPERSEDED 或 DEPRECATED）
- **Date**
- **Context**：为什么需要决策
- **Decision**：做了什么决策
- **Alternatives Considered**：含 Pros/Cons/Rejected
- **Consequences**：正负后果

- 不删旧 ADR，新决策写新 ADR 引用并取代

## 内联文档

- 注释写 why 不写 what
- 不复述代码、不留 TODO、不留注释掉的代码
- 记录已知 gotcha 并引用 ADR

## API 文档与 README

- TS 用内联类型 + JSDoc；REST 用 OpenAPI/Swagger
- README 含 Quick Start / Commands / Architecture / Contributing
- changelog 按 Added/Changed/Fixed 分组

## 红旗

- 架构决策无书面理由
- 公共 API 无文档或类型
- README 不说明如何运行
- 注释掉的代码代替删除
- TODO 挂数周
- 有重大架构选择却无 ADR
- 文档复述代码而非解释意图

## 验证

- [ ] 所有重大架构决策有 ADR
- [ ] README 含 quick start/commands/architecture
- [ ] API 函数有参数与返回类型文档
- [ ] 已知 gotcha 已内联
- [ ] 无注释掉的代码残留
