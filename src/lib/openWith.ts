import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '@/stores/appStore';

// 扩展名 → 模块 id（与 appStore.activeModule 一致）
const MODULE_BY_EXT: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', tiff: 'image',
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', flv: 'video',
  mp3: 'music', flac: 'music', wav: 'music', ogg: 'music', m4a: 'music', aac: 'music',
  pdf: 'reading', epub: 'reading', txt: 'reading', md: 'reading', docx: 'reading', pptx: 'reading', xlsx: 'reading', csv: 'reading',
};
const MODULE_NAME: Record<string, string> = {
  image: '莲花', video: '玉兰', music: '铃兰', reading: '三色堇',
};

// 一次性列表：进程存活期间有效，关闭软件即销毁（模块挂载时通过 consumeOpenWith 取走）
let pending: { moduleId: string; files: string[] } | null = null;
export function consumeOpenWith() {
  const v = pending;
  pending = null;
  return v;
}

function route(files: string[]) {
  const ext = (files[0].split('.').pop() || '').toLowerCase();
  const moduleId = MODULE_BY_EXT[ext];
  if (!moduleId) {
    message(`暂不支持以安得云荟打开该类型文件（.${ext}）`, { title: '安得云荟' });
    return;
  }
  const registry = useAppStore.getState().pluginRegistry;
  // pluginRegistry 未初始化（null）时放行；否则用公开的 get(id) 判断是否已安装该模块
  const installed = !registry || !!registry.get(moduleId);
  if (!installed) {
    message(`未安装「${MODULE_NAME[moduleId] ?? moduleId}」模块，无法以安得云荟打开该文件。`, {
      title: '安得云荟',
    });
    return;
  }
  // 跳转到对应模块工作，并创建一次性文件列表（关闭软件即销毁）
  useAppStore.getState().setActiveModule(moduleId);
  pending = { moduleId, files };
  window.dispatchEvent(new CustomEvent('adyh-open-with', { detail: { moduleId, files } }));
}

export function initOpenWith(): () => void {
  // 启动即被文件关联唤起：拉取待处理列表
  invoke<string[]>('take_pending_open_files')
    .then((files) => {
      if (files && files.length) route(files);
    })
    .catch(() => {});
  // 运行时双击文件：监听事件
  const p = listen('open-with-files', (e: Event<string[]>) => {
    if (e.payload && e.payload.length) route(e.payload);
  });
  return () => {
    p.then((u) => u());
  };
}
