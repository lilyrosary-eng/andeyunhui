import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Cpu, Server, KeyRound, Bot, SlidersHorizontal, TestTube2, Check, X, Plus,
  ChevronDown, ChevronUp, RotateCcw, Eye, EyeOff, Trash2, Star,
} from 'lucide-react';

// ============ 模型档案（前端编辑态） ============
interface ProfileUi {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: string;
  top_p: string;
  system_prompt: string;
}

// 主流 OpenAI 兼容供应商预设（一键填充端点与推荐模型）
const PROVIDERS: { id: string; name: string; base_url: string; models: string[] }[] = [
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'o3-mini'] },
  { id: 'custom', name: '自定义', base_url: '', models: [] },
  { id: 'qwen', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-coder-32b-instruct', 'qwen3-coder-plus'] },
  { id: 'zhipu', name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long'] },
  { id: 'ollama', name: 'Ollama (本地)', base_url: 'http://localhost:11434/v1', models: ['llama3', 'qwen2.5', 'codellama', 'deepseek-coder'] },
];

// 所有供应商模型聚合，作为模型名输入的联想建议
const ALL_MODELS = Array.from(new Set(PROVIDERS.flatMap((p) => p.models)));

function defaultProfile(name = 'DeepSeek'): ProfileUi {
  const p = PROVIDERS.find((x) => x.name === name) || PROVIDERS[0];
  return {
    id: 'p_' + Math.random().toString(36).slice(2, 8),
    name: p.name,
    base_url: p.base_url,
    api_key: '',
    model: p.models[0] || '',
    temperature: 0.3,
    max_tokens: '',
    top_p: '',
    system_prompt: '',
  };
}

function fromPayload(p: any): ProfileUi {
  return {
    id: p.id || 'p_' + Math.random().toString(36).slice(2, 8),
    name: p.name || '',
    base_url: p.base_url || '',
    api_key: p.api_key || '',
    model: p.model || '',
    temperature: typeof p.temperature === 'number' ? p.temperature : 0.3,
    max_tokens: p.max_tokens != null ? String(p.max_tokens) : '',
    top_p: p.top_p != null ? String(p.top_p) : '',
    system_prompt: p.system_prompt || '',
  };
}

function toPayload(p: ProfileUi) {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    api_key: p.api_key,
    model: p.model,
    temperature: p.temperature,
    max_tokens: p.max_tokens.trim() ? Math.max(1, parseInt(p.max_tokens, 10) || 0) : null,
    top_p: p.top_p.trim() ? Math.min(1, Math.max(0, parseFloat(p.top_p) || 0)) : null,
    system_prompt: p.system_prompt.trim() ? p.system_prompt.trim() : null,
  };
}

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';

const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

export function ModelSettings() {
  const [profiles, setProfiles] = useState<ProfileUi[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const editProfile = profiles.find((p) => p.id === editId) || null;

  // 启动时从 Rust 读取已保存的全部模型档案（兼容旧版单配置自动升级为单档案）
  useEffect(() => {
    invoke<{ profiles: any[]; active: string | null }>('ai_get_profiles')
      .then((data) => {
        const list = (data.profiles || []).map(fromPayload);
        setProfiles(list);
        if (list.length === 0) {
          // 未配置任何模型：不预置假档案，直接展示空状态，引导用户「添加模型档案」
          setActiveId(null);
          setEditId(null);
        } else {
          const act = data.active && list.some((p) => p.id === data.active) ? data.active : list[0].id;
          setActiveId(act);
          setEditId(list[0].id);
        }
      })
      .catch((e) => {
        console.warn('[模型] 读取配置失败:', e);
        const d = defaultProfile();
        setProfiles([d]);
        setActiveId(d.id);
        setEditId(d.id);
      });
  }, []);

  const updateProfile = useCallback((id: string, patch: Partial<ProfileUi>) => {
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const triggerSaved = useCallback(() => {
    setSavedAt(true);
    setTimeout(() => setSavedAt(false), 1800);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await invoke('ai_set_profiles', {
        payload: { profiles: profiles.map(toPayload), active: activeId },
      });
      triggerSaved();
      setTestMsg(null);
    } catch (e) {
      setTestMsg({ ok: false, text: '保存失败：' + String(e) });
    } finally {
      setSaving(false);
    }
  }, [profiles, activeId, triggerSaved]);

  const handleTest = useCallback(async () => {
    if (!editProfile) return;
    if (!editProfile.api_key.trim()) {
      setTestMsg({ ok: false, text: '请先填写 API Key' });
      return;
    }
    if (!/^https?:\/\//.test(editProfile.base_url.trim())) {
      setTestMsg({ ok: false, text: 'API 端点应以 http:// 或 https:// 开头' });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await invoke<string>('ai_test_connection', { config: toPayload(editProfile) });
      setTestMsg({ ok: true, text: res });
    } catch (e) {
      setTestMsg({ ok: false, text: '连接失败：' + String(e) });
    } finally {
      setTesting(false);
    }
  }, [editProfile]);

  // 供应商预设一键填充到「当前编辑档案」
  const selectProvider = useCallback((id: string) => {
    if (!editProfile) return;
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    updateProfile(editProfile.id, {
      name: p.id === 'custom' ? '' : p.name,
      base_url: p.base_url,
      model: p.models[0] || editProfile.model,
    });
  }, [editProfile, updateProfile]);

  const addProfile = useCallback(() => {
    const np = defaultProfile('OpenAI');
    setProfiles((prev) => [...prev, np]);
    setEditId(np.id);
  }, []);

  const deleteProfile = useCallback((id: string) => {
    setProfiles((prev) => {
      const next = prev.filter((p) => p.id !== id);
      if (next.length === 0) {
        const d = defaultProfile();
        setActiveId(d.id);
        setEditId(d.id);
        return [d];
      }
      if (activeId === id) setActiveId(next[0].id);
      if (editId === id) setEditId(next[0].id);
      return next;
    });
  }, [activeId, editId]);

  const resetDefaults = useCallback(() => {
    if (!editProfile) return;
    const d = defaultProfile(editProfile.name || 'DeepSeek');
    updateProfile(editProfile.id, {
      base_url: d.base_url,
      api_key: '',
      model: d.model,
      temperature: d.temperature,
      max_tokens: '',
      top_p: '',
      system_prompt: '',
    });
    setTestMsg(null);
  }, [editProfile, updateProfile]);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
          <Cpu size={14} />
          AI 模型配置（全局能力 · 供 AI 编程调用）
        </h2>
        <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
          可配置多份模型档案（DeepSeek / OpenAI / 通义 / 智谱 / 本地 Ollama 或自定义），
          「已配置模型」下会按你实际配置的数量显示（配置几个显示几个）。IDE 等任意模块都能在对话旁的下拉框中直接选用。
        </p>

        <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
          {/* 已配置模型（预设列表：配置几个显示几个） */}
          <div className="p-4">
            <label className={labelCls}>已配置模型（{profiles.length}）</label>
            <div className="space-y-2">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setEditId(p.id)}
                  className={`group flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                    editId === p.id
                      ? 'element-muted border-[var(--element-border)]'
                      : 'bg-white dark:bg-stone-900 border-neutral-200/50 dark:border-stone-600/50 hover:bg-neutral-50 dark:hover:bg-stone-700'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate flex items-center gap-1.5">
                      {p.name || p.model || '未命名模型'}
                      {activeId === p.id && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500">
                          <Star size={11} className="fill-amber-500" />默认
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                      {p.model || p.base_url || '未填写端点'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {activeId !== p.id && (
                      <button
                        onClick={() => setActiveId(p.id)}
                        className="btn-press px-2 py-1 rounded-md text-[11px] bg-neutral-100 dark:bg-stone-700 text-neutral-600 dark:text-stone-300 hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors"
                        title="设为默认"
                      >
                        设为默认
                      </button>
                    )}
                    <button
                      onClick={() => deleteProfile(p.id)}
                      className="btn-press p-1.5 rounded-md text-neutral-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {profiles.length === 0 && (
              <div className="text-xs text-neutral-400 dark:text-stone-500 py-1">尚未配置任何模型，点击下方「添加模型档案」开始。</div>
            )}
            <button
              onClick={addProfile}
              className="btn-press mt-2 w-full py-2 rounded-lg border border-dashed border-neutral-300 dark:border-stone-600 text-xs text-neutral-500 dark:text-stone-400 hover:bg-neutral-50 dark:hover:bg-stone-700/50 transition-colors flex items-center justify-center gap-1.5"
            >
              <Plus size={14} />添加模型档案
            </button>
          </div>

          {/* 当前编辑档案的详情（供应商预设 + 字段） */}
          {editProfile && (
            <>
              {/* 供应商预设 */}
              <div className="p-4">
                <label className={labelCls}>供应商预设（一键填充当前档案）</label>
                <div className="grid grid-cols-3 gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => selectProvider(p.id)}
                      className={`btn-press h-12 rounded-lg border text-sm font-medium transition-all ${
                        editProfile.name === p.name
                          ? 'element-muted border-[var(--element-border)]'
                          : 'bg-white dark:bg-stone-900 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* 显示名 */}
              <div className="p-4">
                <label className={labelCls}>模型显示名（下拉框展示，如「我的 DeepSeek」）</label>
                <input
                  className={inputCls}
                  value={editProfile.name}
                  placeholder="DeepSeek"
                  onChange={(e) => updateProfile(editProfile.id, { name: e.target.value })}
                />
              </div>

              {/* API 端点 */}
              <div className="p-4">
                <label className={labelCls}><Server size={12} className="inline mr-1" />API 端点（OpenAI 兼容，含 /v1）</label>
                <input
                  className={inputCls}
                  value={editProfile.base_url}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => updateProfile(editProfile.id, { base_url: e.target.value })}
                />
              </div>

              {/* API Key */}
              <div className="p-4">
                <label className={labelCls}><KeyRound size={12} className="inline mr-1" />API Key（仅保存在本机）</label>
                <div className="relative">
                  <input
                    className={`${inputCls} pr-10`}
                    type={showKey ? 'text' : 'password'}
                    value={editProfile.api_key}
                    placeholder="sk-..."
                    autoComplete="off"
                    onChange={(e) => updateProfile(editProfile.id, { api_key: e.target.value })}
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
                    value={editProfile.model}
                    placeholder="deepseek-chat"
                    onChange={(e) => updateProfile(editProfile.id, { model: e.target.value })}
                  />
                  <datalist id="ai-model-suggestions">
                    {ALL_MODELS.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className={labelCls}>采样温度（Temperature）</label>
                    <span className="text-xs text-neutral-500 dark:text-stone-400">{editProfile.temperature.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={editProfile.temperature}
                    onChange={(e) => updateProfile(editProfile.id, { temperature: parseFloat(e.target.value) })}
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
                          value={editProfile.max_tokens}
                          placeholder="留空=模型默认"
                          onChange={(e) => updateProfile(editProfile.id, { max_tokens: e.target.value })}
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
                          value={editProfile.top_p}
                          placeholder="留空=模型默认"
                          onChange={(e) => updateProfile(editProfile.id, { top_p: e.target.value })}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>系统提示词（system prompt）</label>
                      <textarea
                        className={`${inputCls} resize-none`}
                        rows={3}
                        value={editProfile.system_prompt}
                        placeholder="留空使用内置助手人设；填写后作为对话 base 指令（AI 编程会在此基础上附加上下文文件）"
                        onChange={(e) => updateProfile(editProfile.id, { system_prompt: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

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
              {saving ? '保存中…' : '保存全部'}
            </button>
            <button
              onClick={resetDefaults}
              className="btn-press px-3 py-1.5 rounded-lg text-xs bg-neutral-100 dark:bg-stone-700 text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors flex items-center gap-1.5"
              title="恢复当前档案默认"
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
