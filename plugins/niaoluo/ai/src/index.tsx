/// <reference path="../../../global.d.ts" />
// 茑萝 · IDE · AI 编程 子插件（Cursor / Claude Code 风格）
//
// 多级嵌套：niaoluo（茑萝）→ ide（IDE）→ ai（AI 编程）。本插件是 IDE 的子插件，
// 由 IDE 主组件在内部以「AI 编程」视图渲染，不单独出现在导航栏。
// 定位：AI「编程」功能属于「IDE」子集（本插件），但 AI「能力」本身属于全局——
// LLM 调用统一走 Rust 后端命令 ai_chat / ai_get_config / ai_set_config（沙箱屏蔽了 fetch，
// 且配置全局持久化，任意插件都可复用同一份 AI 能力）。
//
// 能力：多轮流式对话、附加项目文件作为上下文、代码块一键复制 / 保存为文件、
//       OpenAI 兼容端点配置（可对接 DeepSeek / OpenAI / Moonshot / 本地 Ollama 等）。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useRef, useEffect, useCallback } = React;

interface AiConfig {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens?: number | null;
  top_p?: number | null;
  system_prompt?: string | null;
}

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface CtxFile {
  path: string;
  name: string;
  content: string;
}

const DEFAULT_CONFIG: AiConfig = {
  base_url: 'https://api.deepseek.com/v1',
  api_key: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  max_tokens: null,
  top_p: null,
  system_prompt: null,
};

const MAX_CTX_CHARS = 20000;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// 解析助手回复中的 ``` 代码块（流式未闭合时按纯文本渲染，闭合后转代码块）
type Part = { type: 'text'; value: string } | { type: 'code'; lang: string; value: string };
function parseContent(text: string): Part[] {
  const parts: Part[] = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || '', value: m[2] });
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

function CodeBlock({ lang, value }: { lang: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await hostApi.invoke('clipboard_write', { text: value });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 忽略复制失败 */ }
  };
  const saveAs = async () => {
    try {
      const ext = lang && /^[a-z0-9]+$/i.test(lang) ? lang : 'txt';
      const dest = await hostApi.invoke<string | null>('pick_save_file', { defaultName: `snippet.${ext}` });
      if (dest) await hostApi.invoke('write_text_file', { path: dest, content: value });
    } catch { /* 忽略保存失败 */ }
  };
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-black/20 bg-[#1e1e1e]">
      <div className="flex items-center justify-between px-3 py-1 bg-[#252526] text-[11px] text-neutral-400">
        <span>{lang || 'code'}</span>
        <div className="flex items-center gap-2">
          <button onClick={copy} className="hover:text-white transition-colors">{copied ? '已复制' : '复制'}</button>
          <button onClick={saveAs} className="hover:text-white transition-colors">保存</button>
        </div>
      </div>
      <pre className="px-3 py-2 text-xs text-[#d4d4d4] overflow-x-auto whitespace-pre"><code>{value}</code></pre>
    </div>
  );
}

function AiPanel({ docked, onClose }: { docked?: boolean; onClose?: () => void }) {
  const [config, setConfig] = useState<AiConfig>(DEFAULT_CONFIG);
  const [showConfig, setShowConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [ctxFiles, setCtxFiles] = useState<CtxFile[]>([]);
  const [busy, setBusy] = useState(false);

  const activeReq = useRef<string | null>(null);
  const assistantId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 加载全局 AI 配置；未配置 key 时默认展开配置区引导填写
  useEffect(() => {
    hostApi.invoke<AiConfig>('ai_get_config')
      .then((c) => {
        if (c) setConfig({ ...DEFAULT_CONFIG, ...c });
        if (!c || !c.api_key || !c.api_key.trim()) setShowConfig(true);
      })
      .catch(() => setShowConfig(true));
  }, []);

  // 注册流式事件监听（全局事件，用 requestId 区分本次请求）
  useEffect(() => {
    let un1: (() => void) | null = null;
    let un2: (() => void) | null = null;
    let un3: (() => void) | null = null;
    const append = (delta: string) => {
      const aid = assistantId.current;
      if (!aid) return;
      setMessages((prev) => prev.map((m) => (m.id === aid ? { ...m, content: m.content + delta } : m)));
    };
    const finish = (err?: string) => {
      const aid = assistantId.current;
      setBusy(false);
      activeReq.current = null;
      if (aid) {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== aid) return m;
          if (err) return { ...m, streaming: false, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ ' + err };
          return { ...m, streaming: false };
        }));
      }
      assistantId.current = null;
    };
    hostApi.listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
      if (e.payload.requestId === activeReq.current) append(e.payload.delta);
    }).then((u) => { un1 = u; });
    hostApi.listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId === activeReq.current) finish();
    }).then((u) => { un2 = u; });
    hostApi.listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId === activeReq.current) finish(e.payload.error);
    }).then((u) => { un3 = u; });
    return () => { un1?.(); un2?.(); un3?.(); };
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const saveConfig = useCallback(async () => {
    try {
      await hostApi.invoke('ai_set_config', { config });
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 1500);
    } catch (e) {
      console.error('[AI] 保存配置失败:', e);
    }
  }, [config]);

  const addContextFile = useCallback(async () => {
    try {
      const files = await hostApi.invoke<string[]>('pick_file', {
        filters: [{ name: '代码/文本', extensions: ['js','ts','tsx','jsx','json','py','rs','go','html','htm','css','scss','md','txt','log','vue','c','cpp','java','sh','toml','yaml','yml'] }],
      });
      if (!files || files.length === 0) return;
      const p = files[0];
      let content = await hostApi.invoke<string>('read_text_file', { path: p });
      if (content.length > MAX_CTX_CHARS) content = content.slice(0, MAX_CTX_CHARS) + '\n...(已截断)';
      setCtxFiles((prev) => [...prev.filter((f) => f.path !== p), { path: p, name: baseName(p), content }]);
    } catch (e) {
      console.error('[AI] 添加上下文文件失败:', e);
    }
  }, []);

  const buildSystemPrompt = useCallback((): string => {
    let sys = (config.system_prompt && config.system_prompt.trim())
      ? config.system_prompt.trim()
      : '你是一名资深编程助手，风格类似 Cursor / Claude Code。请用简体中文回答；给出代码时放在 ``` 代码块中并标注语言，必要时简述改动理由与关键点。';
    if (ctxFiles.length > 0) {
      sys += '\n\n以下是用户提供的项目文件作为上下文，请结合它们回答：\n';
      for (const f of ctxFiles) {
        sys += `\n### 文件：${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n`;
      }
    }
    return sys;
  }, [config.system_prompt, ctxFiles]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!config.api_key.trim()) {
      setShowConfig(true);
      return;
    }
    const userMsg: Msg = { id: 'u_' + Date.now().toString(36), role: 'user', content: text };
    const aid = 'a_' + Date.now().toString(36);
    const asstMsg: Msg = { id: aid, role: 'assistant', content: '', streaming: true };
    const history = messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
      { role: 'user', content: text },
    ];
    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setInput('');
    setBusy(true);
    const reqId = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    activeReq.current = reqId;
    assistantId.current = aid;
    try {
      await hostApi.invoke('ai_chat', { requestId: reqId, messages: payload });
    } catch (e) {
      // 后端已通过 ai-error 事件反馈，这里兜底
      if (activeReq.current === reqId) {
        setBusy(false);
        activeReq.current = null;
        setMessages((prev) => prev.map((m) => (m.id === aid ? { ...m, streaming: false, error: true, content: '⚠ ' + String(e) } : m)));
        assistantId.current = null;
      }
    }
  }, [input, busy, config, messages, buildSystemPrompt]);

  const clearChat = useCallback(() => {
    if (busy) return;
    setMessages([]);
  }, [busy]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  const inputCls = 'w-full px-2.5 py-1.5 rounded-lg text-sm bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)]';

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <span className="text-sm font-medium">AI 编程</span>
        <span className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">{config.model}</span>
        <span className="flex-1" />
        <button onClick={clearChat} className="btn-press px-2 py-1 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">清空</button>
        <button onClick={() => setShowConfig((s) => !s)} className="btn-press px-2 py-1 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">设置</button>
        {onClose && (
          <button onClick={onClose} className="btn-press px-2 py-1 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-red-500/80 hover:text-white transition-colors" title="收起 AI 面板">✕</button>
        )}
      </div>

      {/* 配置区 */}
      {showConfig && (
        <div className="px-3 py-3 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0 space-y-2 bg-white/60 dark:bg-stone-800/40">
          <div>
            <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1">API 端点（OpenAI 兼容，含 /v1）</label>
            <input className={inputCls} value={config.base_url} placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setConfig((c) => ({ ...c, base_url: e.target.value }))} />
          </div>
          <div>
            <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1">API Key（仅保存在本机）</label>
            <input className={inputCls} type="password" value={config.api_key} placeholder="sk-..."
              onChange={(e) => setConfig((c) => ({ ...c, api_key: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1">模型</label>
              <input className={inputCls} value={config.model} placeholder="deepseek-chat"
                onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))} />
            </div>
            <div className="w-28">
              <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1">温度 {config.temperature.toFixed(1)}</label>
              <input type="range" min={0} max={2} step={0.1} value={config.temperature} className="w-full mt-2"
                onChange={(e) => setConfig((c) => ({ ...c, temperature: parseFloat(e.target.value) }))} />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={saveConfig} className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium element-primary hover:bg-[var(--element-hover)] transition-colors">保存配置</button>
            {configSaved && <span className="text-xs text-emerald-500">已保存</span>}
            <span className="flex-1" />
            <span className="text-[11px] text-neutral-400 dark:text-stone-500">支持 DeepSeek / OpenAI / Moonshot / Ollama 等</span>
          </div>
        </div>
      )}

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-neutral-400 dark:text-stone-500 gap-2">
            <div className="text-sm">开始与 AI 结对编程</div>
            <div className="text-xs max-w-xs">可先「添加文件」把代码作为上下文，再提问、让它解释、重构或生成代码。回复中的代码块可一键复制或保存。</div>
            {!config.api_key.trim() && <div className="text-xs text-amber-500 mt-1">尚未配置 API Key，请点右上角「设置」</div>}
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'element-primary'
                  : m.error
                    ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                    : 'bg-white dark:bg-stone-800 border border-neutral-200/60 dark:border-stone-700/60'
              }`}>
                {m.role === 'assistant' ? (
                  <div>
                    {parseContent(m.content).map((part, i) =>
                      part.type === 'code'
                        ? <CodeBlock key={i} lang={part.lang} value={part.value} />
                        : <span key={i} className="whitespace-pre-wrap break-words">{part.value}</span>,
                    )}
                    {m.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-[var(--element-bg)] animate-pulse" />}
                  </div>
                ) : (
                  <span className="whitespace-pre-wrap break-words">{m.content}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 上下文文件 chips */}
      {ctxFiles.length > 0 && (
        <div className="px-3 pt-2 flex flex-wrap gap-1.5 shrink-0">
          {ctxFiles.map((f) => (
            <span key={f.path} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-neutral-200/70 dark:bg-stone-700 text-neutral-600 dark:text-stone-300" title={f.path}>
              📄 {f.name}
              <button onClick={() => setCtxFiles((prev) => prev.filter((x) => x.path !== f.path))} className="hover:text-red-500">✕</button>
            </span>
          ))}
        </div>
      )}

      {/* 输入区 */}
      <div className="px-3 py-2 border-t border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <div className="flex items-end gap-2">
          <button onClick={addContextFile} title="添加文件作为上下文"
            className="btn-press shrink-0 px-2.5 py-2 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">＋ 文件</button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="向 AI 提问或让它写代码…（Ctrl/Cmd + Enter 发送）"
            className="flex-1 resize-none px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
          />
          <button onClick={send} disabled={busy || !input.trim()}
            className="btn-press shrink-0 px-4 py-2 rounded-lg text-sm font-medium element-primary hover:bg-[var(--element-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? '生成中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'ai',
  name: 'AI 编程',
  iconName: 'Bot',
  kind: 'module',
  visible: false,
  parent: 'ide',
  category: '开发',
  desc: 'AI 结对编程：多轮流式对话、附加文件上下文、代码一键复制/保存（OpenAI 兼容，可接 DeepSeek/OpenAI/Ollama）',
  component: AiPanel,
});
