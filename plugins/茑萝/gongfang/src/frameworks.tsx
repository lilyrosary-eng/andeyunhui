/// <reference path="../../../global.d.ts" />
// 攻防模块 · 五大框架面板（2026-10-18 由单文件 4632 行拆分）
// 共享类型与通用组件在 ./frameworksShared.tsx；每个框架面板一个文件。
// GongfangModule.tsx 只需要从这里取五个 Panel， import 路径不变。
export { CrawlerPanel } from './frameworks.crawler';
export { ReversePanel } from './frameworks.reverse';
export { PentestPanel } from './frameworks.pentest';
export { AutomationPanel } from './frameworks.automation';
export { GatewayPanel } from './frameworks.gateway';
export * from './frameworksShared';
