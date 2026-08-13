import React from "react";

const { useState } = React;

interface NeteaseSettingsPanelProps {
  onClose: () => void;
}

const NS = "netease.";
const KEYS = {
  playQuality: NS + "playQuality",
  downloadQuality: NS + "downloadQuality",
  downloadDir: NS + "downloadDir",
  autoDownload: NS + "autoDownload",
  desktopLyric: NS + "desktopLyric",
  rememberTab: NS + "rememberTab",
};

const QUALITY_OPTIONS = [
  { value: "standard", label: "标准 (128k)" },
  { value: "higher", label: "较高 (192k)" },
  { value: "exhigh", label: "极高 (320k)" },
  { value: "lossless", label: "无损 (FLAC)" },
  { value: "hires", label: "Hi-Res" },
];

function lsGet(k: string, fallback: string): string {
  try {
    return window.localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export default function NeteaseSettingsPanel({ onClose }: NeteaseSettingsPanelProps) {
  const [playQuality, setPlayQuality] = useState(() => lsGet(KEYS.playQuality, "exhigh"));
  const [downloadQuality, setDownloadQuality] = useState(() =>
    lsGet(KEYS.downloadQuality, "lossless")
  );
  const [downloadDir, setDownloadDir] = useState(() => lsGet(KEYS.downloadDir, ""));
  const [autoDownload, setAutoDownload] = useState(() => lsGet(KEYS.autoDownload, "false") === "true");
  const [desktopLyric, setDesktopLyric] = useState(() => lsGet(KEYS.desktopLyric, "false") === "true");
  const [rememberTab, setRememberTab] = useState(() => lsGet(KEYS.rememberTab, "true") === "true");
  const [clearing, setClearing] = useState(false);

  const update = (k: string, v: string, setter: (v: string) => void) => {
    lsSet(k, v);
    setter(v);
  };
  const updateBool = (k: string, v: boolean, setter: (v: boolean) => void) => {
    lsSet(k, v ? "true" : "false");
    setter(v);
  };

  const handleClearCache = async () => {
    setClearing(true);
    try {
      // 清除网易云相关本地缓存键（临时播放列表、歌单缓存、歌词/百科缓存等）
      const removeKeys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && (key.startsWith("netease.") || key.startsWith("neteaseCache."))) {
          removeKeys.push(key);
        }
      }
      removeKeys.forEach((k) => window.localStorage.removeItem(k));
      // 保留设置项本身，故重新写回
      lsSet(KEYS.playQuality, playQuality);
      lsSet(KEYS.downloadQuality, downloadQuality);
      lsSet(KEYS.downloadDir, downloadDir);
      lsSet(KEYS.autoDownload, autoDownload ? "true" : "false");
      lsSet(KEYS.desktopLyric, desktopLyric ? "true" : "false");
      lsSet(KEYS.rememberTab, rememberTab ? "true" : "false");
      window.alert("网易云缓存已清理（临时播放列表、歌单与歌词/百科缓存）。");
    } catch (e: any) {
      window.alert("清理失败：" + String(e?.message || e));
    } finally {
      setClearing(false);
    }
  };

  const pickDir = async () => {
    try {
      const res = await (window as any).__HOST_API__?.invoke?.("pick_directory");
      if (res) update(KEYS.downloadDir, String(res), setDownloadDir);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#f5f5f0] dark:bg-[#1c1917]">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-neutral-200/50 dark:border-stone-700/50">
        <button
          onClick={onClose}
          className="px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 text-base"
          aria-label="返回"
        >
          ←
        </button>
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">网易云设置</h2>
      </div>

      <div className="max-w-2xl px-5 py-5 space-y-8">
        {/* 音质与下载 */}
        <Group title="音质与下载">
          <Field label="默认播放音质">
            <Select
              value={playQuality}
              options={QUALITY_OPTIONS}
              onChange={(v) => update(KEYS.playQuality, v, setPlayQuality)}
            />
          </Field>
          <Field label="默认下载音质">
            <Select
              value={downloadQuality}
              options={QUALITY_OPTIONS}
              onChange={(v) => update(KEYS.downloadQuality, v, setDownloadQuality)}
            />
          </Field>
          <Field label="下载目录">
            <div className="flex items-center gap-2">
              <input
                value={downloadDir}
                readOnly
                placeholder="未设置（使用默认目录）"
                className="flex-1 px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 text-sm text-neutral-700 dark:text-stone-200 outline-none"
              />
              <button
                onClick={pickDir}
                className="px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 text-sm hover:opacity-90 transition-opacity"
              >
                选择
              </button>
            </div>
          </Field>
          <Toggle
            label="自动下载已播放歌曲"
            checked={autoDownload}
            onChange={(v) => updateBool(KEYS.autoDownload, v, setAutoDownload)}
          />
        </Group>

        {/* 缓存清理 */}
        <Group title="缓存清理">
          <p className="text-xs text-neutral-500 dark:text-stone-400 mb-3">
            清除临时播放列表、歌单缓存、歌词/百科缓存（不影响设置项与登录态）。
          </p>
          <button
            onClick={handleClearCache}
            disabled={clearing}
            className="px-4 py-2 rounded-xl bg-rose-500/90 text-white text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {clearing ? "清理中…" : "清除网易云缓存"}
          </button>
        </Group>

        {/* 通用偏好 */}
        <Group title="通用偏好">
          <Toggle
            label="桌面歌词"
            checked={desktopLyric}
            onChange={(v) => updateBool(KEYS.desktopLyric, v, setDesktopLyric)}
          />
          <Toggle
            label="记住上次所在 Tab"
            checked={rememberTab}
            onChange={(v) => updateBool(KEYS.rememberTab, v, setRememberTab)}
          />
        </Group>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-32 shrink-0 text-sm text-neutral-600 dark:text-stone-300">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 text-sm text-neutral-700 dark:text-stone-200 outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-32 shrink-0 text-sm text-neutral-600 dark:text-stone-300">{label}</div>
      <button
        onClick={() => onChange(!checked)}
        className={
          "relative w-11 h-6 rounded-full transition-colors " +
          (checked ? "bg-[var(--element-color-raw)]" : "bg-neutral-300 dark:bg-stone-600")
        }
        aria-pressed={checked}
      >
        <span
          className={
            "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform " +
            (checked ? "translate-x-5" : "")
          }
        />
      </button>
    </div>
  );
}
