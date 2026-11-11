/// <reference path="../../../global.d.ts" />
// 凌霄 · 新建下载抽屉：地址 / 目录 / 引擎 / 优先级 / 限速 / 镜像 / SHA-256。

import type { EngineKind, EngineConfig, EngineStatus, HlsVariant, ProbeResult } from './api';
import { dl, ensureDirPath, formatBytes, splitLines } from './api';
import {
  ChevronDownIcon,
  DownloadIcon,
  Field,
  FolderIcon,
  LinkIcon,
  XIcon,
  inputClass,
} from './ui';

const React = window.__HOST_REACT__;
const { useState } = React;

export function NewTaskPanel({
  engines,
  config,
  initialUrl,
  initialCookie,
  onClose,
  onCreated,
}: {
  engines: EngineStatus | null;
  config: EngineConfig | null;
  initialUrl?: string;
  initialCookie?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [urlText, setUrlText] = useState(initialUrl ?? '');
  const [mode, setMode] = useState<'concat' | 'batch'>('concat');
  const [pasting, setPasting] = useState(false);
  const [mirrorText, setMirrorText] = useState('');
  const [savePath, setSavePath] = useState('');
  const [engine, setEngine] = useState('auto');
  const [connections, setConnections] = useState(
    config?.smartConnections ? '' : String(config?.connections ?? 8),
  );
  const [priority, setPriority] = useState('0');
  const [speedKb, setSpeedKb] = useState('');
  const [sha256, setSha256] = useState('');
  const [referer, setReferer] = useState('');
  const [cookie, setCookie] = useState(initialCookie ?? '');
  const [userAgent, setUserAgent] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [variants, setVariants] = useState<HlsVariant[]>([]);
  const [variantUrl, setVariantUrl] = useState('');
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urls = splitLines(urlText);
  const selected = engines?.engines.find((item) => item.kind === engine);

  const pickDirectory = async () => {
    try {
      const dir = await dl.pickDirectory();
      if (dir) setSavePath(ensureDirPath(dir));
    } catch (err) {
      setError(String(err));
    }
  };

  const loadVariants = async (url: string) => {
    setLoadingVariants(true);
    try {
      const list = await dl.hlsVariants({
        url,
        referer: referer.trim() || null,
        cookie: cookie.trim() || null,
        userAgent: userAgent.trim() || null,
      });
      setVariants(list);
      setVariantUrl(list[0]?.url ?? '');
    } catch {
      // 清晰度解析失败不影响普通下载：退回主播放列表，由 ffmpeg 自己选流。
      setVariants([]);
      setVariantUrl('');
    } finally {
      setLoadingVariants(false);
    }
  };

  const probe = async () => {
    const first = urls[0];
    if (!first) {
      setError('请先填写下载地址');
      return;
    }
    setProbing(true);
    setError(null);
    try {
      const result = await dl.probe({
        url: first,
        referer: referer.trim() || null,
        cookie: cookie.trim() || null,
        userAgent: userAgent.trim() || null,
      });
      setProbeResult(result);
      const contentType = (result.contentType ?? '').toLowerCase();
      const looksHls =
        first.toLowerCase().split('?')[0].endsWith('.m3u8') || contentType.includes('mpegurl');
      if (looksHls && urls.length === 1) {
        await loadVariants(first);
      } else {
        setVariants([]);
        setVariantUrl('');
      }
    } catch (err) {
      setProbeResult(null);
      setVariants([]);
      setVariantUrl('');
      setError(String(err));
    } finally {
      setProbing(false);
    }
  };

  const pasteFromClipboard = async () => {
    setPasting(true);
    setError(null);
    try {
      const text = await dl.readClipboard();
      const lines = splitLines(text);
      if (lines.length === 0) {
        setError('剪贴板里没有可用地址');
        return;
      }
      setUrlText((prev) => `${prev.trimEnd()}${prev.trim() ? '\n' : ''}${lines.join('\n')}`);
      setProbeResult(null);
      setVariants([]);
      setVariantUrl('');
    } catch (err) {
      setError(String(err));
    } finally {
      setPasting(false);
    }
  };

  const submit = async () => {
    if (urls.length === 0) {
      setError('至少填写一个下载地址');
      return;
    }
    if (mode === 'batch' && urls.length < 2) {
      setError('批量模式至少需要两个地址');
      return;
    }
    if (!savePath.trim()) {
      setError('请选择保存目录');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const speed = Number(speedKb);
      const base = {
        savePath: ensureDirPath(savePath),
        engine: engine as EngineKind,
        connections: connections.trim()
          ? Math.min(32, Math.max(1, Number(connections) || 8))
          : null,
        priority: Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : 0,
        maxSpeed: Number.isFinite(speed) && speed > 0 ? Math.round(speed * 1024) : null,
        referer: referer.trim() || null,
        cookie: cookie.trim() || null,
        userAgent: userAgent.trim() || null,
      };
      if (mode === 'batch') {
        const failures: string[] = [];
        let firstId: string | null = null;
        for (const url of urls) {
          try {
            const id = await dl.enqueue({
              ...base,
              urls: [url],
              filename: null,
              mirrors: [],
              sha256: null,
            });
            if (!firstId) firstId = id;
          } catch (err) {
            failures.push(`${url} → ${String(err)}`);
          }
        }
        if (!firstId) {
          setError(`创建失败：\n${failures.slice(0, 4).join('\n')}`);
          return;
        }
        if (failures.length > 0) {
          // 部分成功时保持面板打开，把失败的行留给用户处理；已建任务会通过状态事件出现在列表里。
          setError(
            `已创建 ${urls.length - failures.length} 条，失败 ${failures.length} 条：\n${failures
              .slice(0, 3)
              .join('\n')}`,
          );
          return;
        }
        onCreated(firstId);
        return;
      }
      const id = await dl.enqueue({
        ...base,
        urls: variantUrl && urls.length === 1 ? [variantUrl] : urls,
        filename: probeResult?.filename ?? null,
        mirrors: splitLines(mirrorText),
        sha256: sha256.trim() || null,
      });
      onCreated(id);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex justify-end bg-black/20 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-[470px] max-w-full flex-col border-l border-black/10 bg-[#fbfaf7] shadow-2xl dark:border-white/10 dark:bg-[#211e1b]">
        <div className="flex items-center gap-3 border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--element-bg)]/10 text-[var(--element-color-raw)]">
            <DownloadIcon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">新建下载</div>
            <div className="text-[11px] text-neutral-400 dark:text-stone-500">地址交给引擎，进度交给凌霄</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
            aria-label="关闭"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Field
            label="下载地址"
            hint={
              mode === 'batch'
                ? '每行一个地址，逐条创建任务'
                : '每行一个；多行会按顺序拼接（HLS / 分段视频）'
            }
          >
            <textarea
              value={urlText}
              onChange={(event) => {
                setUrlText(event.target.value);
                setProbeResult(null);
                setVariants([]);
                setVariantUrl('');
              }}
              rows={4}
              spellCheck={false}
              placeholder={'https://example.com/file.zip\nmagnet:?xt=urn:btih:...'}
              className={`${inputClass} resize-y font-mono text-xs leading-relaxed`}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-neutral-400 dark:text-stone-500">多行地址</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
              <button
                type="button"
                onClick={() => {
                  setMode('concat');
                  setProbeResult(null);
                  setVariants([]);
                  setVariantUrl('');
                }}
                className={`px-2.5 py-1 transition-colors ${
                  mode === 'concat'
                    ? 'bg-black/10 font-medium text-neutral-700 dark:bg-white/15 dark:text-stone-100'
                    : 'text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10'
                }`}
              >
                拼接为一条
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('batch');
                  setProbeResult(null);
                  setVariants([]);
                  setVariantUrl('');
                }}
                className={`px-2.5 py-1 transition-colors ${
                  mode === 'batch'
                    ? 'bg-black/10 font-medium text-neutral-700 dark:bg-white/15 dark:text-stone-100'
                    : 'text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10'
                }`}
              >
                批量创建{urls.length > 1 ? ` (${urls.length})` : ''}
              </button>
            </div>
            <button
              type="button"
              onClick={pasteFromClipboard}
              disabled={pasting}
              className="inline-flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1 font-medium text-neutral-600 transition-colors hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-stone-300 dark:hover:bg-white/15"
            >
              <LinkIcon size={12} />
              {pasting ? '读取中…' : '粘贴剪贴板'}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={probe}
              disabled={probing || urls.length === 0 || mode === 'batch'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-black/5 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-stone-300 dark:hover:bg-white/15"
            >
              <LinkIcon size={13} />
              {probing ? '解析中…' : '解析地址'}
            </button>
            {mode === 'batch' ? (
              <div className="text-[11px] text-neutral-400 dark:text-stone-500">
                批量模式会为每条地址自动解析文件名
              </div>
            ) : probeResult ? (
              <div className="min-w-0 text-[11px] text-neutral-500 dark:text-stone-400">
                <span className="font-medium text-neutral-700 dark:text-stone-200">
                  {probeResult.filename || '未命名'}
                </span>
                <span className="ml-1.5">{probeResult.totalBytes > 0 ? formatBytes(probeResult.totalBytes) : '大小未知'}</span>
                <span className="ml-1.5">{probeResult.acceptRanges ? '· 支持分段' : '· 单连接'}</span>
              </div>
            ) : null}
          </div>

          {variants.length > 0 && urls.length === 1 && mode === 'concat' ? (
            <Field
              label="清晰度"
              hint={loadingVariants ? '解析中…' : '来自 HLS 主播放列表'}
            >
              <select
                value={variantUrl}
                onChange={(event) => setVariantUrl(event.target.value)}
                className={inputClass}
              >
                {variants.map((variant, index) => (
                  <option key={variant.url} value={variant.url}>
                    {variant.name}
                    {variant.bandwidth > 0 ? ` · ${Math.round(variant.bandwidth / 1000)} kbps` : ''}
                    {index === 0 ? '（最高）' : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label="保存目录" hint="文件名由地址或探测结果决定">
            <div className="flex gap-2">
              <input
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                spellCheck={false}
                placeholder="选择或输入目录，例如 D:\\Downloads"
                className={inputClass}
              />
              <button
                type="button"
                onClick={pickDirectory}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl border border-black/10 px-3 text-xs font-medium text-neutral-600 transition-colors hover:bg-black/5 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/10"
              >
                <FolderIcon size={14} />
                选择
              </button>
            </div>
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="连接数" hint={config?.smartConnections ? '留空 = 自适应' : undefined}>
              <input
                type="number"
                min={1}
                max={32}
                value={connections}
                onChange={(event) => setConnections(event.target.value)}
                placeholder={config?.smartConnections ? '自动' : undefined}
                className={inputClass}
              />
            </Field>
            <Field label="优先级" hint="越大越先">
              <input
                type="number"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="限速" hint="KB/s">
              <input
                type="number"
                min={0}
                value={speedKb}
                onChange={(event) => setSpeedKb(event.target.value)}
                placeholder="不限"
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="引擎">
            <select
              value={engine}
              onChange={(event) => setEngine(event.target.value)}
              className={inputClass}
            >
              <option value="auto">自动（按任务形态选择）</option>
              {engines?.engines.map((item) => (
                <option key={item.kind} value={item.kind} disabled={!item.available}>
                  {item.name}
                  {item.available ? '' : '（未安装）'}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[10px] leading-relaxed text-neutral-400 dark:text-stone-500">
              {selected
                ? `${selected.description}${selected.available ? '' : ' · 当前不可用'}`
                : '磁力/BT 自动走 Gopeed；HLS 走 ffmpeg；其余按默认引擎。'}
            </div>
          </Field>

          <Field
            label="镜像地址"
            hint={mode === 'batch' ? '批量模式不支持镜像' : '可选；主源失败时按顺序尝试'}
          >
            <textarea
              value={mirrorText}
              onChange={(event) => setMirrorText(event.target.value)}
              rows={2}
              spellCheck={false}
              disabled={mode === 'batch'}
              placeholder={'https://mirror-1.example.com/file.zip\nhttps://mirror-2.example.com/file.zip'}
              className={`${inputClass} resize-y font-mono text-xs leading-relaxed disabled:opacity-40`}
            />
          </Field>

          <Field
            label="校验值"
            hint={
              mode === 'batch'
                ? '批量模式不支持单文件校验'
                : 'MD5 / SHA-1 / SHA-256，按长度自动识别'
            }
          >
            <input
              value={sha256}
              onChange={(event) => setSha256(event.target.value)}
              spellCheck={false}
              disabled={mode === 'batch'}
              placeholder="32 / 40 / 64 位十六进制，可带 md5: / sha1: / sha256: 前缀"
              className={`${inputClass} font-mono text-xs disabled:opacity-40`}
            />
          </Field>

          <button
            type="button"
            onClick={() => setAdvanced((value) => !value)}
            className="flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            <ChevronDownIcon size={13} className={advanced ? 'rotate-180 transition-transform' : 'transition-transform'} />
            高级请求头
          </button>

          {advanced ? (
            <div className="space-y-3 rounded-2xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]">
              <Field label="Referer">
                <input
                  value={referer}
                  onChange={(event) => setReferer(event.target.value)}
                  spellCheck={false}
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
              <Field label="Cookie">
                <input
                  value={cookie}
                  onChange={(event) => setCookie(event.target.value)}
                  spellCheck={false}
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
              <Field label="User-Agent" hint="留空使用全局设置">
                <input
                  value={userAgent}
                  onChange={(event) => setUserAgent(event.target.value)}
                  spellCheck={false}
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/10 px-5 py-3 dark:border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-neutral-500 transition-colors hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--element-bg)] px-4 py-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <DownloadIcon size={14} />
            {submitting
              ? mode === 'batch'
                ? '创建中…'
                : '入队中…'
              : mode === 'batch'
                ? `批量创建 ${urls.length} 条`
                : '开始下载'}
          </button>
        </div>
      </div>
    </div>
  );
}
