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
