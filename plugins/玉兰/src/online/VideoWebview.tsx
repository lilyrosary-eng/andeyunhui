/// <reference path="../../global.d.ts" />
// 视频模块 · 内嵌网页组件
//
// 用应用既有的 overlay 浮窗基建（ensureOverlayWindow）在「主窗口内容区」之上叠加一个
// WebView2 子窗，加载目标平台 URL，实现"应用内浏览器"。覆盖区域由容器 ref 的视口矩形
// + 主窗口屏幕坐标算出，覆盖 content 区。组件卸载时销毁该浮窗。
//
// 备注：overlay 浮窗是独立的 OS 窗口，位于主窗之上；平台站点自带导航/返回，本组件不额外
// 绘制控制条（避免被浮窗遮挡）。位置对齐可能需按主窗是否带标题栏微调。
import React from 'react';
import { ensureOverlayWindow, destroyOverlayWindow } from '@/core/overlayWindow';
import { getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window';

const { useEffect, useRef, useState } = React;

interface VideoWebviewProps {
  /** 唯一 label，避免与别的浮窗复用冲突 */
  label: string;
  url: string;
  /** 浮窗创建成功后回调句柄，供上层对网页执行 eval（如抖音提取视频地址） */
  onReady?: (handle: { evalJs: (code: string) => Promise<string> }) => void;
}

function Spinner() {
  return React.createElement('div', { className: 'flex items-center justify-center h-full text-sm text-neutral-400 dark:text-stone-500' }, '正在打开网页…');
}

export function VideoWebview({ label, url, onReady }: VideoWebviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<{ setPosition: (p: LogicalPosition) => Promise<void> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 创建/销毁 overlay 浮窗
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const main = getCurrentWindow();
        const pos = await main.outerPosition();
        const sx = pos.x + Math.round(rect.left);
        const sy = pos.y + Math.round(rect.top);
        const win = await ensureOverlayWindow(label, url, {
          x: sx,
          y: sy,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          decorations: false,
          shadow: false,
          transparent: false,
          skipTaskbar: true,
          alwaysOnTop: false,
          resizable: false,
        });
        if (disposed) {
          destroyOverlayWindow(label).catch(() => {});
          return;
        }
        winRef.current = win as unknown as { setPosition: (p: LogicalPosition) => Promise<void> };
        if (onReady) {
          onReady({
            evalJs: (code: string) =>
              (win as unknown as { eval: (c: string) => Promise<string> }).eval(code),
          });
        }
      } catch (e: unknown) {
        setError(String(e));
      }
    })();
    return () => {
      disposed = true;
      destroyOverlayWindow(label).catch(() => {});
      winRef.current = null;
    };
  }, [label, url]);

  // 容器尺寸变化时同步浮窗位置/大小
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(async () => {
      const win = winRef.current;
      const rect = el.getBoundingClientRect();
      if (!win || !rect) return;
      try {
        const main = getCurrentWindow();
        const pos = await main.outerPosition();
        await win.setPosition(new LogicalPosition(pos.x + Math.round(rect.left), pos.y + Math.round(rect.top)));
      } catch { /* 忽略同步失败 */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return React.createElement('div', { ref: containerRef, className: 'absolute inset-0 bg-white dark:bg-stone-900' },
    error
      ? React.createElement('div', { className: 'absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-500' }, `内嵌网页打开失败：${error}`)
      : React.createElement(Spinner),
  );
}

export default VideoWebview;
