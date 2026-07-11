/**
 * 插件性能监控
 *
 * 追踪每个插件的加载耗时、执行性能，帮助识别慢插件。
 * 仅在开发环境启用详细日志，生产环境仅保留指标收集。
 */

import { logger } from '@/lib/logger';

interface MetricEntry {
  pluginId: string;
  operation: string;
  duration: number;
  timestamp: number;
}

class PluginPerformanceMonitor {
  private metrics: MetricEntry[] = [];
  private readonly maxEntries = 200;

  /** 开始计时 */
  startMeasure(pluginId: string, operation: string): void {
    const key = `${pluginId}:${operation}`;
    performance.mark(`${key}-start`);
  }

  /** 结束计时并记录 */
  endMeasure(pluginId: string, operation: string): number {
    const key = `${pluginId}:${operation}`;
    const startMark = `${key}-start`;
    const endMark = `${key}-end`;

    try {
      performance.mark(endMark);
      const measure = performance.measure(key, startMark, endMark);
      const duration = measure.duration;

      this.metrics.push({
        pluginId,
        operation,
        duration,
        timestamp: Date.now(),
      });

      // 限制记录数量
      if (this.metrics.length > this.maxEntries) {
        this.metrics = this.metrics.slice(-this.maxEntries);
      }

      // 耗时超过 1 秒时告警
      if (duration > 1000) {
        logger.plugins.perfWarn(pluginId, operation, duration);
      }

      // 清理 marks
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
      performance.clearMeasures(key);

      return duration;
    } catch {
      // performance API 不可用时的回退
      return 0;
    }
  }

  /** 获取某个插件的所有指标 */
  getMetrics(pluginId: string): MetricEntry[] {
    return this.metrics.filter((m) => m.pluginId === pluginId);
  }

  /** 获取插件的平均耗时 */
  getAverage(pluginId: string, operation: string): number {
    const entries = this.metrics.filter(
      (m) => m.pluginId === pluginId && m.operation === operation,
    );
    if (entries.length === 0) return 0;
    const total = entries.reduce((sum, e) => sum + e.duration, 0);
    return total / entries.length;
  }

  /** 获取汇总报告 */
  getReport(): Record<string, { avg: number; min: number; max: number; count: number }> {
    const groups: Record<string, number[]> = {};
    for (const m of this.metrics) {
      const key = `${m.pluginId}:${m.operation}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(m.duration);
    }

    const report: Record<string, { avg: number; min: number; max: number; count: number }> = {};
    for (const [key, durations] of Object.entries(groups)) {
      report[key] = {
        avg: durations.reduce((a, b) => a + b, 0) / durations.length,
        min: Math.min(...durations),
        max: Math.max(...durations),
        count: durations.length,
      };
    }
    return report;
  }

  /** 清空所有指标 */
  clear(): void {
    this.metrics = [];
  }
}

export const pluginPerformanceMonitor = new PluginPerformanceMonitor();