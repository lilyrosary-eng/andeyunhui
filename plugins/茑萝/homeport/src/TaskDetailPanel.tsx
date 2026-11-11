/// <reference path="../../../global.d.ts" />
// 凌霄 · 任务详情：分片明细、校验器、保存路径与镜像源。

import type { EngineStatus, TaskDetail } from './api';
import { ENGINE_LABEL, STATUS_LABEL, dl, formatBytes } from './api';
import { ProgressBar, StatusChip, XIcon } from './ui';

const React = window.__HOST_REACT__;
const { useEffect, useState } = React;

const PART_LABEL: Record<string, string> = {
  pending: '待下载',
  downloading: '下载中',
  completed: '完成',
};

export function TaskDetailPanel({
  detail,
  engines,
  onClose,
  onChanged,
}: {
  detail: TaskDetail;
  engines: EngineStatus | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const editable = detail.status !== 'completed' && detail.status !== 'canceled';
  const [priority, setPriority] = useState(String(detail.priority));
  const [connections, setConnections] = useState(String(detail.connections));
  const [speedKb, setSpeedKb] = useState(
    detail.maxSpeed && detail.maxSpeed > 0 ? String(Math.round(detail.maxSpeed / 1024)) : '',
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setPriority(String(detail.priority));
    setConnections(String(detail.connections));
    setSpeedKb(
      detail.maxSpeed && detail.maxSpeed > 0 ? String(Math.round(detail.maxSpeed / 1024)) : '',
    );
    setSaveError(null);
  }, [detail.id, detail.priority, detail.connections, detail.maxSpeed]);

  const saveOptions = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const speed = Number(speedKb);
      await dl.updateOptions(
        detail.id,
        Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : 0,
        Math.min(32, Math.max(1, Number(connections) || 8)),
        Number.isFinite(speed) && speed > 0 ? Math.round(speed * 1024) : 0,
      );
      onChanged();
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const engineName =
    engines?.engines.find((item) => item.kind === (detail.resolvedEngine ?? detail.engine))?.name ??
    ENGINE_LABEL[detail.resolvedEngine ?? detail.engine] ??
    detail.engine;
  const percent = detail.totalBytes > 0 ? Math.min(100, (detail.downloadedBytes / detail.totalBytes) * 100) : 0;

  return (
    <div
      className="absolute inset-0 z-20 flex justify-end bg-black/20 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-[520px] max-w-full flex-col border-l border-black/10 bg-[#fbfaf7] shadow-2xl dark:border-white/10 dark:bg-[#211e1b]">
        <div className="flex items-start gap-3 border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-neutral-800 dark:text-stone-100" title={detail.filename}>
                {detail.filename}
              </span>
              <StatusChip status={detail.status} label={STATUS_LABEL[detail.status]} />
            </div>
            <div className="mt-0.5 truncate text-[11px] text-neutral-400 dark:text-stone-500" title={detail.savePath}>
              {detail.savePath}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
            aria-label="关闭"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <div className="mb-2 flex items-center justify-between text-[11px] text-neutral-400 dark:text-stone-500">
              <span>
                {formatBytes(detail.downloadedBytes)}
                {detail.totalBytes > 0 ? ` / ${formatBytes(detail.totalBytes)}` : ' / 未知'}
              </span>
              <span>{detail.totalBytes > 0 ? `${percent.toFixed(1)}%` : '—'}</span>
            </div>
            <ProgressBar
              downloaded={detail.downloadedBytes}
              total={detail.totalBytes}
              active={detail.status === 'downloading' || detail.status === 'merging'}
            />
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
              <Info label="引擎" value={engineName} />
              <Info label="连接数" value={String(detail.connections)} />
              <Info label="分片" value={`${detail.parts.length} 片`} />
              <Info label="优先级" value={String(detail.priority)} />
              <Info
                label="创建时间"
                value={new Date(detail.createdAt).toLocaleString()}
              />
              <Info
                label="完成时间"
                value={detail.completedAt ? new Date(detail.completedAt).toLocaleString() : '—'}
              />
              {detail.maxSpeed ? (
                <Info label="限速" value={`${formatBytes(detail.maxSpeed)}/s`} />
              ) : null}
              {detail.sha256 ? (
                <div className="col-span-2">
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">校验值</div>
                  <div className="break-all font-mono text-[10px] text-neutral-600 dark:text-stone-300">{detail.sha256}</div>
                </div>
              ) : null}
              {detail.etag ? (
                <div className="col-span-2">
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">ETag</div>
                  <div className="break-all font-mono text-[10px] text-neutral-600 dark:text-stone-300">{detail.etag}</div>
                </div>
              ) : null}
              {detail.lastModified ? (
                <div className="col-span-2">
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">Last-Modified</div>
                  <div className="break-all font-mono text-[10px] text-neutral-600 dark:text-stone-300">
                    {detail.lastModified}
                  </div>
                </div>
              ) : null}
            </div>

            {detail.error ? (
              <div className="mt-3 rounded-lg bg-red-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
                {detail.error}
              </div>
            ) : null}
          </div>

          {editable ? (
            <div className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
                  调度参数
                </span>
                <span className="text-[10px] text-neutral-400 dark:text-stone-500">
                  连接数/限速在下次开始时生效
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-[10px] text-neutral-400 dark:text-stone-500">
                  优先级
                  <input
                    type="number"
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-[11px] text-neutral-700 outline-none dark:border-white/10 dark:bg-stone-900/60 dark:text-stone-200"
                  />
                </label>
                <label className="text-[10px] text-neutral-400 dark:text-stone-500">
                  连接数
                  <input
                    type="number"
                    min={1}
                    max={32}
                    value={connections}
                    onChange={(event) => setConnections(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-[11px] text-neutral-700 outline-none dark:border-white/10 dark:bg-stone-900/60 dark:text-stone-200"
                  />
                </label>
                <label className="text-[10px] text-neutral-400 dark:text-stone-500">
                  限速 KB/s
                  <input
                    type="number"
                    min={0}
                    value={speedKb}
                    onChange={(event) => setSpeedKb(event.target.value)}
                    placeholder="不限"
                    className="mt-1 w-full rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-[11px] text-neutral-700 outline-none dark:border-white/10 dark:bg-stone-900/60 dark:text-stone-200"
                  />
                </label>
              </div>
              {saveError ? (
                <div className="mt-2 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
                  {saveError}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void saveOptions()}
                disabled={saving}
                className="mt-2 rounded-lg bg-[var(--element-bg)] px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存参数'}
              </button>
            </div>
          ) : null}

          <div className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
              地址
            </div>
            <div className="space-y-1.5">
              {detail.urls.map((url, index) => (
                <div key={`${url}-${index}`} className="break-all font-mono text-[10px] text-neutral-600 dark:text-stone-300">
                  {index === 0 ? '主源 ' : `拼接 ${index + 1} `}
                  {url}
                </div>
              ))}
              {detail.mirrors.map((url, index) => (
                <div key={`mirror-${url}-${index}`} className="break-all font-mono text-[10px] text-neutral-400 dark:text-stone-500">
                  镜像 {index + 1} {url}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white/70 p-4 dark:border-white/5 dark:bg-stone-900/40">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-stone-500">
                分片明细
              </span>
              <span className="text-[10px] text-neutral-400 dark:text-stone-500">{detail.parts.length} 片</span>
            </div>
            <div className="space-y-1.5">
              {detail.parts.map((part) => {
                const expected = part.end > part.start ? part.end - part.start : 0;
                const partPercent = expected > 0 ? Math.min(100, (part.downloaded / expected) * 100) : 0;
                return (
                  <div
                    key={part.index}
                    className="rounded-xl border border-black/5 px-2.5 py-2 dark:border-white/5"
                  >
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="w-7 flex-shrink-0 font-mono text-neutral-400 dark:text-stone-500">
                        #{part.index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-neutral-500 dark:text-stone-400">
                        {formatBytes(part.start)} – {part.end > 0 ? formatBytes(part.end) : '未知'}
                      </span>
                      <span className="text-neutral-500 dark:text-stone-400">
                        {formatBytes(part.downloaded)}
                        {expected > 0 ? ` / ${formatBytes(expected)}` : ''}
                      </span>
                      <span className="w-12 text-right text-neutral-400 dark:text-stone-500">
                        {PART_LABEL[part.state] ?? part.state}
                      </span>
                    </div>
                    {expected > 0 ? (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                        <div
                          className="h-full rounded-full bg-[var(--element-bg)]"
                          style={{ width: `${partPercent}%` }}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-neutral-400 dark:text-stone-500">{label}</div>
      <div className="text-[11px] text-neutral-600 dark:text-stone-300">{value}</div>
    </div>
  );
}
