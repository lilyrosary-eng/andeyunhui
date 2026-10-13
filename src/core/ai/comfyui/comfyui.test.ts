/**
 * 移植自 dsh-comfyui（https://github.com/fandc520/dsh-comfyui，MIT License，见 ../LICENSE-dsh-comfyui）
 * 用例改编自其 scripts/test-convert.mjs（覆盖 GitHub issue #8/#10 回归），并扩充：
 *   - Reroute 直通重接（原套件未覆盖）
 *   - 未注册 UI-only 节点内联值（原套件未覆盖）
 *   - params 分析/应用全链路（合成工作流 + __fixtures__/krea-wf.fixture.json 真实工作流）
 * krea-wf.fixture.json 同源移植自 dsh-comfyui 仓库根目录 krea-wf.json（MIT）。
 */
import { describe, it, expect } from 'vitest'
// 真实工作流 fixture（API 格式，Qwen-Image 12 节点），同源移植自 dsh-comfyui 仓库 krea-wf.json（MIT）
import kreaWorkflow from './__fixtures__/krea-wf.fixture.json'
import { normalizeLinks, resolveVirtualLinks } from './graph'
import { convertGraphToApi, flattenDynamicCombos } from './convert'
import {
  analyzeWorkflowParameters,
  applyWorkflowParameters,
  numberSpecOf,
  inputOptions,
  refreshParameterMetadata,
  type WorkflowParameter,
} from './params'

/* ============ 假 object_info（沿用原套件的最小节点集） ============ */
const objectInfo = {
  Src: { input: { required: {} }, output: ['VIDEO'] },
  Mid: { input: { required: { video: ['VIDEO'] } }, output: ['VIDEO'] },
  Sink: { input: { required: { video: ['VIDEO'] } }, output: [] },
  SaveVideo: {
    input: {
      required: {
        video: ['VIDEO'],
        filename_prefix: ['STRING', {}],
        format: [['auto', 'mp4'], {}],
        codec: ['COMFY_DYNAMICCOMBO_V3', {
          options: [
            { key: 'auto', inputs: { required: {} } },
            { key: 'h264', inputs: { required: { crf: ['INT', {}] } } },
          ],
        }],
      },
    },
    output: [],
  },
}

/** 一个带一条输入连线和一个输出的节点 */
const node = (id: number, type: string, opts: {
  inputLink?: number | null; outLinks?: number[]; mode?: number; order?: number; widgets?: unknown[];
} = {}) => ({
  id,
  type,
  mode: opts.mode ?? 0,
  order: opts.order ?? id,
  inputs: opts.inputLink === undefined ? [] : [{ name: 'video', type: 'VIDEO', link: opts.inputLink }],
  outputs: [{ name: 'VIDEO', type: 'VIDEO', links: opts.outLinks ?? [] }],
  ...(opts.widgets !== undefined ? { widgets_values: opts.widgets } : {}),
})
const link = (id: number, from: number, to: number, fromSlot = 0, toSlot = 0) =>
  [id, from, fromSlot, to, toSlot, 'VIDEO'] as const

/* ============ graph.ts ============ */

describe('graph: normalizeLinks', () => {
  it('接受旧版位置数组与 v0.4 对象条目两种链接格式', () => {
    const legacy = normalizeLinks([[1, 2, 0, 3, 0, 'VIDEO']])
    expect(legacy).toEqual([[1, 2, 0, 3, 0, 'VIDEO']])
    const v04 = normalizeLinks([{ id: 1, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0, type: 'VIDEO' }])
    expect(v04).toEqual([[1, 2, 0, 3, 0, 'VIDEO']])
  })

  it('跳过不可读条目', () => {
    expect(normalizeLinks([[1, 2], 'x', null, { id: 'nope' }])).toEqual([])
    expect(normalizeLinks('not-array')).toEqual([])
  })
})

/* ============ convert.ts ============ */

describe('convert: DynamicCombo V3 与 bypass（issue #10/#8）', () => {
  // Src(1) → Mid(2, mode 4 绕过) → SaveVideo(3)
  const saveGraph = {
    nodes: [
      { id: 1, type: 'Src', mode: 0, inputs: [], outputs: [{ links: [10] }], widgets_values: [] },
      { id: 2, type: 'Mid', mode: 4, inputs: [{ name: 'video', link: 10 }], outputs: [{ links: [11] }] },
      {
        id: 3, type: 'SaveVideo', mode: 0,
        inputs: [
          { name: 'video', link: 11 },
          { name: 'filename_prefix', widget: { name: 'filename_prefix' }, link: null },
          { name: 'format', widget: { name: 'format' }, link: null },
          { name: 'codec', widget: { name: 'codec' }, link: null },
        ],
        outputs: [],
        widgets_values: ['video/x', 'auto', 'auto'],
      },
    ],
    links: [link(10, 1, 2), link(11, 2, 3)],
  }

  it('bypass 直通 + DynamicCombo 保持扁平：video 引用穿透到 Src，codec 为 auto', () => {
    const result = convertGraphToApi(saveGraph, objectInfo, { includeNodeIds: new Set([1, 3]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workflow['3'].inputs.video).toEqual(['1', 0])
    expect(result.workflow['3'].inputs.codec).toBe('auto')
    expect(result.workflow['3'].inputs.filename_prefix).toBe('video/x')
  })

  it('DynamicCombo 取值不在可选项内 → 提取时报错', () => {
    const bad = structuredClone(saveGraph)
    ;(bad.nodes[2] as { widgets_values: unknown[] }).widgets_values = ['video/x', 'auto', 'nope']
    const result = convertGraphToApi(bad, objectInfo)
    expect(result.ok).toBe(false)
  })

  it('引用不在提取节点集内 → 报错（而非运行时才炸）', () => {
    const result = convertGraphToApi(saveGraph, objectInfo, { includeNodeIds: new Set([3]) })
    expect(result.ok).toBe(false)
  })

  it('legacy { key, inputs } 包裹的 DynamicCombo 值被摊平', () => {
    const flat = flattenDynamicCombos({
      3: { class_type: 'SaveVideo', inputs: { codec: { key: 'h264', inputs: { crf: 20 } }, format: 'auto' } },
    })
    expect(flat['3'].inputs).toEqual({ codec: 'h264', 'codec.crf': 20, format: 'auto' })
    const untouched = { 1: { class_type: 'X', inputs: { a: 1 } } }
    expect(flattenDynamicCombos(untouched)).toBe(untouched)
  })
})

describe('convert: KJNodes Set/Get 无线连接（issue #8）', () => {
  it('消费者直接接到 setter 的源头，虚拟节点不出现在结果里', () => {
    const graph = {
      nodes: [
        node(1, 'Src', { outLinks: [20] }),
        node(2, 'SetNode', { inputLink: 20, widgets: ['clip'] }),
        node(3, 'GetNode', { outLinks: [21], widgets: ['clip'] }),
        node(4, 'Sink', { inputLink: 21 }),
      ],
      links: [link(20, 1, 2), link(21, 3, 4)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.workflow).sort()).toEqual(['1', '4'])
    expect(result.workflow['4'].inputs.video).toEqual(['1', 0])
  })

  it('同名多个 setter 按 order 取 getter 之前最近的一个', () => {
    const graph = {
      nodes: [
        node(1, 'Src', { outLinks: [30], order: 1 }),
        node(2, 'SetNode', { inputLink: 30, widgets: ['v'], order: 2 }),
        node(5, 'Src', { outLinks: [31], order: 5 }),
        node(6, 'SetNode', { inputLink: 31, widgets: ['v'], order: 6 }),
        node(7, 'GetNode', { outLinks: [32], widgets: ['v'], order: 7 }),
        node(8, 'Sink', { inputLink: 32, order: 8 }),
        node(3, 'GetNode', { outLinks: [33], widgets: ['v'], order: 3 }),
        node(4, 'Sink', { inputLink: 33, order: 4 }),
      ],
      links: [link(30, 1, 2), link(31, 5, 6), link(32, 7, 8), link(33, 3, 4)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workflow['8'].inputs.video).toEqual(['5', 0])
    expect(result.workflow['4'].inputs.video).toEqual(['1', 0])
  })

  it('setter 由另一个 getter 喂养时链式穿透', () => {
    const graph = {
      nodes: [
        node(1, 'Src', { outLinks: [40] }),
        node(2, 'SetNode', { inputLink: 40, widgets: ['a'] }),
        node(3, 'GetNode', { outLinks: [41], widgets: ['a'] }),
        node(4, 'SetNode', { inputLink: 41, widgets: ['b'] }),
        node(5, 'GetNode', { outLinks: [42], widgets: ['b'] }),
        node(6, 'Sink', { inputLink: 42 }),
      ],
      links: [link(40, 1, 2), link(41, 3, 4), link(42, 5, 6)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workflow['6'].inputs.video).toEqual(['1', 0])
  })

  it('setter 的直通输出解析到它的输入', () => {
    const graph = {
      nodes: [
        node(1, 'Src', { outLinks: [50] }),
        node(2, 'SetNode', { inputLink: 50, outLinks: [51], widgets: ['x'] }),
        node(3, 'Sink', { inputLink: 51 }),
      ],
      links: [link(50, 1, 2), link(51, 2, 3)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workflow['3'].inputs.video).toEqual(['1', 0])
  })

  it('getter 没有对应 setter → 消费者必需输入未接线，报错', () => {
    const graph = {
      nodes: [
        node(3, 'GetNode', { outLinks: [60], widgets: ['missing'] }),
        node(4, 'Mid', { inputLink: 60 }),
      ],
      links: [link(60, 3, 4)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/video/)
  })
})

describe('convert: rgthree Relay/Repeater 模式链接（issue #8）', () => {
  it('模式链接被丢弃、数据流保持，两条流不合并', () => {
    const graph = {
      nodes: [
        node(1, 'Src', { outLinks: [70] }),
        { ...node(2, 'Sink', { inputLink: 70 }), outputs: [{ name: 'OPT_CONNECTION', links: [71] }] },
        { id: 3, type: 'Mute / Bypass Repeater (rgthree)', mode: 0, inputs: [{ name: '', link: 71 }], outputs: [{ name: 'OPT_CONNECTION', links: [72] }] },
        { id: 4, type: 'Mute / Bypass Relay (rgthree)', mode: 0, inputs: [{ name: '', link: 72 }], outputs: [{ name: 'OPT_CONNECTION', links: [73] }] },
        node(6, 'Src', { outLinks: [74] }),
        { ...node(5, 'Sink', { inputLink: 74 }), inputs: [{ name: 'video', link: 74 }, { name: 'mode', link: 73 }] },
      ],
      links: [link(70, 1, 2), link(71, 2, 3), link(72, 3, 4), link(73, 4, 5, 0, 1), link(74, 6, 5)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.workflow).sort()).toEqual(['1', '2', '5', '6'])
    expect(result.workflow['5'].inputs).toEqual({ video: ['6', 0] })
  })
})

describe('convert: Reroute 直通与未注册节点内联（原套件未覆盖，本次补充）', () => {
  it('Reroute 节点被跳过、连线重接到真实源头', () => {
    const graph = {
      nodes: [
        node(1, 'Src', { outLinks: [80] }),
        { id: 2, type: 'Reroute', mode: 0, inputs: [{ name: '', link: 80 }], outputs: [{ name: 'VIDEO', links: [81] }] },
        node(3, 'Sink', { inputLink: 81 }),
      ],
      links: [link(80, 1, 2), link(81, 2, 3)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.workflow).sort()).toEqual(['1', '3'])
    expect(result.workflow['3'].inputs.video).toEqual(['1', 0])
  })

  it('未注册节点且输出被消费 → 按设计硬错（fail-loud，不静默丢链）', () => {
    const graph = {
      nodes: [
        node(1, 'MysteryUI', { outLinks: [90], widgets: ['hello'] }),
        node(2, 'Sink', { inputLink: 90 }),
      ],
      links: [link(90, 1, 2)],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/未注册/)
  })

  it('子图节点明确拒绝', () => {
    const graph = {
      nodes: [{ id: 1, type: 'workflow/sub', mode: 0, inputs: [], outputs: [] }],
      links: [],
    }
    const result = convertGraphToApi(graph, objectInfo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/子图/)
  })
})

/* ============ params.ts ============ */

/** 合成 SD 式工作流 + object_info（CLIP 正负提示 / 尺寸 / KSampler） */
const sdObjectInfo = {
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd.safetensors'], {}] } } },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512, min: 16, max: 8192, step: 8 }], height: ['INT', { default: 512, min: 16, max: 8192, step: 8 }], batch_size: ['INT', { default: 1, min: 1, max: 4096 }] } },
  },
  KSampler: {
    input: {
      required: {
        seed: ['INT', { default: 0, min: 0, max: 2 ** 53, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8, min: 0, max: 100 }],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m'], {}],
        model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
      },
    },
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } } },
}
const sdWorkflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['2', 0] } },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd.safetensors' } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  '4': {
    class_type: 'KSampler',
    inputs: {
      model: ['2', 0], positive: ['1', 0], negative: ['5', 0], latent_image: ['3', 0],
      seed: 123, control_after_generate: 'fixed', steps: 20, cfg: 8,
      sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    },
  },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['2', 0] } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['2', 0] } },
  '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
}

describe('params: analyzeWorkflowParameters', () => {
  it('合成工作流：正负提示 + 宽高 + steps + seed（seed 标记 random）', () => {
    // 顺序说明：暴露顺序沿节点输入键序——真实 ComfyUI 的 KSampler UI 里 seed 在 steps 之前，
    // 故此处为 prompt,width,height,seed,steps,prompt_2（与源码注释的分类意图一致）。
    const params = analyzeWorkflowParameters(sdWorkflow, sdObjectInfo)
    expect(params.map((p) => p.name)).toEqual(['prompt', 'width', 'height', 'seed', 'steps', 'prompt_2'])
    const prompt = params[0]
    expect(prompt.nodeId).toBe('1')
    expect(prompt.default).toBe('a cat')
    expect(prompt.type).toBe('string')
    const seed = params.find((p) => p.name === 'seed')!
    expect(seed.random).toBe(true)
    expect(seed.numberKind).toBe('int')
    expect(seed.min).toBe(0)
    const width = params.find((p) => p.name === 'width')!
    expect(width.default).toBe(512)
    expect(width.min).toBe(16)
    expect(width.step).toBe(8)
  })

  it('无 object_info 时仍能识别保守参数集（numberKind 缺失）', () => {
    const params = analyzeWorkflowParameters(sdWorkflow)
    expect(params.map((p) => p.name)).toEqual(['prompt', 'width', 'height', 'seed', 'steps', 'prompt_2'])
    expect(params.find((p) => p.name === 'seed')!.numberKind).toBeUndefined()
  })

  it('真实 fixture（krea-wf，Qwen-Image 12 节点）：prompt 来自 PrimitiveStringMultiline', () => {
    const params = analyzeWorkflowParameters(kreaWorkflow)
    const names = params.map((p) => p.name)
    expect(names).toContain('prompt')
    expect(names).toContain('width')
    expect(names).toContain('height')
    expect(names).toContain('steps')
    expect(names).toContain('seed')
    const prompt = params.find((p) => p.name === 'prompt')!
    expect(prompt.nodeId).toBe('38') // PrimitiveStringMultiline 经 CLIPTextEncode 链接供电
    const width = params.find((p) => p.name === 'width')!
    expect(width.default).toBe(768)
    expect(width.nodeId).toBe('5')
  })
})

describe('params: applyWorkflowParameters', () => {
  const analyze = () => analyzeWorkflowParameters(sdWorkflow, sdObjectInfo)

  it('显式值写到对应节点、原工作流不变（structuredClone 语义）', () => {
    const before = structuredClone(sdWorkflow)
    const out = applyWorkflowParameters(sdWorkflow, analyze(), { prompt: 'a dog', width: 1024 })
    expect(out['1'].inputs.text).toBe('a dog')
    expect(out['3'].inputs.width).toBe(1024)
    expect(sdWorkflow).toEqual(before) // 输入未被变异
  })

  it('省略的 random seed 每次随机、显式 seed 优先', () => {
    const params = analyze()
    const out1 = applyWorkflowParameters(sdWorkflow, params, {})
    const out2 = applyWorkflowParameters(sdWorkflow, params, {})
    const s1 = out1['4'].inputs.seed as number
    const s2 = out2['4'].inputs.seed as number
    expect(s1).not.toBe(123)
    expect(s1).not.toBe(s2)
    const pinned = applyWorkflowParameters(sdWorkflow, params, { seed: 777 })
    expect(pinned['4'].inputs.seed).toBe(777)
  })

  it('省略的非 random 参数回落 default', () => {
    const out = applyWorkflowParameters(sdWorkflow, analyze(), {})
    expect(out['4'].inputs.steps).toBe(20)
  })

  it('INT 入参遇到小数四舍五入而非报错', () => {
    const out = applyWorkflowParameters(sdWorkflow, analyze(), { steps: 20.5 })
    expect(out['4'].inputs.steps).toBe(21)
  })

  it('布尔参数接受 "false"/0 等拼写并归一', () => {
    const params: WorkflowParameter[] = [{
      id: 'x', name: 'flag', label: '开关', type: 'boolean', nodeId: '4', inputKey: 'flag', default: true,
    }]
    const out = applyWorkflowParameters(sdWorkflow, params, { flag: 'false' })
    expect(out['4'].inputs.flag).toBe(false)
  })

  it('未知参数被忽略', () => {
    const out = applyWorkflowParameters(sdWorkflow, analyze(), { nonexistent: 'zzz' })
    expect(out['4'].inputs.seed).not.toBe('zzz')
  })

  it('options 白名单外的值抛错', () => {
    const params: WorkflowParameter[] = [{
      id: 'x', name: 'sampler', label: '采样器', type: 'string', nodeId: '4', inputKey: 'sampler_name',
      default: 'euler', options: ['euler', 'euler_ancestral', 'dpmpp_2m'],
    }]
    expect(() => applyWorkflowParameters(sdWorkflow, params, { sampler: 'nope' })).toThrow(/allowed options/)
    const ok = applyWorkflowParameters(sdWorkflow, params, { sampler: 'dpmpp_2m' })
    expect(ok['4'].inputs.sampler_name).toBe('dpmpp_2m')
  })
})

describe('params: numberSpecOf / inputOptions / refreshParameterMetadata', () => {
  it('联合类型 "INT,FLOAT" 判为 float；"INT:seed" 判为 int', () => {
    expect(numberSpecOf({ N: { input: { required: { v: ['INT,FLOAT', {}] } } } }, 'N', 'v')?.kind).toBe('float')
    expect(numberSpecOf({ N: { input: { required: { v: ['INT:seed', {}] } } } }, 'N', 'v')?.kind).toBe('int')
    expect(numberSpecOf({ N: { input: { required: { v: ['STRING', {}] } } } }, 'N', 'v')).toBeUndefined()
  })

  it('经典 COMBO 取选项数组；DynamicCombo V3 取 key 列表', () => {
    expect(inputOptions({ N: { input: { required: { v: [['a', 'b'], {}] } } } }, 'N', 'v')).toEqual(['a', 'b'])
    expect(inputOptions({
      N: { input: { required: { v: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto' }, { key: 'h264' }] }] } } },
    }, 'N', 'v')).toEqual(['auto', 'h264'])
  })

  it('refresh 只重算 object_info 派生字段、不动参数集', () => {
    const params = analyzeWorkflowParameters(sdWorkflow) // 无 object_info → 无 min/step
    expect(params.find((p) => p.name === 'width')!.min).toBeUndefined()
    const { parameters, changed } = refreshParameterMetadata(params, sdObjectInfo, sdWorkflow)
    expect(parameters).toHaveLength(params.length)
    expect(changed).toContain('width')
    expect(parameters.find((p) => p.name === 'width')!.min).toBe(16)
    expect(parameters.find((p) => p.name === 'prompt')!.default).toBe('a cat') // 非派生字段原样
  })
})
