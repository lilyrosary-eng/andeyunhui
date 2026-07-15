import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Cpu, Server, KeyRound, Bot, SlidersHorizontal, TestTube2, Check, X,
  ChevronDown, ChevronUp, RotateCcw, Eye, EyeOff,
} from 'lucide-react';
import { logger } from '@/lib/logger';

interface AiConfigPayload {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number | null;
  top_p: number | null;
  system_prompt: string | null;
}

// 主流 OpenAI 兼容供应商预设（一键填充端点与推荐模型）
const PROVIDERS: { id: string; name: string; base_url: string; models: string[] }[] = [
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'o3-mini'] },
  { id: 'moonshot', name: 'Moonshot (Kimi)', base_url: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'qwen', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-coder-32b-instruct', 'qwen3-coder-plus'] },
  { id: 'zhipu', name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long'] },
  { id: 'ollama', name: 'Ollama (本地)', base_url: 'http://localhost:11434/v1', models: ['llama3', 'qwen2.5', 'codellama', 'deepseek-coder'] },
];

const DEFAULT_CONFIG: AiConfigPayload = {
  base_url: 'https://api.deepseek.com/v1',
  api_key: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  max_tokens: null,
  top_p: null,
  system_prompt: null,
};

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';

const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

export function ModelSettings() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CONFIG.base_url);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_CONFIG.model);
  const [temperature, setTemperature] = useState(0.3);
  const [maxTokens, setMaxTokens] = useState('');
  const [topP, setTopP] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [provider, setProvider] = useState('deepseek');

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 当前供应商推荐的模型列表（用于数据列表联想）
  const currentModels = PROVIDERS.find((p) => p.id === provider)?.models ?? [];

  // 启动时从 Rust 读取已保存的全局 AI 配置
  useEffect(() => {
    invoke<AiConfigPayload>('ai_get_config')
      .then((c) => {
        if (!c) return;
        setBaseUrl(c.base_url || DEFAULT_CONFIG.base_url);
        setApiKey(c.api_key || '');
        setModel(c.model || DEFAULT_CONFIG.model);
        setTemperature(typeof c.temperature === 'number' ? c.temperature : 0.3);
        setMaxTokens(c.max_tokens != null ? String(c.max_tokens) : '');
        setTopP(c.top_p != null ? String(c.top_p) : '');
        setSystemPrompt(c.system_prompt || '');
        const hit = PROVIDERS.find((p) => p.base_url === (c.base_url || '').trim());
        if (hit) setProvider(hit.id);
      })
      .catch((e) => console.warn('[模型] 读取配置失败:', e));
  }, []);

  const buildConfig = useCallback((): AiConfigPayload => ({
    base_url: baseUrl.trim(),
    api_key: apiKey.trim(),
    model: model.trim(),
    temperature,
    max_tokens: maxTokens.trim() ? Math.max(1, parseInt(maxTokens, 10) || 0) : null,
    top_p: topP.trim() ? Math.min(1, Math.max(0, parseFloat(topP) || 0)) : null,
    system_prompt: systemPrompt.trim() ? systemPrompt.trim() : null,
  }), [baseUrl, apiKey, model, temperature, maxTokens, topP, systemPrompt]);

  const triggerSaved = useCallback(() => {
    setSavedAt(true);
    setTimeout(() => setSavedAt(false), 1800);
  }, []);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) {
      setTestMsg({ ok: false, text: '请先填写 API Key 再保存' });
      return;
    }
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      setTestMsg({ ok: false, text: 'API 端点应以 http:// 或 https:// 开头' });
      return;
    }
    setSaving(true);
    try {
      await invoke('ai_set_config', { config: buildConfig() });
      triggerSaved();
      setTestMsg(null);
    } catch (e) {
      setTestMsg({ ok: false, text: '保存失败：' + String(e) });
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, buildConfig, model, triggerSaved]);

  const handleTest = useCallback(async () => {
    if (!apiKey.trim()) {
      setTestMsg({ ok: false, text: '请先填写 API Key' });
      return;
    }
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      setTestMsg({ ok: false, text: 'API 端点应以 http:// 或 https:// 开头' });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await invoke<string>('ai_test_connection', { config: buildConfig() });
      setTestMsg({ ok: true, text: res });
    } catch (e) {
      setTestMsg({ ok: false, text: '连接失败：' + String(e) });
    } finally {
      setTesting(false);
    }
  }, [apiKey, baseUrl, buildConfig]);

  const selectProvider = useCallback((id: string) => {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    setProvider(id);
    setBaseUrl(p.base_url);
    if (!model.trim() || PROVIDERS.some((x) => x.models.includes(model))) {
      setModel(p.models[0]);
    }
  }, [model]);

  const resetDefaults = useCallback(() => {
    setBaseUrl(DEFAULT_CONFIG.base_url);
    setApiKey('');
    setModel(DEFAULT_CONFIG.model);
    setTemperature(DEFAULT_CONFIG.temperature);
    setMaxTokens('');
    setTopP('');
    setSystemPrompt('');
    setProvider('deepseek');
    setTestMsg(null);
  }, []);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
          <Cpu size={14} />
          AI 模型配置（全局能力 · 供 AI 编程调用）
        </h2>
        <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
          对接任意 OpenAI 兼容端点（DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / 本地 Ollama）。
          配置保存在本机，任意插件均可复用同一份 AI 能力。
        </p>

        <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
          {/* 供应商预设 */}
          <div className="p-4">
            <label className={labelCls}>供应商预设</label>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProvider(p.id)}
                  className={`btn-press h-12 rounded-lg border text-sm font-medium transition-all ${
                    provider === p.id
                      ? 'element-muted border-[var(--element-border)]'
                      : 'bg-white dark:bg-stone-900 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* API 端点 */}
          <div className="p-4">
            <label className={labelCls}><Server size={12} className="inline mr-1" />API 端点（OpenAI 兼容，含 /v1）</label>
            <input
              className={inputCls}
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* API Key */}
          <div className="p-4">
            <label className={labelCls}><KeyRound size={12} className="inline mr-1" />API Key（仅保存在本机）</label>
            <div className="relative">
              <input
                className={`${inputCls} pr-10`}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                placeholder="sk-..."
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200 transition-colors"
                title={showKey ? '隐藏' : '显示'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* 模型 + 温度 */}
          <div className="p-4 space-y-4">
            <div>
              <label className={labelCls}><Bot size={12} className="inline mr-1" />模型名称</label>
              <input
                className={inputCls}
                list="ai-model-suggestions"
                value={model}
                placeholder="deepseek-chat"
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="ai-model-suggestions">
                {currentModels.map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className={labelCls}>采样温度（Temperature）</label>
                <span className="text-xs text-neutral-500 dark:text-stone-400">{temperature.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-[var(--element-color-raw)]"
              />
              <p className="text-[11px] text-neutral-400 dark:text-stone-500 mt-1">越低越稳定精准（编程建议 0~0.5），越高越发散有创意。</p>
            </div>
          </div>

          {/* 高级参数 */}
          <div>
            <div
              onClick={() => setAdvancedOpen((o) => !o)}
              className="w-full flex justify-between items-center p-4 cursor-pointer hover:bg-neutral-50 dark:hover:bg-stone-700/40 transition-colors"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setAdvancedOpen((o) => !o); }}
            >
              <span className="text-sm font-medium text-neutral-700 dark:text-stone-200 flex items-center gap-1.5">
                <SlidersHorizontal size={14} />高级参数
              </span>
              {advancedOpen ? <ChevronUp size={16} className="text-neutral-400 dark:text-stone-500" /> : <ChevronDown size={16} className="text-neutral-400 dark:text-stone-500" />}
            </div>
            {advancedOpen && (
              <div className="px-4 pb-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>最大 Token（max_tokens）</label>
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      value={maxTokens}
                      placeholder="留空=模型默认"
                      onChange={(e) => setMaxTokens(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>核采样（top_p，0~1）</label>
                    <input
                      className={inputCls}
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={topP}
                      placeholder="留空=模型默认"
                      onChange={(e) => setTopP(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>系统提示词（system prompt）</label>
                  <textarea
                    className={`${inputCls} resize-none`}
                    rows={3}
                    value={systemPrompt}
                    placeholder="留空使用内置助手人设；填写后作为对话 base 指令（AI 编程会在此基础上附加上下文文件）"
                    onChange={(e) => setSystemPrompt(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 操作区：测试 / 保存 / 重置 */}
          <div className="p-4 flex flex-wrap items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testing}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <TestTube2 size={14} />{testing ? '测试中…' : '测试连接'}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-press px-4 py-1.5 rounded-lg text-xs font-medium element-primary hover:bg-[var(--element-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中…' : '保存配置'}
            </button>
            <button
              onClick={resetDefaults}
              className="btn-press px-3 py-1.5 rounded-lg text-xs bg-neutral-100 dark:bg-stone-700 text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors flex items-center gap-1.5"
              title="恢复默认"
            >
              <RotateCcw size={14} />重置
            </button>
            {savedAt && (
              <span className="text-xs text-emerald-500 flex items-center gap-1"><Check size={13} />已保存</span>
            )}
            {testMsg && (
              <span className={`text-xs flex items-center gap-1 ${testMsg.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                {testMsg.ok ? <Check size={13} /> : <X size={13} />}{testMsg.text}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default ModelSettings;
