/// <reference path="../../global.d.ts" />
// 每平台「原生视频引擎」开关：持久化到 localStorage，只控制该平台自身行为。
// 默认取值由 videoPlatforms 的 nativeEngineDefault 决定（B 站默认开，其余默认关）。
import { useState, useEffect } from 'react';

const keyOf = (id: string) => `video_native_engine_${id}`;

export function useNativeEngine(id: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    if (!id) return fallback;
    const v = localStorage.getItem(keyOf(id));
    return v === null ? fallback : v === '1';
  });
  useEffect(() => {
    if (!id) return;
    localStorage.setItem(keyOf(id), on ? '1' : '0');
  }, [id, on]);
  return [on, setOn];
}
