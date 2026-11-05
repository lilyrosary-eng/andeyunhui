import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSLATE_NODES,
  DEFAULT_TRANSLATE_CHAIN,
  loadTranslateSettings,
  saveTranslateSettings,
  translateSettingsFor,
  formatNotices,
  TARGET_LANGS,
  SOURCE_LANGS,
  loadSourceLang,
  loadTargetLang,
  saveSourceLang,
  saveTargetLang,
} from './translateLanguages';

/** 不依赖 jsdom：给一个最小 localStorage 桩。 */
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
});

describe('翻译节点表', () => {
  it('至少有两个真免 key 节点，且免费节点排在 AI 之前', () => {
    const free = TRANSLATE_NODES.filter((n) => !n.needsKey && n.id !== 'auto');
    expect(free.map((n) => n.id)).toContain('bing');
    expect(free.map((n) => n.id)).toContain('mymemory');
    const ids = TRANSLATE_NODES.map((n) => n.id);
    expect(ids.indexOf('bing')).toBeLessThan(ids.indexOf('ai'));
  });

  it('默认链里的每个节点都真实存在，且不含 auto 自引用', () => {
    expect(DEFAULT_TRANSLATE_CHAIN.every((id) => TRANSLATE_NODES.some((n) => n.id === id))).toBe(true);
    expect(DEFAULT_TRANSLATE_CHAIN).not.toContain('auto');
    expect(DEFAULT_TRANSLATE_CHAIN[0]).toBe('bing');
  });

  it('实测不可达的节点必须如实标注，不许装作可用', () => {
    const google = TRANSLATE_NODES.find((n) => n.id === 'google');
    expect(google?.note).toMatch(/超时|不可达/);
    const libre = TRANSLATE_NODES.find((n) => n.id === 'libre');
    expect(libre?.note).toMatch(/403|自建/);
  });
});

describe('翻译设置持久化', () => {
  it('没存过时落到「自动」，不会变成 undefined', () => {
    expect(loadTranslateSettings().node).toBe('auto');
  });

  it('写入后能读回，且节点/凭证/链顺序都保留', () => {
    saveTranslateSettings({
      node: 'baidu',
      chain: ['bing', 'baidu'],
      baiduAppId: '2026',
      baiduSecret: 'secret',
      glossary: '猫=cat',
      cache: false,
    });
    const s = loadTranslateSettings();
    expect(s.node).toBe('baidu');
    expect(s.chain).toEqual(['bing', 'baidu']);
    expect(s.baiduSecret).toBe('secret');
    expect(s.glossary).toBe('猫=cat');
    expect(s.cache).toBe(false);
  });

  it('坏 JSON 不该让翻译链挂掉 —— 回落成「自动」', () => {
    localStorage.setItem('ts_translate_settings', '{坏掉的 JSON');
    expect(loadTranslateSettings().node).toBe('auto');
  });

  it('非对象 JSON 也回落', () => {
    localStorage.setItem('ts_translate_settings', '"just a string"');
    expect(loadTranslateSettings().node).toBe('auto');
  });
});

describe('translateSettingsFor', () => {
  it('不带 node 时沿用设置里存的节点', () => {
    saveTranslateSettings({ node: 'youdao', youdaoAppKey: 'k' });
    expect(translateSettingsFor().node).toBe('youdao');
    expect(translateSettingsFor().youdaoAppKey).toBe('k');
  });

  it('测试模式：强制单节点 + 绕过缓存（不能被命中掩盖）', () => {
    saveTranslateSettings({ node: 'auto', cache: true });
    const s = translateSettingsFor('bing', true);
    expect(s.node).toBe('bing');
    expect(s.probe).toBe(true);
    expect(s.cache).toBe(false);
  });

  it('普通调用不修改已存设置', () => {
    saveTranslateSettings({ node: 'auto' });
    translateSettingsFor('mymemory');
    expect(loadTranslateSettings().node).toBe('auto');
  });
});

describe('显式提示格式化', () => {
  it('空提示返回空串', () => {
    expect(formatNotices()).toBe('');
    expect(formatNotices([])).toBe('');
    expect(formatNotices(null)).toBe('');
  });

  it('每条都带 ⚠️，且不重复添加，换行保留', () => {
    const out = formatNotices(['首站失败', '⚠️ 已带前缀', '已兜底到 MyMemory']);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('⚠️ 首站失败');
    expect(lines[1]).toBe('⚠️ 已带前缀');
    expect(lines[2]).toBe('⚠️ 已兜底到 MyMemory');
  });
});

describe('语言下拉（既有语义不回归）', () => {
  it('目标语言不含「自动识别」，源语言含', () => {
    expect(TARGET_LANGS.some((l) => l.code === 'auto')).toBe(false);
    expect(SOURCE_LANGS[0].code).toBe('auto');
  });

  it('非法/空白值回落到默认', () => {
    expect(loadTargetLang()).toBe('中文');
    expect(loadSourceLang()).toBe('auto');
    // 故意写一个不在列表里的值，验证读取时会校验并回落
    saveTargetLang('不存在的语言');
    expect(loadTargetLang()).toBe('中文');
    saveTargetLang('英语');
    expect(loadTargetLang()).toBe('英语');
    saveSourceLang('日语');
    expect(loadSourceLang()).toBe('日语');
  });
});

describe('术语表开关', () => {
  it('没设过开关时照常下发术语表（老配置无需迁移）', () => {
    saveTranslateSettings({ glossary: 'heart=心' });
    expect(translateSettingsFor().glossary).toBe('heart=心');
  });

  it('关掉时本次不发术语表，但存好的表不被清空', () => {
    saveTranslateSettings({ glossary: 'heart=心', glossaryOn: false });
    expect(translateSettingsFor().glossary).toBeUndefined();
    // 关键：关一下不该把用户攒的术语表抹掉
    expect(loadTranslateSettings().glossary).toBe('heart=心');
    saveTranslateSettings({ glossary: 'heart=心', glossaryOn: true });
    expect(translateSettingsFor().glossary).toBe('heart=心');
  });

  it('glossaryOn 只是前端开关，不发后端', () => {
    saveTranslateSettings({ glossary: 'a=b', glossaryOn: false });
    expect('glossaryOn' in translateSettingsFor()).toBe(false);
  });
});
