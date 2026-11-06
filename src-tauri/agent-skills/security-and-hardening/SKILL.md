---
name: security-and-hardening
description: 加固代码防漏洞。处理用户输入、认证授权、敏感数据存取、外部 API/服务集成、文件上传、webhook、支付或 PII 数据时使用。
---

# 安全与加固（Security & Hardening）

## 概述

威胁建模先行：映射信任边界、命名资产、用 STRIDE 过一遍、写"滥用用例"作为首个测试。聚焦可利用的实际漏洞，而非理论风险。

## 何时使用

- 处理用户输入、认证授权、敏感数据存取、外部 API/服务集成
- 文件上传、webhook、回调、支付或 PII 数据

## 三层边界系统

| 层级 | 含义 | 示例 |
|---|---|---|
| **Always Do** | 无条件做 | 验证输入、参数化查询、HTTPS、bcrypt 哈希、最小权限 |
| **Ask First** | 需评审 | 新认证流、新敏感数据存储、改 CORS、新依赖 |
| **Never Do** | 禁止 | 提交秘密、日志敏感数据、信任客户端校验、eval/innerHTML |

## OWASP Top 10 防护要点

- **注入**：参数化查询，永不字符串拼接 SQL/命令
- **破认证**：强密码哈希（bcrypt/scrypt/argon2）、会话超时、MFA
- **XSS**：输出编码、CSP、HttpOnly cookie
- **破访问控制**：每个受保护端点都查授权、防 IDOR
- **敏感数据泄漏**：传输加密（HTTPS）+ 静态加密、敏感字段排除出 API 响应与日志
- **SSRF**：服务端 fetch 用户 URL 须 allowlist（注意 TOCTOU，用 request-filtering-agent）
- **安全配置错误**：安全头（CSP/HSTS/X-Frame-Options）、CORS 限制特定源、错误信息不泄漏堆栈

## 依赖审计

- 按可达性与修复风险分诊，非盲目升级全部
- 供应链卫生：找安装边界与 manager、阻塞依赖 postinstall 脚本、验签、review 新依赖

## AI/LLM 特性（如存在）

- 模型输出按不可信输入处理（绝不进 eval/SQL/shell/innerHTML/文件路径）
- 不依赖系统提示词作安全边界（提示注入）
- 上下文窗口不含密钥/跨租户数据/完整系统提示词
- 工具权限有范围 + 破坏性操作需确认
- 有 token/速率/递归限制

## 秘密管理

- .env.example 提交、.env 不提交。秘密已提交即旋转。

## 红旗

- 用户输入直接进 SQL/shell/HTML
- 源码或历史含秘密
- 端点缺认证授权
- CORS 用 `*`
- auth 端点无速率限制
- 堆栈跟踪外泄
- LLM 输出直进 query/DOM/shell

## 验证

- [ ] 原生 audit 无未修复可达 critical/high
- [ ] 无秘密；输入在边界验证
- [ ] 每个受保护端点都做认证+授权
- [ ] 安全头存在；错误响应不泄密
- [ ] auth 端点限速；URL fetch 经 allowlist
- [ ] LLM 输出经验证编码
