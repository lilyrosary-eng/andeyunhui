---
name: observability-and-instrumentation
description: 插桩代码使生产行为可见可诊断。加日志/指标/追踪/告警、发布生产功能需证据、生产事故诊断过慢时使用。
---

# 可观测性与插桩（Observability & Instrumentation）

## 概述

Telemetry 没有问题就是噪声。先定义 on-call 会问的 2-4 个问题，每信号映射一条。

## 何时使用

- 构建将运行于生产的功能
- 加新服务/端点/后台 job/外部集成
- 生产事故诊断过慢
- 设/审告警规则
- review 含 I/O/重试/队列/跨服务调用的 PR

**何时不用**：正在发生的故障诊断（用 debugging-and-error-recovery）；性能分析（用 performance-optimization）；发布日监控清单（用 shipping-and-launch）。

## 流程

### 1. 定义"working"
- 写下 2-4 个 on-call 会问的问题；每信号必须帮助回答一个

### 2. 选信号
- **Structured log**："这个具体案例发生了什么？"
- **Metric**："聚合层面多常/多快？"
- **Trace**："跨服务时间花在哪？"
- 口诀：metrics 告诉 **that**、trace 告诉 **where**、log 告诉 **why**

### 3. 结构化日志
- JSON 稳定事件名 + 机器可读字段
- 级别：error/warn/info/debug 一致使用
- **Correlation ID 强制**——每日志行、span、出站调用都带
- **永不日志秘密/PII**

### 4. Metrics
- 请求驱动服务用 **RED**：Rate/Errors/Duration
- 资源用 **USE**：Utilization/Saturation/Errors
- 用直方图读 p50/p95/p99，**绝不用平均值**
- 标签只能来自小固定集（绝不放 user ID/原始 URL/错误文本）

### 5. 分布式追踪
- 用 OpenTelemetry 自动 instrumentation + 必要时手动 span
- 跨异步边界传播 context

### 6. 告警
- 基于**症状**（用户感知的）而非原因
- 每告警须：可操作、链 runbook、有 SLO/历史数据支撑的阈值与持续时间
- 只用 page/ticket 两级

### 7. 验证 telemetry 本身
- staging 强制错误 → 按 requestId 找 → 确认字段结构化
- metric 出现、追踪无断 span、告警 test-fire 到正确通道

## 红旗

- 含重试/队列/外部调用的功能 PR 零新 telemetry
- 字符串拼接日志
- 无 correlation ID
- metric 用 user ID/URL/错误文本作标签
- 延迟用平均值无百分位
- 每日告警被无脑 ack
- 基于原因告警 paging 而用户面错误率无人监控
- 日志含秘密/token/完整请求体
- "我机器上能跑"作为生产健康唯一证据

## 验证

- [ ] on-call 问题已写下且每信号映射一条
- [ ] 所有日志结构化含稳定事件名与 correlation ID
- [ ] 无秘密/PII（抽查实际输出）
- [ ] 每个新端点与外部依赖有 RED 指标且标签有界
- [ ] 延迟为直方图可查 p95/p99
- [ ] 单请求可端到端追踪无断 span
- [ ] 每新告警基于症状+有 runbook 链接+曾 test-fire
- [ ] staging 诱发故障可仅凭 telemetry 定位而无需读源
