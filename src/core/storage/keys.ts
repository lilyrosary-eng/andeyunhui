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
    ragVisible:        { key: 'niaoluo:rag-visible', kind: 'flag', scope: 'shared', default: '0' },
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
    zoom:              { key: 'zoom', kind: 'flag', scope: 'shared', default: '100' },
    panelOpacity:      { key: 'panelOpacity', kind: 'flag', scope: 'shared', default: '80' },
    fontFamily:        { key: 'fontFamily', kind: 'string', scope: 'shared', default: '系统默认' },
    appBgImage:        { key: 'appBgImage', kind: 'string', scope: 'shared' },
    appBgBlur:         { key: 'appBgBlur', kind: 'flag', scope: 'shared', default: '0' },
    appBgAngle:        { key: 'appBgAngle', kind: 'flag', scope: 'shared', default: '0' },
    appBgFlip:         { key: 'appBgFlip', kind: 'flag', scope: 'shared', default: 'false' },
    appBgScrub:        { key: 'appBgScrub', kind: 'flag', scope: 'shared', default: 'false' },
    appBgVideoPersist: { key: 'appBgVideoPersist', kind: 'flag', scope: 'shared', default: 'false' },
    appBgVideoPath:    { key: 'appBgVideoPath', kind: 'string', scope: 'shared', note: '桌面设置/全局面板读写' },
  },
  desktop: {
    shortcuts:         { key: 'shortcuts', kind: 'json', scope: 'desktop', note: '即 GlobalSettingsPanel「快捷键」' },
    devConsoleHistory: { key: 'dev_console_history', kind: 'json', scope: 'desktop', note: 'slice(-50)' },
    clipStorage:       { key: 'clipboard_history_v1', kind: 'json', scope: 'desktop', note: '见 FloatingClipboardView CLIP_STORAGE_KEY' },
    lyricsFontSize:    { key: 'music_lyrics_font_size', kind: 'string', scope: 'desktop' },
    lyricsShowNext:    { key: 'music_lyrics_show_next_line', kind: 'flag', scope: 'desktop' },
    chroma:            { key: 'deskpet:chroma', kind: 'json', scope: 'desktop', note: '{color,tolerance}' },
    chromaDisabled:    { key: 'deskpet:chroma-disable', kind: 'flag', scope: 'desktop', default: 'false' },
  },
  mobile: {
    preview:           { key: 'mobile-preview', kind: 'flag', scope: 'mobile', default: '0', note: 'main.tsx 预览开关' },
    proactiveOn:       { key: 'andeyunhui.mobile.proactive.enabled', kind: 'flag', scope: 'mobile', default: '0', note: '见 useProactiveMessage PROACTIVE_KEY' },
    proactiveInterval: { key: 'andeyunhui.mobile.proactive.intervalMin', kind: 'string', scope: 'mobile', default: '60', note: '见 useProactiveMessage INTERVAL_KEY' },
  },
  devtools: {
    logLevel:          { key: 'log_level', kind: 'string', scope: 'dev', note: '生产排障口头开关' },
  },
  doc: {
    // —— 已封装模块内部 key 的文档登记（内部实现不动）——
    mobileChat:        { key: 'andeyunhui.mobile.conversations', kind: 'json', scope: 'mobile', note: 'mobile/stores/chatStore.ts CHAT_KEY，已封装模块，内部逻辑不动' },
    capsuleChat:       { key: 'andeyunhui.capsule.conversations', kind: 'json', scope: 'desktop', note: 'components/capsule/CapsuleChat.tsx CHAT_STORE_KEY，已封装模块，内部逻辑不动' },
    aideChat:          { key: 'andeyunhui.capsule.aide.conversations.v2', kind: 'json', scope: 'desktop', note: 'components/capsule/CapsuleAide.tsx AIDE_STORE_KEY，已封装模块，内部逻辑不动' },
    companionCache:    { key: 'andeyunhui.mobile.companion.cache', kind: 'json', scope: 'mobile', note: 'mobile/stores/companionStore.ts CACHE_KEY，已封装模块，内部逻辑不动' },
    ragEmbed:          { key: 'andeyunhui.mobile.rag.embed', kind: 'json', scope: 'mobile', note: 'mobile/stores/semanticMemory.ts EMBED_KEY，已封装模块，内部逻辑不动' },
    translateSource:   { key: 'ts_translate_source', kind: 'string', scope: 'desktop', note: 'lib/translateLanguages.ts KEY_SOURCE，已封装模块，内部逻辑不动' },
    translateTarget:   { key: 'ts_translate_target', kind: 'string', scope: 'desktop', note: 'lib/translateLanguages.ts KEY_TARGET，已封装模块，内部逻辑不动' },
    deskpetManifest:   { key: 'deskpet:manifest', kind: 'json', scope: 'desktop', note: 'deskpetManifest.ts DESKPET_MANIFEST_KEY，已封装模块，内部逻辑不动' },
    deskpetPresets:    { key: 'deskpet:presets', kind: 'json', scope: 'desktop', note: 'deskpetManifest.ts DESKPET_PRESETS_KEY，已封装模块，内部逻辑不动' },
    deskpetActive:     { key: 'deskpet:active', kind: 'string', scope: 'desktop', note: 'deskpetManifest.ts DESKPET_ACTIVE_PRESET_KEY，已封装模块，内部逻辑不动' },
    deskpetSettings:   { key: 'deskpet:settings', kind: 'json', scope: 'desktop', note: 'DeskpetSettingsPanel.tsx DESKPET_SETTINGS_KEY，已封装模块，内部逻辑不动' },
  },
} as const;

export const MODULE_TOGGLE_PREFIX = 'module_sidebar_collapsed';
export function moduleToggleKey(moduleId: string): string {
  return `${MODULE_TOGGLE_PREFIX}_${moduleId}`;
}