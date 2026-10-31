import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateTo, registerNavigator, setModuleActivator, unregisterNavigator } from './navigation';

function installWindowMock() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const mockWindow = {
    addEventListener: (type: string, handler: EventListener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, handler: EventListener) => {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: Event) => {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    },
  };
  vi.stubGlobal('window', mockWindow);
}

beforeEach(() => {
  installWindowMock();
});

afterEach(() => {
  unregisterNavigator('demo');
  setModuleActivator(() => {});
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('统一导航契约', () => {
  it('已注册处理器时切模块并立即执行', async () => {
    const activate = vi.fn();
    const handler = vi.fn(() => true);
    setModuleActivator(activate);
    registerNavigator('demo', handler);

    await expect(navigateTo({ module: 'demo', tabs: ['a'], entity: 'x' })).resolves.toBe(true);
    expect(activate).toHaveBeenCalledWith('demo');
    expect(handler).toHaveBeenCalledWith({ module: 'demo', tabs: ['a'], entity: 'x' });
  });

  it('模块尚未挂载时排队，注册后自动消费', async () => {
    const handler = vi.fn(() => true);
    const promise = navigateTo({ module: 'demo', entity: 'late' });
    registerNavigator('demo', handler);

    await expect(promise).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith({ module: 'demo', entity: 'late' });
  });

  it('超时后广播兜底事件并返回 false', async () => {
    vi.useFakeTimers();
    const dispatched = vi.fn();
    window.addEventListener('andy:navigate', dispatched);

    const promise = navigateTo({ module: 'demo', entity: 'missing' });
    vi.advanceTimersByTime(2000);

    await expect(promise).resolves.toBe(false);
    expect(dispatched).toHaveBeenCalledTimes(1);
    window.removeEventListener('andy:navigate', dispatched);
  });

  it('注销后再次进入排队，且不会把旧处理器留给新挂载', async () => {
    const first = vi.fn();
    const unregister = registerNavigator('demo', first);
    unregister();

    const promise = navigateTo({ module: 'demo', entity: 'second' });
    const second = vi.fn(() => true);
    registerNavigator('demo', second);
    await expect(promise).resolves.toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ module: 'demo', entity: 'second' });
  });
});
