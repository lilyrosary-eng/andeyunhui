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
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSandboxGlobals, executeInSandbox } from './pluginSandbox';
import type { PluginPermissions } from '@/lib/api';

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
function evalIn(
  pluginId: string,
  expr: string,
  opts?: { deps?: string[]; permissions?: PluginPermissions },
): unknown {
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  const holder: Record<string, unknown> = {};
  w.__HOST_UI__ = holder;
  const globals = createSandboxGlobals(pluginId, registry, opts);
  executeInSandbox(`__HOST_UI__.result = (${expr});`, globals, pluginId);
  return holder.result;
}

/** 求值一个返回 Promise 的表达式，把 rejection 原样抛出（便于断言错误信息）。 */
function evalPromiseIn(
  pluginId: string,
  expr: string,
  opts?: { deps?: string[]; permissions?: PluginPermissions },
): Promise<unknown> {
  return evalIn(pluginId, expr, opts) as Promise<unknown>;
}

/** 取一个被拒绝的 Promise 的错误信息（不让它变成 unhandled rejection）。 */
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '<未拒绝>';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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
    expect(evalIn('随便一个插件', 'Function("return 8")()', { deps: ['codemirror'] })).toBe(8);
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

describe('插件沙箱 · window 受限代理（防止遮蔽被 alias 绕开）', () => {
  it('window.fetch / XMLHttpRequest / WebSocket 也拿不到真身', () => {
    // 顶层只遮蔽裸 fetch 是不够的：插件完全可以写 window.fetch。
    expect(evalIn('ai-chat', 'typeof window.fetch')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.XMLHttpRequest')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.WebSocket')).toBe('undefined');
  });

  it('window.parent / top / self / frames / globalThis 返回沙箱自身', () => {
    // 顶层窗口里这些属性都指向**真实** window。若原样透传，
    // `window.parent.fetch` 就能拿回上面刚被遮蔽的真身 —— 等于没屏蔽。
    expect(evalIn('ai-chat', 'window.parent === window')).toBe(true);
    expect(evalIn('ai-chat', 'window.top === window')).toBe(true);
    expect(evalIn('ai-chat', 'window.self === window')).toBe(true);
    expect(evalIn('ai-chat', 'window.frames === window')).toBe(true);
    expect(evalIn('ai-chat', 'window.globalThis === window')).toBe(true);
    // 经由这些别名同样拿不到网络 API
    expect(evalIn('ai-chat', 'typeof window.parent.fetch')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.top.fetch')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.self.fetch')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.globalThis.fetch')).toBe('undefined');
  });

  it('Tauri IPC 全局在沙箱里永不存在（即便将来开 withGlobalTauri）', () => {
    expect(evalIn('ai-chat', 'typeof window.__TAURI__')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.__TAURI_INVOKE__')).toBe('undefined');
    expect(evalIn('ai-chat', 'typeof window.__TAURI_OS__')).toBe('undefined');
  });

  it('__TAURI_INTERNALS__ 故意不遮蔽（宿主直连插件需要它，见 pluginSandbox.ts 注释）', () => {
    // ai-chat / 薄荷 等插件经 vite.shared.config 的 alias 把宿主 src 编进 IIFE，
    // 其 invoke 是 @tauri-apps/api/core 直连（实现即 window.__TAURI_INTERNALS__.invoke）。
    // 遮蔽它会直接 TypeError 挂掉这类插件——沙箱不是安全边界，边界在 Tauri capability/ACL。
    // 在 node 测试环境里真实 window 上本来就没有该属性，故用"读取不抛错且可写透传"来锁定语义。
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    w.__TAURI_INTERNALS__ = { invoke: () => undefined };
    expect(evalIn('ai-chat', 'typeof window.__TAURI_INTERNALS__')).toBe('object');
    expect(evalIn('ai-chat', 'typeof window.__TAURI_INTERNALS__.invoke')).toBe('function');
    delete w.__TAURI_INTERNALS__;
  });

  it('未知属性仍透传真实 window，函数被 bind 到真实 window', () => {
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    w.__SENTINEL__ = 42;
    // 函数返回 `this === 真实 window`：若透传的是未 bind 的裸函数，this 会变成沙箱 proxy，
    // 真实 DOM API（addEventListener 等）就会抛 "Illegal invocation"。
    w.__PROBE_FN__ = function (this: unknown) {
      return this === (globalThis as unknown as { window: unknown }).window;
    };
    expect(evalIn('ai-chat', 'window.__SENTINEL__')).toBe(42);
    expect(evalIn('ai-chat', 'typeof window.__PROBE_FN__')).toBe('function');
    expect(evalIn('ai-chat', 'window.__PROBE_FN__()')).toBe(true);
  });

  it('宿主注入优先于真实 window，写入落在 proxy target（读写一致）', () => {
    // 读：target 已有 key 优先返回注入值
    expect(evalIn('ai-chat', 'typeof window.__HOST_API__')).toBe('object');
    expect(evalIn('ai-chat', 'typeof window.__HOST_REACT__')).toBe('object');
    // 写：写 target，随后从 target 读回 —— 保持一致（曾因"写真实 window / 读 target"而丢值）
    expect(evalIn('ai-chat', '(window.__PERSIST__ = 1, window.__PERSIST__)')).toBe(1);
  });
});

describe('插件沙箱 · manifest 声明式权限（permissions.commands）', () => {
  const READ = { commands: ['plugin_storage_get', 'load_image_cache'] };

  it('未声明权限：零命令 + 显式报错（不再白送整个白名单）', async () => {
    // 2026-10-19 改：旧语义是「未声明 → 回退 ALLOWED_COMMANDS」，等于让 crypto / gongjuxiang /
    // screen-recorder（manifest 整段没有 permissions，实测一条命令都不调）白拿
    // delete_file / write_text_file / scan_ports / clipboard_read 等全盘能力。
    // 这条测试原本把那个洞**钉成了预期行为**，现在反过来钉住「未声明就必须被拒」。
    const msg = await rejectionOf(evalPromiseIn('ai-chat', 'api.invoke("netease_http_post")'));
    expect(msg).toMatch(/未授权命令/);
    // 报错必须点名"要么列命令、要么显式写空数组"，否则使用者不知道该怎么修
    expect(msg).toMatch(/manifest\.json/);
  });

  it('显式空数组 = 我明确不要任何后端命令（同样被拒，但不按配置遗漏给提示）', async () => {
    const msg = await rejectionOf(
      evalPromiseIn('ai-chat', 'api.invoke("netease_http_post")', { permissions: { commands: [] } }),
    );
    expect(msg).toMatch(/未授权命令/);
    // 与"缺失"的区别在于修复提示：空数组是主动选择，不该被当成配置遗漏
    expect(msg).not.toMatch(/permissions\.commands 并列入/);
  });

  it('声明了权限的插件：未声明的命令被拒绝，且错误信息可直接复制去修', async () => {
    const msg = await rejectionOf(
      evalPromiseIn('ai-chat', 'api.invoke("netease_http_post")', { permissions: READ }),
    );
    expect(msg).toMatch(/未授权命令/);
    // 修复提示必须点名 manifest 路径和具体命令，否则"显式报错"等于没报
    expect(msg).toMatch(/plugins\/ai-chat\/manifest\.json/);
    expect(msg).toMatch(/netease_http_post/);
  });

  it('声明了权限的插件：声明过的命令不被权限层拦截', async () => {
    const msg = await rejectionOf(
      evalPromiseIn('ai-chat', 'api.invoke("plugin_storage_get", { key: "k" })', {
        permissions: READ,
      }),
    );
    expect(msg).not.toMatch(/未授权命令/);
  });

  it('manifest 不能比全局白名单更宽：声明未放行的命令 → 告警且不放行', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const msg = await rejectionOf(
        evalPromiseIn('ai-chat', 'api.invoke("delete_all_notes")', {
          permissions: { commands: ['delete_all_notes'] },
        }),
      );
      expect(msg).toMatch(/未授权命令/);
      // 加载期就要显式指出"这条声明无效"，而不是等运行期才神秘失败
      expect(spy.mock.calls.flat().join('\n')).toMatch(/delete_all_notes/);
    } finally {
      spy.mockRestore();
    }
  });

  it('空数组与缺失语义不同：空 = 显式零权限，缺失 = 配置遗漏（两者都拒，但提示不同）', async () => {
    const empty = await rejectionOf(
      evalPromiseIn('ai-chat', 'api.invoke("netease_http_post")', { permissions: { commands: [] } }),
    );
    const missing = await rejectionOf(evalPromiseIn('ai-chat', 'api.invoke("netease_http_post")'));
    expect(empty).toMatch(/未授权命令/);
    expect(missing).toMatch(/未授权命令/);
    expect(empty).not.toEqual(missing);
  });
});
