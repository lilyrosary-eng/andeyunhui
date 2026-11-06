---
name: performance-optimization
description: 优化应用性能（前端/后端/查询/数据库）。spec 有性能预算、怀疑回归、CWV 低于阈值、N+1 修复、profiling 瓶颈时使用。
---

# 性能优化（Performance Optimization）

## 概述

工作流：MEASURE → IDENTIFY → FIX → VERIFY → GUARD。先测后优。没有证据就别优化——过早优化只增加复杂度。

## 何时使用

- spec 中存在性能预算/SLA
- 用户或监控报告变慢
- Core Web Vitals 低于阈值
- 怀疑回归；大数据量/高流量功能

**何时不用**：没有证据就别优化。

## 测量

- **双轨**：合成（Lighthouse/DevTools）+ RUM（web-vitals/CrUX）
- 按"哪里慢"决定测量起点：首屏 / 交互 / 导航后 / 后端 API
- 相同命令相同条件再测；一次只改一项；超过噪声才算赢；neutral 即 revert

## CWV 目标

| 指标 | 目标 |
|---|---|
| LCP | ≤ 2.5s |
| INP | ≤ 200ms |
| CLS | ≤ 0.1 |

## 常见反模式修复

- **N+1**：用 include/join 预加载关联
- **无分页**：列表端点必须分页
- **图片未优化**：picture + srcset + fetchpriority + 现代格式（WebP/AVIF）
- **React 重渲染**：memo/useMemo/稳定引用（但勿滥用——成本无收益）
- **大包**：lazy + Suspense 路由级拆分
- **缺缓存**：HTTP 缓存（max-age + 内容哈希）、应用层缓存

## 性能预算

- JS 包 < 200KB gzip、CSS < 50KB、API p95 < 200ms
- CI 用 bundlesize/lhci 强制

## 红旗

- 无 profiling 数据就优化
- N+1；列表端点无分页
- 图片无尺寸/lazy/响应式
- 生产无监控
- memo/useMemo 滥用
- 未复测就保留；多项优化混测无法归因
- "赢"靠改测试

## 验证

- [ ] 前后测量数据存在；复测方式一致
- [ ] 改进超噪声；未达标变更已 revert
- [ ] 尝试有日志（含被 revert 的）
- [ ] CWV 达 Good；包体未显著增长
- [ ] 无新 N+1；CI 预算通过；测试仍绿
