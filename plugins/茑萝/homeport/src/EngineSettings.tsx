/// <reference path="../../../global.d.ts" />
// 凌霄 · 引擎与传输设置：默认引擎、并发、限速、代理、外部工具路径。

import type { EngineConfig, EngineStatus } from './api';
import { dl, formatBytes } from './api';
import { AlertIcon, CheckIcon, Field, RefreshIcon, SettingsIcon, inputClass } from './ui';

const React = window.__HOST_REACT__;
const { useState } = React;

function toKb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const kb = Math.round(bytes / 1024);
  return kb > 0 ? String(kb) : '';
}

function fromKb(value: string): number {
  const kb = Number(value);
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : 0;
}

export function EngineSettings({
  config,
  engines,
  onSaved,
  onBack,
}: {
  config: EngineConfig;
  engines: EngineStatus | null;
  onSaved: (config: EngineConfig) => void;
  onBack: () => void;
}) {
  const [defaultEngine, setDefaultEngine] = useState(config.defaultEngine);
  const [connections, setConnections] = useState(String(config.connections));
  const [maxTasks, setMaxTasks] = useState(String(config.maxConcurrentTasks));
  const [maxPerHost, setMaxPerHost] = useState(String(config.maxPerHost));
  const [taskRetries, setTaskRetries] = useState(String(config.taskRetries));
  const [speedKb, setSpeedKb] = useState(toKb(config.speedLimit));
  const [totalSpeedKb, setTotalSpeedKb] = useState(toKb(config.totalSpeedLimit));
  const [proxy, setProxy] = useState(config.proxy ?? '');
  const [userAgent, setUserAgent] = useState(config.userAgent ?? '');
  const [aria2Path, setAria2Path] = useState(config.aria2Path ?? '');
  const [ffmpegPath, setFfmpegPath] = useState(config.ffmpegPath ?? '');
  const [curlPath, setCurlPath] = useState(config.curlPath ?? '');
  const [wgetPath, setWgetPath] = useState(config.wgetPath ?? '');
  const [gopeedPath, setGopeedPath] = useState(config.gopeedPath ?? '');
  const [resumeOnStart, setResumeOnStart] = useState(config.resumeOnStart);
  const [notifyOnComplete, setNotifyOnComplete] = useState(config.notifyOnComplete);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next: EngineConfig = {
        ...config,
        defaultEngine: defaultEngine as never,
        connections: Math.min(32, Math.max(1, Number(connections) || 8)),
        maxConcurrentTasks: Math.min(8, Math.max(1, Number(maxTasks) || 2)),
        maxPerHost: Math.min(8, Math.max(0, Number(maxPerHost) || 0)),
        taskRetries: Math.min(5, Math.max(0, Number(taskRetries) || 0)),
        speedLimit: fromKb(speedKb),
        totalSpeedLimit: fromKb(totalSpeedKb),
        proxy: proxy.trim() || null,
        userAgent: userAgent.trim() || config.userAgent,
        aria2Path: aria2Path.trim() || null,
        ffmpegPath: ffmpegPath.trim() || null,
        curlPath: curlPath.trim() || null,
        wgetPath: wgetPath.trim() || null,
        gopeedPath: gopeedPath.trim() || null,
        resumeOnStart,
        notifyOnComplete,
      };
      const result = await dl.configSet(next);
      onSaved(result);
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-black/10 px-6 py-4 dark:border-white/10">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
        >
          ← 返回下载
        </button>
        <div className="flex items-center gap-2">
          <SettingsIcon size={16} className="text-neutral-400" />
          <span className="text-sm font-semibold text-neutral-800 dark:text-stone-100">引擎与传输设置</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckIcon size={12} /> 已保存
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-xl bg-[var(--element-bg)] px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error ? (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-600 dark:text-red-400">
            <AlertIcon size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
              调度
            </h3>
            <div className="space-y-3">
              <Field label="默认引擎" hint="自动 = 按任务形态选择">
                <select
                  value={defaultEngine}
                  onChange={(event) => setDefaultEngine(event.target.value as never)}
                  className={inputClass}
                >
                  <option value="auto">自动</option>
                  {engines?.engines.map((item) => (
                    <option key={item.kind} value={item.kind} disabled={!item.available}>
                      {item.name}
                      {item.available ? '' : '（未安装）'}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="默认连接数" hint="1–32">
                  <input
                    type="number"
                    min={1}
                    max={32}
                    value={connections}
                    onChange={(event) => setConnections(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="同时任务数" hint="1–8">
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={maxTasks}
                    onChange={(event) => setMaxTasks(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="单站点并发" hint="0 = 不限">
                  <input
                    type="number"
                    min={0}
                    max={8}
                    value={maxPerHost}
                    onChange={(event) => setMaxPerHost(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="任务自动重试" hint="0–5 次">
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={taskRetries}
                    onChange={(event) => setTaskRetries(event.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-stone-300">
                <input
                  type="checkbox"
                  checked={resumeOnStart}
                  onChange={(event) => setResumeOnStart(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--element-bg)]"
                />
                启动时恢复上次未完成的任务
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-stone-300">
                <input
                  type="checkbox"
                  checked={notifyOnComplete}
                  onChange={async (event) => {
                    const checked = event.target.checked;
                    setNotifyOnComplete(checked);
                    // 申请权限必须发生在用户手势里；被拒绝也不影响下载本身。
                    if (checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                      try {
                        await Notification.requestPermission();
                      } catch {
                        /* 通知不可用时静默降级 */
                      }
                    }
                  }}
                  className="h-3.5 w-3.5 accent-[var(--element-bg)]"
                />
                完成/失败时发送系统通知
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
              限速与代理
            </h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="单任务限速" hint="KB/s，空 = 不限">
                  <input
                    type="number"
                    min={0}
                    value={speedKb}
                    onChange={(event) => setSpeedKb(event.target.value)}
                    placeholder="不限"
                    className={inputClass}
                  />
                </Field>
                <Field label="全局聚合限速" hint="KB/s，空 = 不限">
                  <input
                    type="number"
                    min={0}
                    value={totalSpeedKb}
                    onChange={(event) => setTotalSpeedKb(event.target.value)}
                    placeholder="不限"
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="text-[10px] leading-relaxed text-neutral-400 dark:text-stone-500">
                全局聚合限速由引擎1/2 共享；aria2 / curl / wget / gopeed 是独立进程，只受单任务限速约束。
              </div>
              <Field label="代理" hint="http:// 或 socks5://，空 = 不用代理">
                <input
                  value={proxy}
                  onChange={(event) => setProxy(event.target.value)}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:7890"
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
            </div>
          </section>

          <section className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
              外部工具
            </h3>
            <div className="space-y-3">
              <Field label="aria2c">
                <input
                  value={aria2Path}
                  onChange={(event) => setAria2Path(event.target.value)}
                  spellCheck={false}
                  placeholder="留空自动在 external-deps / PATH 查找"
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
              <Field label="ffmpeg">
                <input
                  value={ffmpegPath}
                  onChange={(event) => setFfmpegPath(event.target.value)}
                  spellCheck={false}
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="curl">
                  <input
                    value={curlPath}
                    onChange={(event) => setCurlPath(event.target.value)}
                    spellCheck={false}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </Field>
                <Field label="wget">
                  <input
                    value={wgetPath}
                    onChange={(event) => setWgetPath(event.target.value)}
                    spellCheck={false}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </Field>
              </div>
              <Field label="gopeed" hint="P2P：BT / 磁力 / ed2k">
                <input
                  value={gopeedPath}
                  onChange={(event) => setGopeedPath(event.target.value)}
                  spellCheck={false}
                  className={`${inputClass} font-mono text-xs`}
                />
              </Field>
            </div>
          </section>

          <section className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
              请求
            </h3>
            <Field label="User-Agent" hint="留空使用内置浏览器 UA">
              <textarea
                value={userAgent}
                onChange={(event) => setUserAgent(event.target.value)}
                rows={3}
                spellCheck={false}
                className={`${inputClass} resize-y font-mono text-xs leading-relaxed`}
              />
            </Field>
          </section>
        </div>

        <section className="mt-5 rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
          <div className="mb-3 flex items-center gap-2">
            <RefreshIcon size={14} className="text-neutral-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
              引擎可用性
            </h3>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {engines?.engines.map((item) => (
              <div
                key={item.kind}
                className="flex items-start gap-2 rounded-xl border border-black/5 px-3 py-2 dark:border-white/5"
              >
                <span
                  className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${
                    item.available ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-stone-600'
                  }`}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-neutral-700 dark:text-stone-200">
                    {item.name}
                    {item.default ? (
                      <span className="rounded-full bg-[var(--element-bg)]/10 px-1.5 py-0.5 text-[9px] text-[var(--element-color-raw)]">
                        默认
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-neutral-400 dark:text-stone-500">
                    {item.description}
                  </div>
                  {item.path ? (
                    <div className="mt-1 truncate font-mono text-[10px] text-neutral-400 dark:text-stone-600" title={item.path}>
                      {item.path}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[10px] text-neutral-400 dark:text-stone-500">
            外部引擎不随包分发，需自行安装；gopeed 为 P2P 专用。
          </div>
        </section>

        <div className="mt-4 text-[10px] text-neutral-400 dark:text-stone-500">
          当前单任务限速 {config.speedLimit > 0 ? `${formatBytes(config.speedLimit)}/s` : '不限'} · 全局{' '}
          {config.totalSpeedLimit > 0 ? `${formatBytes(config.totalSpeedLimit)}/s` : '不限'}
        </div>
      </div>
    </div>
  );
}
