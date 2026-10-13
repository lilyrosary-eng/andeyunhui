// 渲染 ComfyUI 媒体 data URL：图片 <img> / 视频 <video controls> / 音频 <audio controls> / 其他截断展示。
// 蓝图节点卡片与设置面板的结果区共用（comfyui_generate_media 现在可返图/视频/GIF/音频）。
interface MediaOutputProps {
  src: string;
  alt?: string;
  className?: string;
}

export function MediaOutput({ src, alt, className }: MediaOutputProps) {
  if (src.startsWith('data:image')) {
    return <img src={src} alt={alt ?? ''} className={className} />;
  }
  if (src.startsWith('data:video')) {
    return <video src={src} controls className={className} />;
  }
  if (src.startsWith('data:audio')) {
    return <audio src={src} controls className={className ?? 'w-full'} />;
  }
  // 非 data URL（如云端 ai_generate_image 回退的 http URL）或其他文本，截断展示
  if (src.startsWith('http')) {
    return <img src={src} alt={alt ?? ''} className={className} />;
  }
  return (
    <div className="max-h-16 overflow-y-auto rounded-md bg-black/5 px-2 py-1.5 text-[11px] leading-relaxed text-neutral-500 dark:bg-black/30 dark:text-stone-400">
      {src.slice(0, 200)}
    </div>
  );
}
