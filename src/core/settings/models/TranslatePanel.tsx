// 翻译节点设置（设置 → 模型 → 翻译节点）。
//
// 与两个翻译工作区共用**同一份** localStorage 设置（`ts_translate_settings`），
// 不另设一套配置 —— 用户已经反复指出过「多个输入点对应一个功能」的问题。
//
// ★ 「测试」按钮是用户明确要的：**真发一次请求**，走与真实翻译完全相同的命令和路径，
// 显示 stage / 原始错误 / 实际端点 / 每一次兜底。失败不做分类改写、不做截断，
// 否则就是把「让用户猜」换个地方继续。

import { useState, useEffect } from 'react';
import { Languages, ChevronDown, Loader2, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';
import { TranslateModelPicker } from '@/components/TranslateModelPicker';
import {
  listAutoGlossary,
  deleteAutoGlossary,
  clearAutoGlossary,
  type GlossaryPair,
} from '@/lib/translateGlossary';
import {
  TRANSLATE_NODES,
  DEFAULT_TRANSLATE_CHAIN,
  loadTranslateSettings,
  saveTranslateSettings,
  translateSettingsFor,
  formatNotices,
  type TranslateSettings,
  type TranslateResult,
} from '@/lib/translateLanguages';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

interface TestOut {
  ok: boolean;
  lines: string[];
}

const inputCls =
  'w-full px-2 py-1.5 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white/60 dark:bg-stone-800/60 text-xs text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1';

export function TranslatePanel({ t }: { t: TFunc }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<TranslateSettings>(() => loadTranslateSettings());
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ node: string; out: TestOut } | null>(null);
  // 每次展开都重读：歌词翻译在插件里写这个键，两边不在同一个组件树上
  const [autoEntries, setAutoEntries] = useState<GlossaryPair[]>([]);
  useEffect(() => {
    if (open) setAutoEntries(listAutoGlossary());
  }, [open]);

  const save = (patch: Partial<TranslateSettings>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveTranslateSettings(next);
  };

  /** 真发一次请求。probe=true 会强制单节点、绕过缓存，测试结果不会被缓存命中掩盖。 */
  const testNode = async (id: string) => {
    setBusy(id);
    setResult(null);
    try {
      const r: TranslateResult = await api.translateText(
        'Hello, world!',
        '中文',
        'auto',
        translateSettingsFor(id, true),
      );
      const lines = [
        `[${r.stage ?? 'ok'}] ${r.detail ?? ''}`,
        r.via ? `via: ${r.via}` : '',
        `node: ${r.node}${r.detectedLang ? ` / detected: ${r.detectedLang}` : ''}`,
        r.text ? `text: ${r.text}` : '',
        formatNotices(r.notices),
      ].filter(Boolean);
      setResult({ node: id, out: { ok: true, lines } });
    } catch (e) {
      // Err 文本里已经带了 [节点/阶段] 原始错误 + 每一次兜底，原样显示
      setResult({ node: id, out: { ok: false, lines: [String(e)] } });
    } finally {
      setBusy(null);
    }
  };

  const chainText = cfg.chain?.length ? cfg.chain.join(', ') : DEFAULT_TRANSLATE_CHAIN.join(', ');

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-stone-700 px-3 py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-stone-300 hover:text-[var(--element-bg)]"
      >
        <Languages size={13} />
        {t('modelSettings.translate.title')}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <p className="text-[10px] text-neutral-400 dark:text-stone-500 mt-1">{t('modelSettings.translate.hint')}</p>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {/* 默认节点 */}
          <div>
            <label className={labelCls}>{t('modelSettings.translate.defaultNode')}</label>
            <select
              value={cfg.node || 'auto'}
              onChange={(e) => save({ node: e.target.value })}
              className={inputCls}
            >
              {TRANSLATE_NODES.map((n) => (
                <option key={n.id} value={n.id}>{n.label}</option>
              ))}
            </select>
            {/* 只要这条链会走到 AI（选了 ai 节点，或自动链里含 ai），就给一个模型选择。
                以前 profileId 这个字段后端在读、界面上却没人能填，翻译只能跟着对话模型走。 */}
            <TranslateModelPicker
              visible={
                (cfg.node || 'auto') === 'ai' ||
                (cfg.chain ?? DEFAULT_TRANSLATE_CHAIN).includes('ai')
              }
              value={cfg.profileId}
              onChange={(profileId) => save({ profileId })}
              label={t('translate.aiModel')}
              followLabel={t('translate.aiModelFollow')}
              emptyLabel={t('translate.aiModelNone')}
              staleLabel={t('translate.aiModelStale')}
              className="mt-2 text-xs text-neutral-500 dark:text-stone-400"
            />
          </div>

          {/* 自动链顺序 */}
          <div>
            <div className="flex items-center justify-between">
              <label className={labelCls}>{t('modelSettings.translate.chain')}</label>
              <button
                onClick={() => save({ chain: undefined })}
                className="flex items-center gap-1 text-[10px] text-neutral-400 hover:text-[var(--element-bg)] mb-1"
              >
                <RotateCcw size={10} /> {t('modelSettings.translate.resetChain')}
              </button>
            </div>
            <input
              className={`${inputCls} font-mono`}
              value={chainText}
              onChange={(e) => {
                const ids = e.target.value
                  .split(/[,，\s]+/)
                  .map((s) => s.trim())
                  .filter((s) => TRANSLATE_NODES.some((n) => n.id === s && s !== 'auto'));
                save({ chain: ids.length ? ids : undefined });
              }}
            />
            <p className="text-[10px] text-neutral-400 dark:text-stone-500 mt-1">
              {t('modelSettings.translate.chainHint')}
            </p>
          </div>

          {/* 缓存 */}
          <label className="flex items-center gap-2 text-[11px] text-neutral-600 dark:text-stone-300">
            <input
              type="checkbox"
              checked={cfg.cache !== false}
              onChange={(e) => save({ cache: e.target.checked })}
            />
            {t('modelSettings.translate.cache')}
          </label>

          {/* 凭证：字段名本身是专有名词（appid / appKey / auth_key），直接沿用，不做翻译 */}
          <div className="rounded-lg border border-dashed border-neutral-200 dark:border-stone-700 p-2">
            <div className="text-[11px] font-medium text-neutral-600 dark:text-stone-300 mb-1">
              {t('modelSettings.translate.credTitle')}
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-stone-500 mb-2">
              {t('modelSettings.translate.credHint')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['baiduAppId', '百度 appid'],
                ['baiduSecret', '百度 密钥'],
                ['youdaoAppKey', '有道 appKey'],
                ['youdaoSecret', '有道 密钥'],
                ['deeplKey', 'DeepL auth_key'],
                ['libreUrl', 'LibreTranslate Base URL'],
                ['libreKey', 'LibreTranslate api_key'],
              ] as const).map(([key, label]) => (
                <div key={key}>
                  <label className={labelCls}>{label}</label>
                  <input
                    className={inputCls}
                    type={key.toLowerCase().includes('secret') || key.toLowerCase().includes('key') ? 'password' : 'text'}
                    value={cfg[key] ?? ''}
                    onChange={(e) => save({ [key]: e.target.value })}
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 术语表 */}
          <div>
            <label className={labelCls}>
              {/* 开关关掉 = 本次翻译不注入术语表（已存的表内容不清空）。
                  不新增 i18n 键：这 7 个 locale 文件此刻正被另一条线改，且勾选框本身已表意。 */}
              <span className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={cfg.glossaryOn !== false}
                  onChange={(e) => save({ glossaryOn: e.target.checked })}
                />
                {t('modelSettings.translate.glossary')}
              </span>
            </label>
            <textarea
              className={`${inputCls} min-h-[56px] resize-y font-mono disabled:opacity-50`}
              value={cfg.glossary ?? ''}
              disabled={cfg.glossaryOn === false}
              onChange={(e) => save({ glossary: e.target.value })}
            />
            <p className="text-[10px] text-neutral-400 dark:text-stone-500 mt-1">
              {t('modelSettings.translate.glossaryHint')}
            </p>
            {/* 开关关掉时翻出来的整句会存到这里（不是上面那个框）：手写的词条和机器
                学来的混在一格，用户就没法判断哪行是自己定的、也删不干净。
                同样不新增 i18n 键，理由与上面的勾选框一致。 */}
            {autoEntries.length > 0 && (
              <div className="mt-1.5 rounded-lg border border-neutral-200 dark:border-stone-700 px-2 py-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-neutral-500 dark:text-stone-400">
                    自动学习 {autoEntries.length} 条（开着表时一起下发）
                  </span>
                  <button
                    type="button"
                    className="text-[10px] text-neutral-400 hover:text-red-500 dark:text-stone-500"
                    onClick={() => {
                      clearAutoGlossary();
                      setAutoEntries([]);
                    }}
                  >
                    清空
                  </button>
                </div>
                <ul className="mt-1 max-h-24 overflow-y-auto flex flex-col gap-0.5">
                  {autoEntries
                    .slice(-20)
                    .reverse()
                    .map((p) => (
                      <li key={p.src} className="flex items-start gap-1 text-[10px] font-mono">
                        <span className="flex-1 min-w-0 break-all text-neutral-600 dark:text-stone-300">
                          {p.src}
                          <span className="text-neutral-400"> = </span>
                          {p.dst}
                        </span>
                        <button
                          type="button"
                          className="text-neutral-400 hover:text-red-500 shrink-0"
                          onClick={() => {
                            deleteAutoGlossary(p.src);
                            setAutoEntries(listAutoGlossary());
                          }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>

          {/* 节点清单 + 逐节点测试 */}
          <div>
            <div className="text-[11px] font-medium text-neutral-600 dark:text-stone-300 mb-1">
              {t('modelSettings.translate.testHint')}
            </div>
            <div className="flex flex-col gap-1">
              {TRANSLATE_NODES.map((n) => (
                <div key={n.id} className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="w-36 shrink-0 truncate text-neutral-700 dark:text-stone-200" title={n.note}>
                    {n.label}
                  </span>
                  <span
                    className={`text-[10px] px-1 rounded shrink-0 ${
                      n.needsKey
                        ? 'bg-neutral-500/10 text-neutral-500 dark:text-stone-400'
                        : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {n.needsKey ? t('modelSettings.translate.needsKey') : t('modelSettings.translate.free')}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[10px] text-neutral-400 dark:text-stone-500" title={n.note}>
                    {n.note}
                  </span>
                  <button
                    onClick={() => void testNode(n.id)}
                    disabled={busy !== null}
                    className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                  >
                    {busy === n.id ? (
                      <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" />{t('modelSettings.translate.testing')}</span>
                    ) : (
                      t('modelSettings.translate.test')
                    )}
                  </button>
                </div>
              ))}
            </div>
            {result && (
              <pre
                className={`mt-2 text-[10px] leading-relaxed whitespace-pre-wrap break-all m-0 p-2 rounded-lg ${
                  result.out.ok
                    ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                    : 'bg-red-500/5 text-red-600 dark:text-red-400'
                }`}
              >
                {[`— ${result.node} —`, ...result.out.lines].join(String.fromCharCode(10))}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
