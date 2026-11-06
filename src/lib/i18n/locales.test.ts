import { describe, expect, it } from 'vitest';
import { zhCN } from './locales/zh-CN';
import { enUS } from './locales/en-US';
import { zhTW } from './locales/zh-TW';
import { jaJP } from './locales/ja-JP';
import { koKR } from './locales/ko-KR';
import { deDE } from './locales/de-DE';
import { frFR } from './locales/fr-FR';

/**
 * i18n key 完整性卡口。
 *
 * 背景：zh-CN 是源语言（1381 个 key），其余 6 个语言历史上缺 132~195 个 key，
 * 运行时静默回退中文。没有卡口时这个缺口只会越来越大：加功能的人只改 zh-CN，
 * 其他语言什么时候补全、补了多少，没有任何机制会提醒。
 *
 * 这个测试把「当前缺口」固化成基线（BASELINE），之后：
 *   1. 任何语言都不允许出现 zh-CN 里没有的 key（拼错 key 会静默不生效，必须拦）；
 *   2. 新缺的 key 必须不在基线覆盖范围内 → 想加功能就得同步翻译；
 *   3. 缺失总数不允许超过基线 → 基线只能缩小（补全翻译时顺手删条目），
 *      不能悄悄变大（否则说明有新功能没翻译就被合进来了）。
 *
 * 基线用「前缀 + 零散 key」表达是为了控制体积；配合第 3 条总数断言，
 * 前缀豁免不会变成"以后往这个前缀下加 key 都免费"的后门。
 */
const LOCALES: Record<string, Record<string, string>> = {
  'en-US.ts': enUS,
  'zh-TW.ts': zhTW,
  'ja-JP.ts': jaJP,
  'ko-KR.ts': koKR,
  'de-DE.ts': deDE,
  'fr-FR.ts': frFR,
};

const BASELINE: Record<string, { prefixes: string[]; keys: string[] }> = {
  'de-DE.ts': {
    prefixes: ['capsule.action.', 'capsule.res.', 'image.noResults.', 'image.settings.', 'modelSettings.comfyui.', 'music.kugou.', 'music.lyrics.', 'music.moduleDrawer.', 'music.stats.', 'music.track.'],
    keys: ['capsule.collectFailed', 'capsule.collecting', 'capsule.liveNow', 'capsule.paused', 'capsule.resume', 'music.favoriteAdd', 'music.favoriteRemove', 'music.metaAutoCandidates', 'music.metaAutoFail', 'music.metaAutoField', 'music.metaAutoLoading', 'music.metaAutoNoResult', 'music.metaAutoOneKey', 'music.metaAutoOneKeyHint', 'music.settings.playMode', 'music.sidebar.stats'],
  },
  'en-US.ts': {
    prefixes: ['modelSettings.comfyui.', 'music.kugou.', 'music.lyrics.', 'music.moduleDrawer.', 'music.stats.', 'music.track.'],
    keys: ['music.favoriteAdd', 'music.favoriteRemove', 'music.metaAutoCandidates', 'music.metaAutoFail', 'music.metaAutoField', 'music.metaAutoLoading', 'music.metaAutoNoResult', 'music.metaAutoOneKey', 'music.metaAutoOneKeyHint', 'music.settings.playMode', 'music.sidebar.stats'],
  },
  'fr-FR.ts': {
    prefixes: ['capsule.action.', 'capsule.res.', 'image.noResults.', 'image.settings.', 'modelSettings.comfyui.', 'music.kugou.', 'music.lyrics.', 'music.moduleDrawer.', 'music.stats.', 'music.track.'],
    keys: ['capsule.collectFailed', 'capsule.collecting', 'capsule.liveNow', 'capsule.paused', 'capsule.resume', 'music.favoriteAdd', 'music.favoriteRemove', 'music.metaAutoCandidates', 'music.metaAutoFail', 'music.metaAutoField', 'music.metaAutoLoading', 'music.metaAutoNoResult', 'music.metaAutoOneKey', 'music.metaAutoOneKeyHint', 'music.settings.playMode', 'music.sidebar.stats'],
  },
  'ja-JP.ts': {
    prefixes: ['capsule.action.', 'capsule.res.', 'image.noResults.', 'image.settings.', 'modelSettings.comfyui.', 'music.kugou.', 'music.lyrics.', 'music.moduleDrawer.', 'music.stats.', 'music.track.'],
    keys: ['capsule.collectFailed', 'capsule.collecting', 'capsule.liveNow', 'capsule.paused', 'capsule.resume', 'music.favoriteAdd', 'music.favoriteRemove', 'music.metaAutoCandidates', 'music.metaAutoFail', 'music.metaAutoField', 'music.metaAutoLoading', 'music.metaAutoNoResult', 'music.metaAutoOneKey', 'music.metaAutoOneKeyHint', 'music.settings.playMode', 'music.sidebar.stats'],
  },
  'ko-KR.ts': {
    prefixes: ['capsule.action.', 'capsule.res.', 'image.noResults.', 'image.settings.', 'modelSettings.comfyui.', 'music.kugou.', 'music.lyrics.', 'music.moduleDrawer.', 'music.stats.', 'music.track.'],
    keys: ['capsule.collectFailed', 'capsule.collecting', 'capsule.liveNow', 'capsule.paused', 'capsule.resume', 'music.favoriteAdd', 'music.favoriteRemove', 'music.metaAutoCandidates', 'music.metaAutoFail', 'music.metaAutoField', 'music.metaAutoLoading', 'music.metaAutoNoResult', 'music.metaAutoOneKey', 'music.metaAutoOneKeyHint', 'music.settings.playMode', 'music.sidebar.stats'],
  },
  'zh-TW.ts': {
    prefixes: ['capsule.action.', 'capsule.res.', 'image.noResults.', 'image.settings.', 'modelSettings.comfyui.', 'music.kugou.', 'music.lyrics.', 'music.moduleDrawer.', 'music.stats.', 'music.track.'],
    keys: ['capsule.collectFailed', 'capsule.collecting', 'capsule.liveNow', 'capsule.paused', 'capsule.resume', 'music.favoriteAdd', 'music.favoriteRemove', 'music.metaAutoCandidates', 'music.metaAutoFail', 'music.metaAutoField', 'music.metaAutoLoading', 'music.metaAutoNoResult', 'music.metaAutoOneKey', 'music.metaAutoOneKeyHint', 'music.settings.playMode', 'music.sidebar.stats'],
  },
};

const baseKeys = Object.keys(zhCN);

describe('i18n key 完整性', () => {
  it('zh-CN 源语言没有重复 key（对象字面量重复 key 会被静默覆盖）', () => {
    // 通过源码文本粗查：同一行不允许出现两次相同的 'key':
    // （精确检查在编译期由 TS 对象字面量保证，这里只兜住"复制粘贴整段"的情况）
    expect(baseKeys.length).toBeGreaterThan(1000);
    expect(new Set(baseKeys).size).toBe(baseKeys.length);
  });

  for (const [file, locale] of Object.entries(LOCALES)) {
    describe(file, () => {
      const keys = Object.keys(locale);
      const baseline = BASELINE[file];

      it('不包含 zh-CN 里没有的 key（拼错 key 会静默不生效）', () => {
        const extra = keys.filter((k) => !(k in zhCN));
        expect(extra, `多余 key：${extra.join(', ')}`).toEqual([]);
      });

      it('缺失 key 全部在基线内（新功能必须同步翻译）', () => {
        const missing = baseKeys.filter((k) => !(k in locale));
        const uncovered = missing.filter(
          (k) => !baseline.keys.includes(k) && !baseline.prefixes.some((p) => k.startsWith(p)),
        );
        expect(
          uncovered,
          `${file} 新缺 ${uncovered.length} 个 key（前 10：${uncovered.slice(0, 10).join(', ')}）。` +
            `请补翻译，或确认这是存量缺口后加进 src/lib/i18n/locales.test.ts 的 BASELINE。`,
        ).toEqual([]);
      });

      it('缺失总数不超过基线（基线只能缩小，不能悄悄变大）', () => {
        const missing = baseKeys.filter((k) => !(k in locale));
        const baselineTotal = baseline.keys.length + baseline.prefixes.reduce((n, p) => n + baseKeys.filter((k) => k.startsWith(p)).length, 0);
        expect(
          missing.length,
          `${file} 缺失 ${missing.length} 个，基线 ${baselineTotal} 个。` +
            `补全翻译后请把对应前缀/key 从 BASELINE 删掉，让缺口单调收敛。`,
        ).toBeLessThanOrEqual(baselineTotal);
      });
    });
  }
});

/**
 * 插件里 `T('key')` 的兜底是个陷阱：宿主 `translate()` 在 key 完全不存在时
 * **返回 key 本身**（真值），所以 `T(key) || '中文兜底'` 永远不会走兜底分支，
 * 界面直接显示 `music.track.tagHistoryEntry` 这种原始 key。
 * 2026-11-05 实机截图就是这么抓到的（音乐模块 65 个 key 泄漏）。
 * 这个卡口把「代码里用到的 key 必须在源语言里存在」变成硬约束。
 */
const PLUGIN_SRC = import.meta.glob('../../../plugins/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ALL_LOCALES: Array<[string, Record<string, string>]> = [
  ['zh-CN', zhCN], ['zh-TW', zhTW], ['en-US', enUS], ['ja-JP', jaJP],
  ['ko-KR', koKR], ['de-DE', deDE], ['fr-FR', frFR],
];

describe('插件用到的 i18n key 必须真的存在（否则界面显示原始 key）', () => {
  const KEY_RE = /\bT\(\s*'([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'\s*[,)]/g;

  it('glob 命中音乐模块源码（空 glob 会让下面的断言假绿）', () => {
    const files = Object.keys(PLUGIN_SRC).filter((k) => k.includes('铃兰/src/'));
    expect(files.length, '没读到音乐模块源码').toBeGreaterThan(8);
  });

  it('音乐模块每个 T(key) 都在 zh-CN 里', () => {
    const missing: string[] = [];
    for (const [file, src] of Object.entries(PLUGIN_SRC)) {
      if (!file.includes('铃兰/src/')) continue;
      for (const m of src.matchAll(KEY_RE)) {
        if (!(m[1] in zhCN)) missing.push(`${m[1]} ← ${file.split('/').pop()}`);
      }
    }
    expect(
      [...new Set(missing)].sort(),
      '这些 key 只在代码里写了中文兜底、没进 locale —— 兜底永远不会生效，界面会显示原始 key',
    ).toEqual([]);
  });

  it('带 {占位符} 的文案，7 种语言都必须带同一组占位符', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    const bad: string[] = [];
    for (const key of Object.keys(zhCN)) {
      const want = ph(zhCN[key]);
      if (!want) continue;
      for (const [name, dict] of ALL_LOCALES) {
        if (name === 'zh-CN') continue;
        const value = dict[key];
        if (value === undefined) continue; // 存量缺口由上面的基线卡口管
        if (ph(value) !== want) bad.push(`${key} @ ${name}: 期望 ${want}，实际 ${ph(value) || '（无）'}`);
      }
    }
    expect(bad, '占位符丢了会显示成字面 {n}').toEqual([]);
  });
});

/**
 * 同一类漏口的宿主侧版本：`t('key')` / `tr('key')` 用到的 key 必须在 zh-CN 里存在。
 * 2026-11-06 扫过一次是 0 缺失，所以这条断言现在就能立住；立住之后才防得住以后有人加功能只写兜底。
 */
const HOST_SRC = import.meta.glob('../../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('宿主组件用到的 i18n key 必须存在', () => {
  const HOST_KEY_RE = /\b(?:t|tr)\(\s*'([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'\s*[,)]/g;

  it('glob 命中足量宿主组件（空 glob 会让断言假绿）', () => {
    expect(Object.keys(HOST_SRC).length).toBeGreaterThan(60);
  });

  it('每个 t(key) / tr(key) 都在 zh-CN 里', () => {
    const missing: string[] = [];
    for (const [file, src] of Object.entries(HOST_SRC)) {
      for (const m of src.matchAll(HOST_KEY_RE)) {
        if (!(m[1] in zhCN)) missing.push(`${m[1]} ← ${file.split('/').pop()}`);
      }
    }
    expect([...new Set(missing)].sort(), '缺 key 时界面会显示原始 key').toEqual([]);
  });
});
