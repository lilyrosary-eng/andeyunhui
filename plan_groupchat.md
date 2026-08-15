# 多 AI 群聊重构计划（andeyunhui · ai-chat 模块）

> 决策来源（用户 2026-08-15）：
> 1. 开新对话按钮拆成「新对话」+「新群聊」两个入口。
> 2. 点「新群聊」弹出伴侣选择，必须选 ≥2 个伴侣卡。
> 3. 「严重度」对用户不可见：它的唯一用途是**成本/烧钱提示**，不是争论/调侃戏码。
>    → 数据层 `severity` 字段保留但语义改为成本计量（0=省/3=贵），UI 绝不暴露 severity 数字或"调侃/争论"字样，保持沉浸感。
> 4. 群聊**不对胶囊开放**，只在主窗口 `ai-chat` 模块（AiChatConversation + AiChatSidebar）。
> 5. 发言调度做**智能版**：用户发一句 → 主导 AI（router）决定本轮谁接话/谁插嘴，非固定轮询。
> 6. 分阶段实现，不一次性完成。

## 数据层现状（已就位，需微调语义）
- `capsule/types.ts`：`ChatMsg.speakerId`（群聊发言者 companion.id）、`ChatMsg.severity`（语义需改为成本计量）。
- `Conversation.mode: 'single'|'group'`、`participants: string[]`、`groupName?`、`groupLively?`（改名/改语义为 `costHint?` 更贴切，但为减少侵入先保留字段、改用途说明）。
- 记忆层 B/C：`buildPersonaContext` / `buildCoreContext` / `retrievePersona()` 已就绪，群聊每伴侣各带自身 persona。

## 阶段划分

### 阶段 0：数据层语义校正（小）
- `types.ts` 注释更新：severity 改为"成本计量 0-3，仅内部用于烧钱提示，不对用户暴露"；`groupLively` 改为 `costAware` 语义或保留但注明不暴露。
- 新增 `GroupCost` 轻量结构（累计调用次数 / 估算 token 或调用数），挂在 Conversation 上 `groupCost?: { calls: number }`，仅用于"本次群聊已调用 N 次 AI"提示。

### 阶段 1：入口拆分 + 群聊创建弹窗（UI）
- AiChatSidebar：原「新对话」按钮旁加「新群聊」按钮。
- 新建 `GroupCreateDialog`（伴侣多选卡，勾选 ≥2 才能确认；不足则禁用确认按钮）。
- 确认后 `newGroupConversation(participantIds, groupName)` 创建 `mode:'group'` 会话并置顶激活。
- 侧栏会话项区分单聊/群聊（小图标或标题前缀，不暴露 severity）。

### 阶段 2：useAiChat 群聊发送内核（逻辑，单聊不动）
- 抽 `sendOne(opts)`：`{ convId, text, personaPrompt, systemPrompt, speakerId?, model? }`，复用现有 `ai_chat` + `useAiStream` 接线。支持 per-call persona/system/model/speakerId。
- `send`（单聊）保持原行为不变。
- 新增 `groupSend(text)`：智能路由。
  - 步骤 A：用主导 AI（第一个 participant，或固定 router）调用一次"路由"——把群成员人设摘要 + 用户消息 + 最近几轮上下文发给 router，让其返回本轮发言序列（哪些 speakerId 按顺序说话，是否有人插嘴）。
  - 步骤 B：按路由结果串行调用 `sendOne` 每个发言者，逐个上屏。
  - 每完成一次 `sendOne`，`groupCost.calls++`，并估算成本。
  - 全程 `busy` 保护，可中断（取消本轮剩余发言）。
- 路由结果解析：定义简洁协议（如 JSON `{ turns: [{speakerId, note?}] }`），解析失败则退化轮询全部 participant 各说一句（保底）。
- 成本提示：群聊会话顶部或输入框上方显示"本次群聊已调用 N 次 AI"（轻量、不破坏沉浸），不显示 severity 字样。

### 阶段 2 完成记录（2026-08-15）
- Rust `ai_chat` 命令新增可选 `system: Option<String>` 参数：前端 per-call 注入人设时使用，合并到全局 persona 之前。同时修复了单聊 persona 此前被忽略的隐藏 bug（前端 `send` 一直传 `system` 但 Rust 无该形参）。
- `useAiChat.ts`：新增 `sendOne(speakerId, history)`（注入该伴侣 `buildPersonaContext` 人设、复用全局 `{prefix:'ai'}` 流式落盘，并以一次性 `listen(ai-done/ai-error)` 等待本轮完成供串行调度）+ `groupSend(text)`（用户一句→串行让每位 participant 基于累积历史各回应一句→累加 `groupCost.calls`）。
- `send` 入口按 `activeConv.mode==='group'`（且 participants≥2）自动分流到 `groupSend`，AiChatConversation 与所有调用方零改动。
- 群聊信息条（参与者头像组 + "本次已调用 N 次 AI"）已与 `groupCost.calls` 对齐。
- 校验：tsc --noEmit 通过、cargo check 通过（仅无关 dead_code 警告）。

### 阶段 3：per-companion 模型下拉（模块设置）
- companionStore 伴侣数据加 `model?` 字段（可选，空则回落 profile 默认）。
- AiChatMemorySettings / 模块设置里每个伴侣一个模型下拉框（复用 ai_get_profiles 列表）。
- `sendOne` 把 `model` 透传给 `ai_chat` payload（需确认 Rust `ai_chat` 是否支持 per-call model；若不支持则需扩展命令）。

### 阶段 3 完成记录（2026-08-15）
- 方案调整：伴侣已自带 `profile_id` 字段（绑定 AiProfile = endpoint+key+model 整体），Rust `ai_chat` 命令已原生支持 per-call `profile_id`（None 回落默认）。因此 per-companion 模型 = 伴侣绑定 profile，无需新增独立 model 字段，也无需改 Rust。
- `useAiChat.ts`：群聊 `sendOne` 的 `profileId` 由 `profileIdRef.current`（全局）改为 `companion.profile_id || profileIdRef.current`（每位伴侣按其绑定档案选模型；未绑定回落默认）。
- `AiChatMemorySettings.tsx`：新增「AI 聊天模型」Section，下拉项 = `ai_get_profiles()` 返回的 profiles（name + model），选中值绑定 `companion.profile_id`，通过 `companionStore.update()` 持久化保存。

### 群聊「活人感」增强（router 编排，2026-08-15）
- 目标：群聊不再机械轮流，而是有真实朋友群的活人感——有人接梗、有人旁观沉默、有人抢话补刀、顺序不固定、话题自然流动。
- 新增 `askOnce(system, userText)`：一次性纯文本问答（不落盘会话），复用 `invoke('ai_chat')` + 一次性 `listen` 累积 `ai-delta`/`ai-done`，返回完整文本。用作编排者决策。
- 新增 `planGroupRound(participants, userText, recentSummary)`：编排者 system（中文）读成员名单（id+名字+简介）+ 用户消息 + 最近上下文，要求输出严格 JSON `{order:[id...], intros:{id:台词引导}}`，明确「不必全员发言、顺序不固定、可接梗/补刀/旁观」。解析失败返回 null（回落固定顺序）。
- 改写 `groupSend`：用户一句 → `planGroupRound` 先决策（计 1 次 AI）→ 按 `order`（过滤非法 id）串行 `sendOne(speakerId, history, intro)`，`intro` 追加到该伴侣人设 system 之后作为内部语境引导（绝不暴露给用户）。
- `sendOne` 新增 `intro?` 参数，拼入 `system`（persona + 内部引导）。
- 安全性：router 调用不设置全局 `reqRef/asstRef`，`useAiStream` 的 `ai-delta` 守卫（`requestId !== reqRef.current || !asstRef.current`）会拦截 router 的 delta，不会误写入会话。
- 成本：每轮群聊 = 1（编排者）+ N（实际发言者）次 AI 调用，`groupCost.calls` 如实累加（仍不向用户暴露 severity/cost 数字，仅信息条「本次已调用 N 次 AI」）。
- 校验：tsc --noEmit 通过、useAiChat lint 0 error。
- 校验：tsc --noEmit 通过、AiChatMemorySettings lint 0 error。
- 注意：单聊（非群聊）会话仍走全局默认 profile（`send` 入口未用参与者 profile_id）；胶囊当前伴侣单聊亦走默认。如需单聊也尊重伴侣 profile，后续可扩展 `send` 按 activeConv.participants 取首个伴侣的 profile_id。

### 阶段 4：智能路由增强（可选，二期）
- router 支持"插嘴/打断"——当某发言者返回内容触发高冲突时，router 追加一轮。
- 成本阈值保护：达到某 calls 数提示用户。

## 不变式 / 红线
- 单聊路径零回归：`send` 行为不变，胶囊完全不动。
- severity 永不在 UI 出现数字或"调侃/争论"文案，仅内部成本计量。
- 群聊数据不暴露给用户（选伴侣卡是唯一用户交互）。
- 跨 webview 同步（SYNC_EVENT）继续保持，群聊会话也同步。

## 验收
- 「新对话」「新群聊」两个入口均可用。
- 群聊必须 ≥2 伴侣，否则无法创建。
- 群聊中每个伴侣用自己的 persona 说话，发言顺序由智能路由决定（非机械轮询）。
- 用户可见"本次群聊已调用 N 次 AI"成本提示，看不到 severity/争论等字样。
- 单聊与胶囊功能不受影响。
