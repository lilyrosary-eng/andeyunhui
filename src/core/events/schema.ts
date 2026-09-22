/**
 * 全量自定义事件名索引：唯一事实源。
 * 范围 = 代码中 listen/emit（src 前端 + src-tauri 后端）出现的自定义事件名。
 * 默认例外：Tauri 窗口原生事件（blur/focus/resize/close 等）不入表；tauri://error 入 EVENTS.tauri.error。
 * DOM CustomEvent（plugin-registered 等）属页内事件、非 IPC 事件，不入表。
 * pty 事件为动态名（pty-output:<id> / pty-exit:<id>），以前缀常量登记。
 */
export const EVENTS = {
  ai: {
    delta: 'ai-delta', reasoning: 'ai-reasoning-delta', done: 'ai-done', error: 'ai-error',
    thinkingChanged: 'ai-thinking-changed', activeProfileChanged: 'ai-active-profile-changed',
    agentStep: 'ai-agent-step',
  },
  transfer: {
    peerFound: 'transfer-peer-found', progress: 'transfer-progress', request: 'transfer-receive-request',
    confirmed: 'transfer-receive-confirmed', declined: 'transfer-receive-declined', received: 'transfer-received',
    capsuleTook: 'transfer-receive-capsule-took', saveDirInvalid: 'transfer:save-dir-invalid',
    dropzoneChanged: 'dropzone-changed', dropzoneSaving: 'dropzone-saving', dropzoneSavingDone: 'dropzone-saving-done',
  },
  screenshot: { start: 'screenshot-start', ready: 'screenshot-ready', windows: 'screenshot-windows', noteImport: 'screenshot-note-import', open: 'open-screenshot' },
  recorder: {
    toggle: 'recorder-toggle', started: 'recording-started', stopped: 'recording-stopped', saving: 'recording-saving',
    error: 'recording-error', reveal: 'recorder-reveal', selectReady: 'recorder-select-ready', selectCancel: 'recorder-select-cancel',
  },
  deskpet: {
    openDevtools: 'deskpet:open-devtools', settings: 'deskpet:settings', manifest: 'deskpet:manifest',
    asset: 'deskpet:asset', requestAsset: 'deskpet:request-asset', requestManifest: 'deskpet:request-manifest',
    requestSettings: 'deskpet:request-settings', deviceChanged: 'device-changed', expand: 'capsule:expand', nowPlaying: 'now-playing',
  },
  plugin: { reload: 'plugin-reload', unload: 'plugin-unload', fsChange: 'plugin-fs-change', unregistered: 'plugin-unregistered' },
  window: { trayMenu: 'open-tray-menu', clipboardFloating: 'open-clipboard-floating', dropzoneFloating: 'open-dropzone-floating', capsuleHealth: '__capsule_health__' },
  notes: { opened: 'floating-note-opened', closed: 'floating-note-closed' },
  migration: { started: 'migration-started', done: 'migration-done', progress: 'migration-progress' },
  fileSearch: { indexProgress: 'fs-index-progress' },
  smtc: { diag: 'smtc-diag', control: 'smtc-control' },
  lyrics: {
    update: 'lyrics-update', styleUpdate: 'lyrics-style-update', lockChanged: 'lyrics-lock-changed',
    // 歌词窗口真实可见性：后端为唯一事实源，主面板播放栏与黄金棋盘浮岛按钮据此双向同步
    visibilityChanged: 'lyrics-widget-visibility-changed',
  },
  openWith: { files: 'open-with-files' },
  tauri: { error: 'tauri://error' },
  chatStream: {
    prefix: 'ai', ideChatPrefix: 'capsule-ide-chat', ideAgentPrefix: 'capsule-ide-agent',
    chatRequest: 'capsule-ide-chat-request', agentRequest: 'capsule-ide-agent-request',
    clearConversations: 'capsule-ide-clear-conversations',
  },
  scan: {
    // 'scan-progress'/'scan-chunk' 现为阅读专用；图片曾与其共用导致跨模块事件串台
    // （图片模块收到阅读的 BookSummary，卡片渲染成 "{n} 张" 占位），已拆分为 image-scan-*
    progress: 'scan-progress', chunk: 'scan-chunk',
    imageProgress: 'image-scan-progress', imageChunk: 'image-scan-chunk',
    musicProgress: 'music-scan-progress', musicChunk: 'music-scan-chunk',
    videoProgress: 'video-scan-progress', videoChunk: 'video-scan-chunk',
  },
  reading: { meta: 'open-book-meta', progress: 'open-book-progress', chunk: 'open-book-chunk' },
  pty: { outputPrefix: 'pty-output:', exitPrefix: 'pty-exit:' },
} as const;

/** 事件名 → 载荷字段提示（以现有 listen<T> 处泛型为据；仅登记存活性，不改调用点形状） */
export const EVENT_PAYLOAD_KEYS: Record<string, string> = {
  'ai-delta': '{ requestId: string; delta?: string; text?: string }',
  'ai-reasoning-delta': '{ requestId: string; delta: string }',
  'ai-done': '{ requestId: string }',
  'ai-error': '{ requestId: string; error: string }',
  'ai-thinking-changed': '{ profile_id: string; thinking: boolean }',
  'ai-active-profile-changed': '{ id: string }',
  'ai-agent-step': '{ requestId: string; stage: string; name: string; ok: boolean; detail: string }',
  'transfer-peer-found': 'TransferPeer',
  'transfer-progress': 'TransferProgressItem',
  'transfer-receive-request': 'ReceiveRequest',
  'transfer-receive-capsule-took': '{ session_id: string }',
  'transfer-receive-confirmed': '{ session_id: string }',
  'transfer-receive-declined': '{ session_id: string }',
  'transfer-received': '{ file_name: string; peer_alias: string }',
  'transfer:save-dir-invalid': '{ path: string; reason: string }',
  'dropzone-saving-done': '{ tempId: string }',
  'screenshot-note-import': '{ ref: string; name: string; noteId: string }',
  'recording-started': 'string（输出路径）',
  'recording-stopped': 'string（输出路径或空串）',
  'recording-error': 'string（错误信息）',
  'recorder-select-ready': '{ ox: number; oy: number; scale: number; windows?: unknown }',
  'deskpet:settings': 'DeskpetSettings',
  'deskpet:manifest': 'DeskpetManifest',
  'deskpet:asset': '{ key: string; url: string }',
  'device-changed': '{ t: number; x?: number; y?: number; key?: string }',
  'capsule:expand': 'boolean',
  'now-playing': 'Record<string, unknown>',
  'open-tray-menu': '{ x: number; y: number }',
  'open-with-files': 'string[]',
  'migration-progress': '{ percent: number }',
  'fs-index-progress': '{ count: number; done: boolean }',
  'lyrics-update': '{ currentLine: string; nextLine: string; currentSub?: string; nextSub?: string }',
  'lyrics-style-update': '{ fontSize?: number; showNextLine?: boolean }',
  'lyrics-lock-changed': '{ locked: boolean }',
  'lyrics-widget-visibility-changed': '{ visible: boolean }',
  'floating-note-opened': 'string（noteId）',
  'floating-note-closed': '{ noteId: string }',
  'plugin-reload': 'string（pluginId）',
  'plugin-unload': 'string（pluginId）',
  'plugin-fs-change': '{ kind?: string; paths?: string[] }',
  'smtc-diag': 'unknown',
};

/** 事件名 → 生产示例载荷（仅信息） */
export function eventPayload(eventName: string): unknown {
  const hint = EVENT_PAYLOAD_KEYS[eventName];
  return hint ?? {};
}
