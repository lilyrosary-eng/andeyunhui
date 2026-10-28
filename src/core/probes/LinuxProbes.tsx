/**
 * Linux 排障探针（默认全关，靠 ~/.config/andeyunhui/debug.json 打开）。
 *
 * 为什么要有它：两个问题靠"猜"已经猜错过两次 ——
 *   1. 图片模块工具栏按钮既不高亮也点不动：不知道是"被别的窗口盖住"还是"被 DOM 遮罩盖住"；
 *   2. 音乐页/沉浸页黏滞：一直只有体感，没有帧率数字。
 * 所以这里只做两件事：把**命中元素**和**帧率**写进会话日志，有数据再动代码。
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '@/stores/appStore';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { isLinux } from '@/platform/isLinux';

// 注意：Rust 侧 DebugFlags 是**没有** rename_all 的结构体，serde 输出的 JSON 是 snake_case
// （`hit_probe` / `fps_probe`）。这里必须按 snake_case 读，否则永远是 undefined ⇒ 探针不启动
// （2026-10-28 血案：我写了 camelCase，探针一次都没跑过）。
type Flags = { hit_probe?: boolean; fps_probe?: boolean };

const log = (msg: string) => {
  void invoke('debug_log', { msg }).catch(() => {});
};

function describe(el: HTMLElement | null): string {
  if (!el) return '<null>';
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
  return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}>`;
}

/** 鼠标落在窗口顶部 120px 时记录命中的元素（限 40 条，避免刷爆日志）。 */
function useHitProbe(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !isLinux()) return undefined;
    let sent = 0;
    let last = 0;
    const onMove = (e: MouseEvent) => {
      if (sent >= 40 || e.clientY > 120) return;
      const now = performance.now();
      if (now - last < 400) return;
      last = now;
      sent += 1;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const chain: string[] = [];
      let n: HTMLElement | null = el;
      while (n && chain.length < 4) {
        chain.push(n.tagName.toLowerCase());
        n = n.parentElement;
      }
      const cap = useCapsuleStore.getState();
      log(
        `HIT (${Math.round(e.clientX)},${Math.round(e.clientY)}) -> ${describe(el)} ` +
          `chain=${chain.join('<')} capsuleExpanded=${cap.expanded} winW=${window.innerWidth} winH=${window.innerHeight}`,
      );
    };
    document.addEventListener('mousemove', onMove, { passive: true });
    log('HIT_PROBE on（把鼠标移到顶部区域即可采样，最多 40 条）');
    return () => document.removeEventListener('mousemove', onMove);
  }, [enabled]);
}

/** 每 2 秒把主窗 rAF 帧率写进日志（附当前模块/是否沉浸），用于性能前后对比。 */
function useFpsProbe(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return undefined;
    let frames = 0;
    let t0 = performance.now();
    let raf = 0;
    const tick = () => {
      frames += 1;
      const now = performance.now();
      if (now - t0 >= 2000) {
        const fps = Math.round((frames * 1000) / (now - t0));
        const st = useAppStore.getState();
        log(`FPS ${fps} module=${st.activeModule} immersive=${st.immersive ? 1 : 0}`);
        frames = 0;
        t0 = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
}

export function LinuxProbes() {
  const [flags, setFlags] = useState<Flags | null>(null);
  useEffect(() => {
    void invoke<Flags>('debug_flags')
      .then((f) => setFlags(f ?? null))
      .catch(() => setFlags(null));
  }, []);
  useHitProbe(!!flags?.hit_probe);
  useFpsProbe(!!flags?.fps_probe);
  return null;
}
