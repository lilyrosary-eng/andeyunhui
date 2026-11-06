---
name: spec-driven-development
description: 写代码前先写 spec。新项目/功能、需求模糊或不完整、跨多文件/模块、即将做架构决策、预计实现超 30 分钟时使用。
---

# 规范驱动开发（Spec-Driven Development）

## 概述

四阶段门控工作流：SPECIFY → PLAN → TASKS → IMPLEMENT，每阶段需人工 review 才推进。spec 是活文档。

## 何时使用

- 新项目/功能、需求模糊或不完整
- 跨多文件/模块、即将做架构决策
- 预计实现 > 30 分钟

**何时不用**：单行修复、错别字、需求清晰自包含的小改动。

## 四阶段门控

### 1. Specify（规范）
- 先列 ASSUMPTIONS 让用户纠错
- 覆盖六大核心区：Objective、Commands（完整带 flag）、Project Structure、Code Style（一段真实代码）、Testing Strategy、Boundaries（Always/Ask first/Never）
- 把模糊指令重写为可测的成功标准（"更快"→ LCP<2.5s）

### 2. Plan（计划）
- 产出技术实现计划：组件依赖、顺序、风险、并行 vs 串行、验证检查点
- 保存到 `tasks/plan.md`

### 3. Tasks（任务）
- 拆为单会话可完成、有验收标准与验证步骤
- 依依赖排序；单任务 ≤ ~5 文件
- 保存到 `tasks/todo.md`

### 4. Implement（实现）
- 调用 incremental-implementation + test-driven-development + context-engineering

## 保持 spec 活着

- 决策/范围变化时先更新 spec
- 提交进版本控制；PR 中引用 spec

## 红旗

- 无书面需求就写代码
- 未澄清"done"就问"要不要开搞"
- 实现 spec/task 之外的功能
- 做架构决策无文档
- 以"很明显"为由跳过 spec

## 验证

- [ ] spec 覆盖六核心区
- [ ] 人工已 review 批准
- [ ] 成功标准具体可测
- [ ] Boundaries 已定义
- [ ] spec 已存入仓库文件
