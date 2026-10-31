/// <reference path="../../../global.d.ts" />

// 宿主注入的 React / API。插件构建时 react 被 external，由宿主提供同一实例。
export const React = window.__HOST_REACT__;
export const {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
  useSyncExternalStore,
} = React;

export const hostApi = window.__HOST_API__;

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
