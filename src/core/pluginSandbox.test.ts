/**
 * 插件沙箱 · 全局遮蔽的兼容性回归。
 *
 * 存在的理由见 `pluginSandbox.ts` 里 `sandboxedFunction` 的血案注释：
 * 把 `Function` 遮蔽成 `undefined` 会让**任何** `x instanceof Function` 抛
 * `TypeError: Right-hand side of 'instanceof' is not an object`，
 * 而这类分支在第三方库（React Flow 的 MiniMap 等）里极常见 —— 表现是整个插件页崩溃。
 *
 * 所以这里钉住两条**同时成立**的性质：
 * ① 兼容：`instanceof Function` 语义正确；
 * ② 安全：`new Function` / `Function(...)` 仍然被拒绝。
 * 少了任何一条这个修复都不成立（只满足 ① = 沙箱被架空；只满足 ② = 原来的崩溃）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createSandboxGlobals, executeInSandbox } from './pluginSandbox';

type Registry = Parameters<typeof createSandboxGlobals>[1];

// vitest 是 node 环境（项目未装 jsdom），而 pluginSandbox 建 SafeWindow / bind 定时器时会读 window。
// 这里补一个最小替身；`__HOST_UI__` 兼作沙箱脚本回传结果的通道。
beforeAll(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    __HOST_UI__: {},
    __HOST_I18N__: {},
  };
  // node 的 console 没有 timeStamp（浏览器有），而 createSafeConsole 会 bind 它。
  // 这是**测试环境差异**，不是产品问题 —— 补一个空实现即可，不改产品代码。
  const c = console as unknown as Record<string, unknown>;
  if (typeof c.timeStamp !== 'function') c.timeStamp = () => {};
});

const registry = { register: () => {} } as unknown as Registry;

/** 在指定插件的沙箱里求值一个表达式，返回它的值。 */
function evalIn(pluginId: string, expr: string, deps?: string[]): unknown {
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  const holder: Record<string, unknown> = {};
  w.__HOST_UI__ = holder;
  const globals = createSandboxGlobals(pluginId, registry, deps);
  executeInSandbox(`__HOST_UI__.result = (${expr});`, globals, pluginId);
  return holder.result;
}

describe('插件沙箱 · Function 遮蔽', () => {
  it('未放行的插件：instanceof Function 可用（崩溃回归）', () => {
    // 直接抄 React Flow MiniMap 里那一句的形状 —— 它正是靠这条分支决定
    // 「把 prop 当函数用」还是「包一层常量函数」。若这里抛错，整个画布组件渲染失败。
    const pick = '((e) => (e instanceof Function ? e : () => e))';
    expect(evalIn('ai-chat', `${pick}(123) instanceof Function`)).toBe(true);
    // 箭头函数、普通函数、类都应被判为函数
    expect(evalIn('ai-chat', '(function(){}) instanceof Function')).toBe(true);
    expect(evalIn('ai-chat', '(() => {}) instanceof Function')).toBe(true);
    expect(evalIn('ai-chat', '(class {}) instanceof Function')).toBe(true);
    // ★ 非函数必须判 false —— 若一律 true，库会走错分支且**不会报错**，bug 更隐蔽
    expect(evalIn('ai-chat', '(123) instanceof Function')).toBe(false);
    expect(evalIn('ai-chat', '({}) instanceof Function')).toBe(false);
    expect(evalIn('ai-chat', "('x') instanceof Function")).toBe(false);
  });

  it('未放行的插件：Function 构造器仍被拒绝（安全不降级）', () => {
    expect(() => evalIn('ai-chat', 'Function("return 1")')).toThrow(/禁用 Function/);
    expect(() => evalIn('ai-chat', 'new Function("return 1")')).toThrow(/禁用 Function/);
    // 通过 Reflect.construct 走同一条路，也必须拦
    expect(() => evalIn('ai-chat', 'Reflect.construct(Function, ["return 1"])')).toThrow(/禁用 Function/);
  });

  it('放行的插件仍能用 Function（白名单 / 声明了 deps）', () => {
    expect(evalIn('ide', 'Function("return 7")()')).toBe(7);
    expect(evalIn('随便一个插件', 'Function("return 8")()', ['codemirror'])).toBe(8);
  });

  it('遮蔽列表里的其它全局仍是 undefined（未被这次改动波及）', () => {
    // 只有 Function 从 undefined 改成 Proxy；其余（fetch/Worker…）语义保持不变。
    expect(evalIn('ai-chat', 'typeof fetch')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof Worker')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof XMLHttpRequest')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof WebSocket')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof indexedDB')).toBe('undefined');
  });

  it('★ 已知缺口：eval 的遮蔽是死代码（据实钉住，避免误以为已生效）', () => {
    // `SandboxGlobals` 里写了 `eval: undefined`，但 `executeInSandbox` 会把它从形参里
    // **过滤掉** —— strict mode 下不允许用 `eval` 作形参名。所以插件里的裸 `eval`
    // 拿到的仍是全局 eval。这条断言记录**现状**，不是期望行为；
    // 要真正堵住得换实现（例如整体包一层非严格模式的 IIFE），属独立任务，未在本轮处理。
    expect(evalIn('ai-chat', 'typeof eval')).toBe('function');
  });
});
