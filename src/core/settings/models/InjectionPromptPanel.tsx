// AI 编程 · 注入层提示词设置。
//
// 空白 = 只用内置默认规则（代码内置 + 数据根 rules/default_rules.md 覆盖）。
// 填写后与内置规则共同生效；冲突时以用户填写的内容为准 —— 该优先级由后端
// builtin_prompt() 写进提示词正文，不依赖模型自行判断。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Save, RotateCcw } from 'lucide-react';

export function InjectionPromptPanel() {
  const [defaultText, setDefaultText] = useState('');
  const [custom, setCustom] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<{ default?: string; custom?: string }>('adyh_prompt_get')
      .then((d) => {
        setDefaultText(d?.default || '');
        setCustom(d?.custom || '');
      })
      .catch((e) => console.warn('[settings] 读取注入层提示词失败:', e));
  }, []);

  const save = async (text: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await invoke('adyh_prompt_set', { custom: text });
      setMsg(text.trim() ? '已保存，新会话立即生效' : '已清空，只使用内置默认提示词');
    } catch (e) {
      console.error('[settings] 保存注入层提示词失败:', e);
      setMsg('保存失败：' + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 space-y-2">
      <div className="text-sm font-medium text-neutral-700 dark:text-stone-200">
        注入层提示词（AI 编程）
      </div>
      <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-stone-400">
        留空 = 只使用内置默认规则。填写后与内置规则共同生效；
        <span className="text-neutral-700 dark:text-stone-200">两者冲突时，以这里填写的为准</span>。
        保存后新会话立即生效。
      </p>
      <textarea
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        rows={6}
        placeholder="例如：本项目提交信息用中文；不要改 docs/ 下的设计稿；测试一律先跑 pnpm test。"
        className="w-full resize-y px-3 py-2 rounded-lg text-xs leading-relaxed bg-neutral-50 dark:bg-stone-950 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
        style={{ minHeight: 110, maxHeight: 240 }}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save(custom)}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-[var(--element-border)] text-white disabled:opacity-50"
        >
          <Save size={13} />保存并生效
        </button>
        <button
          onClick={() => { setCustom(''); void save(''); }}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800 disabled:opacity-50"
        >
          <RotateCcw size={13} />只使用内置
        </button>
        {msg && <span className="text-[11px] text-neutral-500 dark:text-stone-400">{msg}</span>}
      </div>
      <details>
        <summary className="text-[11px] text-neutral-400 dark:text-stone-500 cursor-pointer">
          查看内置默认规则
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-neutral-500 dark:text-stone-400 bg-neutral-50 dark:bg-stone-950 rounded-lg p-2">
          {defaultText || '（加载中…）'}
        </pre>
      </details>
    </div>
  );
}
