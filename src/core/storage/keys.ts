/**
 * 全量 localStorage key 索引：唯一事实源。kind = flag(写 '1'/'0' 或 'true'/'false') / string / json。
 * scope = desktop / mobile / shared / dev。
 * 已封装模块内部 key 常量按「文档登记」方式收录在本表（分组见 doc），模块内部实现一律不动。
 */
export const KEYS = {
  app: {
    dataRootGuided:    { key: 'dataRootGuided', kind: 'flag', scope: 'desktop', default: '0', note: '首次数据根引导' },
  },
  transfer: {
    onboarded:         { key: 'andeyunhui.transfer.onboarded', kind: 'flag', scope: 'desktop', default: '0' },
    mobileShare:       { key: 'andeyunhui.mobile.share', kind: 'json', scope: 'mobile', note: '移动端分享中转载荷' },
    saveDirInvalid:    { key: 'transfer:save-dir-invalid', kind: 'string', scope: 'desktop' }, // 事件名也如此，见 EVENTS 分组
  },
  niaoluo: {
    // 默认 '1'（显示）：RAG 为默认开启的茑萝子模块；用户在「全局设置 → 茑萝」关掉后写 '0'，重启仍保持关闭
    ragVisible:        { key: 'niaoluo:rag-visible', kind: 'flag', scope: 'shared', default: '1' },
    capsuleTab:        { key: 'niaoluo:capsule-tab', kind: 'string', scope: 'shared', default: 'search' },
  },
  aiPolish: {
    style:             { key: 'ai_polish_style', kind: 'string', scope: 'shared', default: 'keep' },
    length:            { key: 'ai_polish_length', kind: 'string', scope: 'shared', default: 'keep' },
  },
  theme: {
    theme:             { key: 'theme', kind: 'string', scope: 'shared', default: 'system' },
    themeColor:        { key: 'themeColor', kind: 'string', scope: 'shared', default: '默认' },
    elementColor:      { key: 'elementColor', kind: 'string', scope: 'shared', default: '默认' },
    reverseColor:      { key: 'reverseColor', kind: 'flag', scope: 'shared', default: 'false' },
    zoom:              { key: 'zoom', kind: 'string', scope: 'shared', default: '100' },
    panelOpacity:      { key: 'panelOpacity', kind: 'string', scope: 'shared', default: '80' },
    fontFamily:        { key: 'fontFamily', kind: 'string', scope: 'shared', default: '系统默认' },
    appBgImage:        { key: 'appBgImage', kind: 'string', scope: 'shared' },
    appBgBlur:         { key: 'appBgBlur', kind: 'string', scope: 'shared', default: '0' },
    appBgAngle:        { key: 'appBgAngle', kind: 'string', scope: 'shared', default: '0' },
    appBgFlip:         { key: 'appBgFlip', kind: 'flag', scope: 'shared', default: 'false' },
    appBgScrub:        { key: 'appBgScrub', kind: 'flag', scope: 'shared', default: 'false' },
    appBgVideoPersist: { key: 'appBgVideoPersist', kind: 'flag', scope: 'shared', default: 'false' },
    appBgVideoPath:    { key: 'appBgVideoPath', kind: 'string', scope: 'shared', note: '桌面设置/全局面板读写' },
  },
  desktop: {
    shortcuts:         { key: 'shortcuts', kind: 'json', scope: 'desktop', note: '即 GlobalSettingsPanel「快捷键」' },
    devConsoleHistory: { key: 'dev_console_history', kind: 'json', scope: 'desktop', note: 'slice(-50)' },
    lyricsFontSize:    { key: 'music_lyrics_font_size', kind: 'string', scope: 'desktop' },
    lyricsShowNext:    { key: 'music_lyrics_show_next_line', kind: 'flag', scope: 'desktop' },
    chroma:            { key: 'deskpet:chroma', kind: 'json', scope: 'desktop', note: '{color,tolerance}' },
    chromaDisabled:    { key: 'deskpet:chroma-disable', kind: 'flag', scope: 'desktop', default: 'false' },
    deskpetSettings:   { key: 'deskpet:settings', kind: 'json', scope: 'desktop', note: 'DeskpetSettingsPanel.tsx 读写（本批改造）' },
    aiChatMemory:      { key: 'andeyunhui.aichat.memory.enabled', kind: 'flag', scope: 'desktop', default: 'true', note: 'useAiChat 永久记忆开关（本批改造）' },
    userAvatar:        { key: 'andeyunhui.aichat.user.avatar', kind: 'string', scope: 'desktop', default: '你', note: 'core/avatar/userAvatar 读写（本批改造）' },
  },
  i18n: {
    language:          { key: 'language', kind: 'string', scope: 'shared', default: 'zh-CN', note: 'i18n 语言选择' },
  },
  ai: {
    providerExpanded:  { key: 'ai.providerExpanded', kind: 'json', scope: 'desktop', note: '供应商折叠面板展开状态（记忆用户展开过哪些卡片）' },
    comfyuiUrl:        { key: 'ai.comfyuiUrl', kind: 'string', scope: 'desktop', default: 'http://127.0.0.1:8188', note: 'ComfyUI 本地生图端点' },
    comfyuiCkpt:       { key: 'ai.comfyuiCkpt', kind: 'string', scope: 'desktop', default: '', note: 'ComfyUI checkpoint 模型文件名（models/checkpoints 下）' },
    comfyuiNegative:   { key: 'ai.comfyuiNegative', kind: 'string', scope: 'desktop', default: '', note: 'ComfyUI 内置流程的负向提示词（空＝用后端内置质量词）' },
    comfyuiWorkflowsDir: { key: 'ai.comfyuiWorkflowsDir', kind: 'string', scope: 'desktop', default: '', note: 'ComfyUI 工作流目录（user/default/workflows 或 userdata/workflows）' },
    comfyuiBlueprintWf: { key: 'ai.comfyuiBlueprintWf', kind: 'string', scope: 'desktop', default: '', note: '蓝图生图节点使用的 ComfyUI 工作流文件路径（空=用内置最小流/云端）' },
    comfyuiBlueprintWfSlug: { key: 'ai.comfyuiBlueprintWfSlug', kind: 'string', scope: 'desktop', default: '', note: '蓝图工作流的技能包 slug（备注键，随 comfyuiBlueprintWf 一起设置）' },
    // 已放行的自定义节点模块名（JSON 数组）。自定义节点可执行任意 Python，
    // AI 自建工作流时安全审计会拦下未放行的模块；放行只能来自用户在这里的勾选。
    comfyuiAllowedModules: { key: 'ai.comfyuiAllowedModules', kind: 'string', scope: 'desktop', default: '[]', note: '已放行可用于 AI 自建工作流的自定义节点模块名（JSON 数组）' },
  },
  mobile: {
    preview:           { key: 'mobile-preview', kind: 'flag', scope: 'mobile', default: '0', note: 'main.tsx 预览开关' },
    proactiveOn:       { key: 'andeyunhui.mobile.proactive.enabled', kind: 'flag', scope: 'mobile', default: '0', note: '见 useProactiveMessage PROACTIVE_KEY' },
    proactiveInterval: { key: 'andeyunhui.mobile.proactive.intervalMin', kind: 'string', scope: 'mobile', default: '60', note: '见 useProactiveMessage INTERVAL_KEY' },
    agentEnabled:      { key: 'andeyunhui.mobile.agent.enabled', kind: 'flag', scope: 'mobile', default: '0' },
    agentSilent:       { key: 'andeyunhui.mobile.agent.silent', kind: 'flag', scope: 'mobile', default: '0' },
  },
  companion: {
    cache:             { key: 'andeyunhui.mobile.companion.cache', kind: 'json', scope: 'shared', note: 'core/stores/companionStore 浏览器预览兜底缓存' },
    ragEmbed:          { key: 'andeyunhui.mobile.rag.embed', kind: 'json', scope: 'shared', note: 'core/stores/semanticMemory 嵌入端点配置' },
  },
  devtools: {
    logLevel:          { key: 'log_level', kind: 'string', scope: 'dev', note: '生产排障口头开关' },
  },
  doc: {
    // —— 已封装模块内部 key 的文档登记（内部实现不动）——
    mobileChat:        { key: 'andeyunhui.mobile.conversations', kind: 'json', scope: 'mobile', note: 'mobile/stores/chatStore.ts CHAT_KEY，已封装模块，内部逻辑不动' },
    capsuleChat:       { key: 'andeyunhui.capsule.conversations', kind: 'json', scope: 'desktop', note: 'components/capsule/CapsuleChat.tsx CHAT_STORE_KEY，已封装模块，内部逻辑不动' },
    aideChat:          { key: 'andeyunhui.capsule.aide.conversations.v2', kind: 'json', scope: 'desktop', note: 'components/capsule/CapsuleAide.tsx AIDE_STORE_KEY，已封装模块，内部逻辑不动' },
    translateSource:   { key: 'ts_translate_source', kind: 'string', scope: 'desktop', note: 'lib/translateLanguages.ts KEY_SOURCE，已封装模块，内部逻辑不动' },
    translateTarget:   { key: 'ts_translate_target', kind: 'string', scope: 'desktop', note: 'lib/translateLanguages.ts KEY_TARGET，已封装模块，内部逻辑不动' },
    deskpetManifest:   { key: 'deskpet:manifest', kind: 'json', scope: 'desktop', note: 'deskpetManifest.ts DESKPET_MANIFEST_KEY，已封装模块，内部逻辑不动' },
    deskpetPresets:    { key: 'deskpet:presets', kind: 'json', scope: 'desktop', note: 'deskpetManifest.ts DESKPET_PRESETS_KEY，已封装模块，内部逻辑不动' },
    deskpetActive:     { key: 'deskpet:active', kind: 'string', scope: 'desktop', note: 'deskpetManifest.ts DESKPET_ACTIVE_PRESET_KEY，已封装模块，内部逻辑不动' },
  },
} as const;

export const MODULE_TOGGLE_PREFIX = 'module_sidebar_collapsed';
export function moduleToggleKey(moduleId: string): string {
  return `${MODULE_TOGGLE_PREFIX}_${moduleId}`;
}