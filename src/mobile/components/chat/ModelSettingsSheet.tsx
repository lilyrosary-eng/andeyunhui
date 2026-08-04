// 模型设置面板（移动端）—— 照抄 Windows 版 ModelSettings 的核心项。
//
// 桌面版功能很多（供应商预设一键填充 / 档案列表 / 编辑表单 / 高级参数 / 人设风格 /
// 测试连接 / 充值入口）。移动端 BottomSheet 空间有限，取最常用的子集：
//   1. 供应商预设（DeepSeek / OpenAI / 通义 / 智谱 / Ollama）一键填充端点与模型联想
//   2. 档案列表：选中 = 设为当前算力来源，编辑 / 删除
//   3. 编辑表单：名称 / Base URL / API Key / 模型 / 视觉模型 / 高级参数（temperature、
//      max_tokens、top_p、system_prompt）
//   4. 新增档案入口
//
// 数据来源：ChatScreen 传入 profiles + 变更回调（ai.saveProfiles 持久化到 Rust）。

import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Check, ChevronDown, SlidersHorizontal, PlugZap, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { BottomSheet } from '../BottomSheet';
import type { AiProfile } from '../../types/chat';



/** 与桌面 ModelSettings.tsx 保持一致的供应商预设 */
const PROVIDERS: { id: string; name: string; base_url: string; models: string[]; visionModels: string[] }[] = [
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'], visionModels: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'gpt-5.6'], visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5.6'] },
  { id: 'qwen', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-3.5-plus', 'qwen2.5-coder-32b-instruct', 'qwen3-coder-plus'], visionModels: ['qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct', 'qwen2.5-vl-32b-instruct'] },
  { id: 'zhipu', name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-5.1', 'glm-5.2'], visionModels: ['glm-4v-plus', 'glm-4v', 'glm-4v-flash'] },
  { id: 'ollama', name: 'Ollama (local)', base_url: 'http://localhost:11434/v1', models: ['llama3', 'qwen2.5', 'codellama', 'deepseek-coder'], visionModels: ['llava', 'llama3.2-vision', 'qwen2.5vl:7b'] },
];

function uid(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

interface Props {
  open: boolean;
  onClose: () => void;
  profiles: AiProfile[];
  /** 当前选中的 profile id（用于标记选中态） */
  currentProfileId: string | null;
  /** 档案列表变化（新增/编辑/删除后调用持久化） */
  onProfilesChange: (next: AiProfile[]) => void;
  /** 选择某档案作为当前算力来源 */
  onSelect: (p: AiProfile) => void;
}

type View = 'list' | 'edit';

interface Form {
  id?: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  vision_model: string;
  image_model: string;
  tts_model: string;
  temperature: string;
  max_tokens: string;
  top_p: string;
  system_prompt: string;
  persona_call_me_as: string;
  persona_preset: string;
  persona_style: string;
}

const EMPTY_FORM: Form = {
  name: '', base_url: '', api_key: '', model: '', vision_model: '',
  image_model: '', tts_model: '',
  temperature: '', max_tokens: '', top_p: '', system_prompt: '',
  persona_call_me_as: '', persona_preset: '', persona_style: '',
};

function formFromProfile(p: AiProfile): Form {
  return {
    id: p.id,
    name: p.name || '',
    base_url: p.base_url || '',
    api_key: p.api_key || '',
    model: p.model || '',
    vision_model: p.vision_model || '',
    image_model: p.image_model || '',
    tts_model: p.tts_model || '',
    temperature: p.temperature != null ? String(p.temperature) : '',
    max_tokens: p.max_tokens != null ? String(p.max_tokens) : '',
    top_p: p.top_p != null ? String(p.top_p) : '',
    system_prompt: p.system_prompt || '',
    persona_call_me_as: p.persona_call_me_as || '',
    persona_preset: p.persona_preset || '',
    persona_style: p.persona_style || '',
  };
}

export function ModelSettingsSheet({ open, onClose, profiles, currentProfileId, onProfilesChange, onSelect }: Props) {
  const [view, setView] = useState<View>('list');
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [selectedProvider, setSelectedProvider] = useState('');
  // 高级参数折叠（人设永远可见在最上方，高级参数默认收起）
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 测试连接
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const currentProfile = useMemo(
    () => profiles.find((p) => p.id === currentProfileId) ?? null,
    [profiles, currentProfileId],
  );

  const startNew = () => {
    setForm(EMPTY_FORM);
    setSelectedProvider('');
    setView('edit');
  };

  const startEdit = (p: AiProfile) => {
    setForm(formFromProfile(p));
    setSelectedProvider('');
    setView('edit');
  };

  const applyProvider = (id: string) => {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    setSelectedProvider(id);
    setForm((f) => ({
      ...f,
      base_url: p.base_url,
      // 填充模型联想建议：只有用户还没填模型时才填充
      model: f.model || (p.models[0] ?? ''),
      vision_model: f.vision_model || (p.visionModels[0] ?? ''),
    }));
  };

  const save = () => {
    const base_url = form.base_url.trim();
    const model = form.model.trim();
    if (!base_url || !model) return;

    const num = (s: string): number | undefined => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : undefined;
    };

    const profile: AiProfile = {
      id: form.id || uid('p_'),
      name: form.name.trim() || model,
      base_url,
      api_key: form.api_key.trim(),
      model,
      vision_model: form.vision_model.trim() || null,
      image_model: form.image_model.trim() || null,
      tts_model: form.tts_model.trim() || null,
      temperature: num(form.temperature),
      max_tokens: num(form.max_tokens),
      top_p: num(form.top_p),
      system_prompt: form.system_prompt.trim() || null,
      // 人设已统一收敛到「伴侣」（移动端不暴露，避免与伴侣人格冲突）。
      // 这里强制清空 persona 三字段：后端 compose_persona_system 合成出空串，
      // 移动端 AI 对话场景下「伴侣人格」是 system 注入的唯一来源。
      // Windows 桌面仍可独立编辑 persona（不在本端处理）。
      persona_call_me_as: null,
      persona_preset: null,
      persona_style: null,
    };

    const exists = profiles.some((p) => p.id === profile.id);
    const next = exists
      ? profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...profiles, profile];
    onProfilesChange(next);
    setView('list');
  };

  const remove = (id: string) => {
    onProfilesChange(profiles.filter((p) => p.id !== id));
    setView('list');
  };

  /** 测试当前表单的连接（复用后端 ai_test_connection，不先保存） */
  const testConnection = async () => {
    if (testing) return;
    if (!form.base_url.trim() || !form.model.trim()) {
      setTestResult({ ok: false, msg: '请先填写 Base URL 与模型' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const cfg: AiProfile = {
        id: form.id || 'test',
        name: form.name.trim() || form.model.trim(),
        base_url: form.base_url.trim(),
        api_key: form.api_key.trim(),
        model: form.model.trim(),
        vision_model: form.vision_model.trim() || null,
        image_model: form.image_model.trim() || null,
        tts_model: form.tts_model.trim() || null,
        temperature: undefined,
        max_tokens: undefined,
        top_p: undefined,
        system_prompt: null,
        persona_call_me_as: null,
        persona_preset: null,
        persona_style: null,
      };
      const msg = await invoke<string>('ai_test_connection', { config: cfg });
      setTestResult({ ok: true, msg: msg || '连接成功' });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e).slice(0, 120) });
    } finally {
      setTesting(false);
    }
  };

  const field = (label: string, value: string, onChange: (v: string) => void, placeholder?: string, password?: boolean) => (
    <label className="block">
      <span className="block text-[var(--muted-foreground)] mb-1" style={{ fontSize: 'var(--m-text-caption)' }}>
        {label}
      </span>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
        style={{ fontSize: 'var(--m-text-body)' }}
      />
    </label>
  );

  return (
    <BottomSheet
      open={open}
      onClose={() => { setView('list'); onClose(); }}
      title={view === 'list' ? '模型设置' : form.id ? '编辑算力来源' : '新增算力来源'}
    >
      <div className="px-4 pb-5 flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
        {view === 'list' ? (
          <>
            {/* 当前选中档案摘要 */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--input)]/40 px-3 py-2.5">
              <div className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                当前算力来源
              </div>
              <div className="text-[var(--foreground)] font-medium truncate" style={{ fontSize: 'var(--m-text-body)' }}>
                {currentProfile ? `${currentProfile.name} · ${currentProfile.model}` : '未配置'}
              </div>
            </div>

            {/* 档案列表 */}
            {profiles.map((p) => {
              const active = p.id === currentProfileId;
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--input)]/40 px-3 py-2.5 active:opacity-70"
                >
                  <button
                    type="button"
                    onClick={() => { onSelect(p); onClose(); }}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex items-center gap-1.5 text-[var(--foreground)] font-medium truncate" style={{ fontSize: 'var(--m-text-body)' }}>
                      {active && <Check size={14} className="shrink-0 text-[var(--element-bg)]" />}
                      <span className="truncate">{p.name || p.model}</span>
                    </div>
                    <div className="text-[var(--muted-foreground)] truncate" style={{ fontSize: 'var(--m-text-caption)' }}>
                      {p.model} · {p.base_url}
                    </div>
                  </button>
                  <button type="button" onClick={() => startEdit(p)} className="shrink-0 p-2 text-[var(--muted-foreground)] active:scale-90 transition-transform">
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(p.id)}
                    className="shrink-0 p-2 text-[var(--danger)] active:scale-90 transition-transform"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}

            {/* 新增档案 */}
            <button
              type="button"
              onClick={startNew}
              className="flex items-center justify-center gap-2 rounded-xl py-2.5 font-medium border border-dashed border-[var(--border)] text-[var(--element-bg)] active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)' }}
            >
              <Plus size={18} /> 新增算力来源
            </button>
          </>
        ) : (
          <>
            {/* 供应商预设（一键填充） */}
            <div>
              <span className="block text-[var(--muted-foreground)] mb-1.5" style={{ fontSize: 'var(--m-text-caption)' }}>
                供应商预设
              </span>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyProvider(p.id)}
                    className="rounded-full px-3 py-1.5 border active:scale-95 transition-transform"
                    style={{
                      fontSize: 'var(--m-text-caption)',
                      borderColor: selectedProvider === p.id ? 'var(--element-bg)' : 'var(--border)',
                      color: selectedProvider === p.id ? 'var(--element-bg)' : 'var(--foreground)',
                      background: selectedProvider === p.id ? 'var(--element-muted)' : 'transparent',
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                选择供应商后自动填充端点与模型建议，可再手动修改。
              </p>
            </div>

            {field('名称（可选）', form.name, (v) => setForm((f) => ({ ...f, name: v })), '如：DeepSeek')}
            {field('Base URL', form.base_url, (v) => setForm((f) => ({ ...f, base_url: v })), 'https://api.deepseek.com/v1')}
            {field('API Key', form.api_key, (v) => setForm((f) => ({ ...f, api_key: v })), 'sk-…', true)}
            {field('模型', form.model, (v) => setForm((f) => ({ ...f, model: v })), 'deepseek-chat')}
            {field('视觉模型（可选，OCR/识图）', form.vision_model, (v) => setForm((f) => ({ ...f, vision_model: v })), 'deepseek-v4-flash')}
            {field('图片生成模型（可选，AI 发图）', form.image_model, (v) => setForm((f) => ({ ...f, image_model: v })), 'dall-e-3 或通义万相等')}
            {field('语音模型（可选，AI 播报）', form.tts_model, (v) => setForm((f) => ({ ...f, tts_model: v })), 'tts-1 等')}

            {/* 人设已并入「伴侣」：提示引导，避免设置分散 */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--input)]/30 px-3 py-3">
              <p className="text-[var(--foreground)] font-medium" style={{ fontSize: 'var(--m-text-label)' }}>
                人设与风格
              </p>
              <p className="mt-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                性格、背景、口头禅、称呼等已在「伴侣」里统一设置（点 AI 对话页顶部伴侣卡）。
                这里只负责模型连接参数。
              </p>
            </div>

            {/* 高级参数（默认折叠） */}
            <div className="rounded-xl border border-[var(--border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className="w-full flex items-center justify-between px-3 py-3 text-left active:bg-[var(--muted)]/60 transition-colors"
              >
                <span className="flex items-center gap-2 font-medium text-[var(--foreground)]" style={{ fontSize: 'var(--m-text-label)' }}>
                  <SlidersHorizontal size={16} className="text-[var(--muted-foreground)]" />
                  高级参数
                </span>
                <ChevronDown
                  size={18}
                  className="text-[var(--muted-foreground)] transition-transform duration-200"
                  style={{ transform: advancedOpen ? 'rotate(180deg)' : 'none' }}
                />
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 flex flex-col gap-3">
                  {field('Temperature', form.temperature, (v) => setForm((f) => ({ ...f, temperature: v })), '0.7')}
                  {field('Max Tokens', form.max_tokens, (v) => setForm((f) => ({ ...f, max_tokens: v })), '4096')}
                  {field('Top P', form.top_p, (v) => setForm((f) => ({ ...f, top_p: v })), '1.0')}
                  <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                    留空表示使用供应商默认值。
                  </p>
                </div>
              )}
            </div>

            {/* 测试连接 */}
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testing}
              className="flex items-center justify-center gap-2 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--element-bg)] active:scale-[0.98] transition-transform disabled:opacity-60"
              style={{ fontSize: 'var(--m-text-label)' }}
            >
              {testing ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <p
                className="rounded-lg px-3 py-2"
                style={{
                  fontSize: 'var(--m-text-caption)',
                  color: testResult.ok ? 'var(--element-bg)' : 'var(--danger)',
                  background: testResult.ok ? 'var(--element-muted)' : 'var(--muted)/40',
                }}
              >
                {testResult.ok ? `✓ ${testResult.msg}` : `✗ ${testResult.msg}`}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setView('list')}
                className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
                style={{ fontSize: 'var(--m-text-label)' }}
              >
                返回
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!form.base_url.trim() || !form.model.trim()}
                className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform disabled:opacity-50"
                style={{ fontSize: 'var(--m-text-label)', background: 'var(--element-bg)', color: 'var(--element-fg)' }}
              >
                保存
              </button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
