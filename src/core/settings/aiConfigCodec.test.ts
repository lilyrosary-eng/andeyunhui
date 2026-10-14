import { describe, it, expect } from 'vitest';
import { effectiveEffort, emptyMediaModels, fromConfig, toConfig, type ConfigUi } from './aiConfigCodec';

const PAYLOAD = {
  providers: [
    {
      id: 'pv_1',
      name: '本地',
      base_url: 'http://127.0.0.1:11434/v1',
      api_key: 'sk-x',
      vision_model: 'qwen-vl',
      image_model: null,
      tts_model: null,
      last_scanned_at: 1700000000,
      models: [
        {
          id: 'p_aaa',
          model: 'qwen3:8b',
          label: null,
          caps: { text: true, vision: false, reasoning: true, embedding: false },
          context_tokens: 32768,
          overrides: {
            temperature: 0.5, max_tokens: 4096, top_p: 0.9,
            system_prompt: '你是助手', thinking: true,
            persona_call_me_as: '小云', persona_preset: 'gentle', persona_style: '',
            max_context_tokens: null,
          },
        },
        {
          id: 'p_bbb', model: 'llama3',
          label: null, caps: { text: true, vision: false, reasoning: false, embedding: false },
          context_tokens: null,
          overrides: { temperature: null, max_tokens: null, top_p: null, system_prompt: null,
            thinking: null, persona_call_me_as: null, persona_preset: null, persona_style: null,
            max_context_tokens: null },
        },
      ],
    },
  ],
  selection: { provider_id: 'pv_1', model_id: 'p_bbb' },
};

describe('fromConfig', () => {
  it('完整字段透传', () => {
    const c = fromConfig(PAYLOAD);
    expect(c.providers).toHaveLength(1);
    expect(c.providers[0].base_url).toBe('http://127.0.0.1:11434/v1');
    expect(c.providers[0].models).toHaveLength(2);
    expect(c.selected_model_id).toBe('p_bbb');
  });

  it('数字字段转字符串便于输入框编辑', () => {
    const m = fromConfig(PAYLOAD).providers[0].models[0];
    expect(m.temperature).toBe('0.5');
    expect(m.max_tokens).toBe('4096');
    expect(m.top_p).toBe('0.9');
    expect(m.context_tokens).toBe('32768');
  });

  it('null 字段转空串', () => {
    const m = fromConfig(PAYLOAD).providers[0].models[1];
    expect(m.temperature).toBe('');
    expect(m.max_tokens).toBe('');
    expect(m.system_prompt).toBe('');
    expect(m.context_tokens).toBe('');
  });

  it('供应商级 null 转空串', () => {
    const p = fromConfig(PAYLOAD).providers[0];
    expect(p.image_model).toBe('');
    expect(p.tts_model).toBe('');
    expect(p.vision_model).toBe('qwen-vl');
  });

  it('缺省：caps 默认 text=true', () => {
    const c = fromConfig({ providers: [{ id: 'p', models: [{ id: 'm', model: 'x' }] }] });
    expect(c.providers[0].models[0].caps.text).toBe(true);
    expect(c.providers[0].models[0].caps.vision).toBe(false);
  });

  it('空载荷不炸', () => {
    const c = fromConfig(undefined);
    expect(c.providers).toEqual([]);
    expect(c.selected_model_id).toBeNull();
  });
});

describe('toConfig', () => {
  it('往返编解码无损', () => {
    const c = fromConfig(PAYLOAD);
    const out = toConfig(c);
    expect(out.providers[0].models[0].model).toBe('qwen3:8b');
    expect(out.providers[0].models[0].overrides.temperature).toBeCloseTo(0.5);
    expect(out.providers[0].models[0].overrides.max_tokens).toBe(4096);
    expect(out.providers[0].models[0].caps.reasoning).toBe(true);
    expect(out.selection.model_id).toBe('p_bbb');
    expect(out.providers[0].last_scanned_at).toBe(1700000000);
  });

  it('空白字段转 null（temperature 除外：空回落 0.3）', () => {
    const c = fromConfig(PAYLOAD);
    const m = c.providers[0].models[1];
    const out = toConfig(c);
    // temperature 是特例：空 → 0.3 默认（与 ledger #3 / 实现注释一致，Test 12 覆盖）。
    // 这里只校验真正「空白→null」的字段，避免与 Test 12 互相否决。
    expect(out.providers[0].models[1].overrides.temperature).toBeCloseTo(0.3);
    expect(out.providers[0].models[1].overrides.system_prompt).toBeNull();
  });

  it('thinking 布尔直接透传', () => {
    const c = fromConfig(PAYLOAD);
    expect(toConfig(c).providers[0].models[0].overrides.thinking).toBe(true);
    expect(toConfig(c).providers[0].models[1].overrides.thinking).toBeNull();
  });

  it('max_tokens：0/负数归一到 1，非数字归 null', () => {
    const c = fromConfig(PAYLOAD);
    const d = toConfig(c);
    d.providers[0].models[0].overrides.max_tokens = 1;
    c.providers[0].models[0].max_tokens = '0';
    expect(toConfig(c).providers[0].models[0].overrides.max_tokens).toBe(1);
    // 非数字（如 'abc'）归 null 而非 1：null 让后端走自身默认；
    // 若归一到 1 会把输出硬限到 1 token，是灾难性配置。
    c.providers[0].models[0].max_tokens = 'abc';
    expect(toConfig(c).providers[0].models[0].overrides.max_tokens).toBeNull();
  });

  it('top_p clamp 到 [0,1]', () => {
    const c = fromConfig(PAYLOAD);
    c.providers[0].models[0].top_p = '2';
    expect(toConfig(c).providers[0].models[0].overrides.top_p).toBe(1);
    c.providers[0].models[0].top_p = '-1';
    expect(toConfig(c).providers[0].models[0].overrides.top_p).toBe(0);
  });

  it('temperature 缺省回落到 0.3', () => {
    const c = fromConfig(PAYLOAD);
    c.providers[0].models[1].temperature = '';
    expect(toConfig(c).providers[0].models[1].overrides.temperature).toBeCloseTo(0.3);
  });

  it('空配置可往返', () => {
    const empty: ConfigUi = { providers: [], selected_provider_id: null, selected_model_id: null, media_models: emptyMediaModels() };
    const out = toConfig(empty);
    expect(out.providers).toEqual([]);
    expect(out.selection).toEqual({ provider_id: null, model_id: null });
  });
});

describe('effectiveEffort —— 与后端 ResolvedTarget::effort 同口径', () => {
  const spec = (ids: string[], def: string | null) => ({
    efforts: ids.map((id) => ({ id, name: id })),
    default: def,
    from_provider: false,
  });

  it('显式档位优先于旧开关', () => {
    expect(effectiveEffort({ reasoning_effort: 'medium', thinking: false, reasoning: spec(['off', 'medium'], 'off') }))
      .toBe('medium');
  });

  it('旧开关 true 映射为 high（与改造前一致）', () => {
    expect(effectiveEffort({ reasoning_effort: '', thinking: true, reasoning: spec(['off', 'high'], 'off') }))
      .toBe('high');
  });

  it('都没有时用集合默认', () => {
    expect(effectiveEffort({ reasoning_effort: '', thinking: false, reasoning: spec(['off', 'medium'], 'medium') }))
      .toBe('medium');
  });

  it('没有集合信息时回落 off（老配置零回归）', () => {
    expect(effectiveEffort({ reasoning_effort: '', thinking: false, reasoning: spec([], null) })).toBe('off');
  });

  it('越界档位收敛到集合默认（避免发出端点不认的值）', () => {
    // 在 gpt-5 上设过 medium，切到只认 off/high 的模型
    expect(effectiveEffort({ reasoning_effort: 'medium', thinking: false, reasoning: spec(['off', 'high'], 'off') }))
      .toBe('off');
  });

  it('档位比较大小写不敏感', () => {
    expect(effectiveEffort({ reasoning_effort: 'HIGH', thinking: false, reasoning: spec(['off', 'high'], 'off') }))
      .toBe('high');
  });

  it('空集合时显式档位原样放行（兼容老配置）', () => {
    expect(effectiveEffort({ reasoning_effort: 'medium', thinking: false, reasoning: spec([], null) }))
      .toBe('medium');
  });
});

describe('视觉能力来源（caps.vision_source）', () => {
  /**
   * 这一组的存在理由：前端保存配置是**整体覆盖** caps 对象。若 codec 不带这个字段，
   * 用户每保存一次档案就会把探测/上报得到的 `provider` 抹成「未标注」，
   * 而「未标注」在 Rust 侧是「冻结且不启用原生直发」—— 等于探测白做。
   */
  const withVision = (vision_source: unknown) => fromConfig({
    providers: [{
      id: 'p1', name: 'X', base_url: 'https://x/v1', api_key: 'k',
      models: [{ id: 'm1', model: 'm', caps: { text: true, vision: true, vision_source } }],
    }],
    selection: {},
  });

  it('provider 往返后仍保留', () => {
    const ui = withVision('provider');
    expect(ui.providers[0].models[0].caps.vision_source).toBe('provider');
    const back = toConfig(ui);
    expect(back.providers[0].models[0].caps.vision_source).toBe('provider');
  });

  it('inferred 与 manual 同样往返保留', () => {
    for (const s of ['inferred', 'manual'] as const) {
      expect(toConfig(withVision(s)).providers[0].models[0].caps.vision_source).toBe(s);
    }
  });

  it('缺失来源归为未标注并落盘为 null', () => {
    const ui = withVision(undefined);
    expect(ui.providers[0].models[0].caps.vision_source).toBe('');
    // '' 若原样落盘会让 Rust 的 Option<CapsSource> 反序列化失败（整份配置存不了）
    expect(toConfig(ui).providers[0].models[0].caps.vision_source).toBeNull();
  });

  it('非法来源被归为未标注（不原样透传给后端）', () => {
    const ui = withVision('garbage');
    expect(ui.providers[0].models[0].caps.vision_source).toBe('');
    expect(toConfig(ui).providers[0].models[0].caps.vision_source).toBeNull();
  });
});
