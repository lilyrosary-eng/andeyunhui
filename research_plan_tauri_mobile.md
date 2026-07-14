# 研究计划：将 tauri-best（Tauri v2 / React+Rust 桌面应用）移植到 Android 与 iOS

## 1. 任务拆解
用户想知道如何把这个 Tauri v2 桌面应用（React 前端 + Rust 后端、含插件系统、录屏服务、自定义等待页）做成 Android 和 iOS 应用。

需要回答的关键子问题：
- A. Tauri 2.0 移动端（iOS/Android）的总体架构与支持现状：用什么 WebView、如何 `tauri android init` / `tauri ios init`、项目结构差异、capabilities/permissions 权限系统、移动插件体系、已知限制。
- B. Android 与 iOS 各自的平台特定要求：Android（SDK/NDK、AndroidManifest 权限、keystore 签名、Play 商店、minSdk、WebView 约束）；iOS（必须 macOS+Xcode、Info.plist、provisioning、App Store/TestFlight、WKWebView 限制）。对比两者。
- C. 本项目自身的不可移植点（代码库分析）：recording_service.rs（Windows 专属录屏 API，移动端屏幕采集机制完全不同且受限）、WebView2 专属等待页 viewport bug（#15，仅桌面 WebView2）、external-deps 路径处理（`canonicalize()` Windows 路径）、NSIS 打包（仅 Windows）、IIFE 沙箱 + `window.__HOST_*` 注入（纯 Web 标准，移动 WebView 也可用）、Tauri fs/环境变量差异。
- D. 微信文章检索：补充中文社区实践经验、踩坑、Tauri 移动端最新动态（带时间参数）。

## 2. 查询类型
混合：偏深度优先（围绕"如何移植"单一主题，从框架机制/平台差异/项目适配/社区经验多个角度深入），同时含广度（Android vs iOS 两路并列）。

## 3. 子任务分配
- subagent-1（research_subagent，Web）：Tauri 2.0 移动端核心机制、capabilities/permissions、移动插件、官方文档（v2.tauri.app）、限制。
- subagent-2（research_subagent，Web）：Android 与 iOS 平台特定构建/签名/分发/WebView 限制对比，含官方移动插件清单与权限范围。
- subagent-3（code-explorer）：扫描本项目代码库，定位所有 Windows/WebView2 专属、桌面专属、需改造的代码点与文件，输出迁移缺口清单。
- 微信检索：用 wechat-article-search 技能，关键词"Tauri 移动端 Android iOS 适配"、"Tauri 2.0 手机"，时间近 2 年。

## 4. 预期输出
- 综合研究报告 `research_report_tauri_mobile.md`：执行摘要、Tauri 移动端机制、Android/iOS 分步指南、本项目迁移缺口与改造清单、关键约束（iOS 必须 Mac、录屏机制差异）、建议与局限、参考链接。

## 5. 信息真实性
- 优先 Tauri 官方文档 v2.tauri.app、GitHub releases；
- 平台要求以 Android 开发者文档 / Apple 开发者文档为准；
- 微信文章仅作社区经验补充，需与官方交叉验证；
- 数值/版本/命令需具体。
