// 桌宠素材清单（manifest）共享类型与工具。
// 状态可增删、每状态可绑多张图片/视频；用户可在设置面板导入自己的图片/视频。
// manifest 由设置面板写入 localStorage['deskpet:manifest'] 并全局 emit，
// 浮窗启动时也会向插件请求（插件从同源 localStorage 回复）。

export type DeskpetAsset = {
  file: string; // 文件名，如 idle1.png / mycat.mp4
  rel: string; // 相对路径，如 "deskpet-assets/pet/idle1.png"
  kind: "image" | "video";
  mime: string;
};

export type DeskpetStateDef = {
  id: string; // 状态标识，如 idle / work / 自定义
  label: string; // 展示名
  assets: DeskpetAsset[];
};

export type DeskpetManifest = {
  states: DeskpetStateDef[];
};

// 预设：一套完整方案快照（manifest + 基础设置）。多个预设共享同一批素材（按 rel 引用），
// 只在 localStorage 里存轻量配置，不重复占空间。切换预设即把 manifest+settings 推给浮窗。
export type DeskpetPresetSettings = {
  scale: number;
  opacity: number;
  clickThrough: boolean;
};

export type DeskpetPreset = {
  id: string;
  name: string;
  manifest: DeskpetManifest;
  settings: DeskpetPresetSettings;
};

export const DESKPET_MANIFEST_KEY = "deskpet:manifest";
export const DESKPET_PRESETS_KEY = "deskpet:presets";
export const DESKPET_ACTIVE_PRESET_KEY = "deskpet:active";

export function loadDeskpetPresets(): DeskpetPreset[] {
  try {
    const raw = localStorage.getItem(DESKPET_PRESETS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p as DeskpetPreset[];
    }
  } catch {
    /* 解析失败使用空列表 */
  }
  return [];
}

export function saveDeskpetPresets(presets: DeskpetPreset[]): void {
  try {
    localStorage.setItem(DESKPET_PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* 忽略持久化失败 */
  }
}

export function loadActivePresetId(): string | null {
  try {
    return localStorage.getItem(DESKPET_ACTIVE_PRESET_KEY);
  } catch {
    return null;
  }
}

export function saveActivePresetId(id: string | null): void {
  try {
    if (id) localStorage.setItem(DESKPET_ACTIVE_PRESET_KEY, id);
    else localStorage.removeItem(DESKPET_ACTIVE_PRESET_KEY);
  } catch {
    /* 忽略持久化失败 */
  }
}

// 缺省清单：待机用多角度图（正脸/左/左上/右上/右下/左下），由鼠标方位选帧；
// 工作用 工作1(启动)/工作2(循环)/工作3(结束)，内存 >60% 时自动播放。
export const DESKPET_DEFAULT_MANIFEST: DeskpetManifest = {
  states: [
    {
      id: "idle",
      label: "待机",
      assets: [
        { file: "idleface.png", rel: "deskpet-assets/pet/idleface.png", kind: "image", mime: "image/png" },
        { file: "idleleft.png", rel: "deskpet-assets/pet/idleleft.png", kind: "image", mime: "image/png" },
        { file: "idleleftup.png", rel: "deskpet-assets/pet/idleleftup.png", kind: "image", mime: "image/png" },
        { file: "idlerightup.png", rel: "deskpet-assets/pet/idlerightup.png", kind: "image", mime: "image/png" },
        { file: "idlerightdown.png", rel: "deskpet-assets/pet/idlerightdown.png", kind: "image", mime: "image/png" },
        { file: "idleleftdown.png", rel: "deskpet-assets/pet/idleleftdown.png", kind: "image", mime: "image/png" },
      ],
    },
    {
      id: "work",
      label: "工作",
      assets: [
        { file: "工作1.mp4", rel: "deskpet-assets/pet/工作1.mp4", kind: "video", mime: "video/mp4" },
        { file: "工作2.mp4", rel: "deskpet-assets/pet/工作2.mp4", kind: "video", mime: "video/mp4" },
        { file: "工作3.mp4", rel: "deskpet-assets/pet/工作3.mp4", kind: "video", mime: "video/mp4" },
      ],
    },
  ],
};

const IMAGE_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  apng: "image/apng",
  bmp: "image/bmp",
  avif: "image/avif",
};
const VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogg: "video/ogg",
};

// 由文件名推断素材类型与 MIME（用于导入时落盘后的清单记录）。
export function inferDeskpetAsset(fileName: string): { kind: "image" | "video"; mime: string } {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT[ext]) return { kind: "video", mime: VIDEO_EXT[ext] };
  return { kind: "image", mime: IMAGE_EXT[ext] ?? "image/png" };
}

// 重命名迁移：桌宠待机素材历经多次改名：
//   idle1.png/idle2.png（最早）→ 常态正脸/常态左/…（中文）→ idleface/idleleft/…（英文，当前）
// 若缓存的 manifest 仍引用任意旧文件名，视为陈旧并回退缺省清单，
// 避免浮窗去加载已不存在的文件而只能显示兜底小球。
const LEGACY_ASSET_TOKENS = ["idle1.png", "idle2.png", "常态", "idle1", "idle2"];
// 当前缺省 idle 素材文件名集合，用于识别「内置默认结构但文件名已被改名」的陈旧清单
const CURRENT_IDLE_BASENAMES = (DESKPET_DEFAULT_MANIFEST.states.find((s) => s.id === "idle")?.assets ?? [])
  .map((a) => (a.file || "").toLowerCase())
  .filter(Boolean);

export function isLegacyDeskpetManifest(m: DeskpetManifest | null | undefined): boolean {
  if (!m || !Array.isArray(m.states)) return false;
  for (const s of m.states) {
    for (const a of s.assets ?? []) {
      const t = (a.rel || a.file || "").toLowerCase();
      // 明确的旧文件名（idle1/idle2 旧版；常态 中文版）
      if (LEGACY_ASSET_TOKENS.some((tok) => t.includes(tok))) return true;
    }
  }
  // 内置 idle 状态：若文件名与当前缺省不一致（且非用户自定义 user_external_deps 目录），
  // 说明缓存的是改名前的「内置默认」清单，应回退到当前缺省。
  const idle = m.states.find((s) => s.id === "idle");
  if (idle && Array.isArray(idle.assets) && idle.assets.length > 0) {
    const hasUserAsset = idle.assets.some((a) => (a.rel || "").includes("user_external_deps"));
    if (!hasUserAsset) {
      const mismatch = idle.assets.some((a) => {
        const base = (a.file || a.rel || "").toLowerCase().split(/[\\/]/).pop();
        return base !== "" && !CURRENT_IDLE_BASENAMES.includes(base);
      });
      if (mismatch) return true;
    }
  }
  return false;
}

// 读取当前 manifest：优先 localStorage 中用户自定义值，否则回退缺省清单。
// 若缓存为旧版（引用已更名的素材），清掉陈旧值并回退缺省清单。
export function loadDeskpetManifest(): DeskpetManifest {
  try {
    const raw = localStorage.getItem(DESKPET_MANIFEST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DeskpetManifest;
      if (parsed && Array.isArray(parsed.states) && parsed.states.length > 0) {
        if (isLegacyDeskpetManifest(parsed)) {
          // 陈旧清单：清除并回退缺省（含新文件名），下次保存即刷新
          try {
            localStorage.removeItem(DESKPET_MANIFEST_KEY);
          } catch {
            /* 忽略 */
          }
          return DESKPET_DEFAULT_MANIFEST;
        }
        return parsed;
      }
    }
  } catch {
    /* 解析失败使用默认值 */
  }
  return DESKPET_DEFAULT_MANIFEST;
}

export function saveDeskpetManifest(m: DeskpetManifest): void {
  localStorage.setItem(DESKPET_MANIFEST_KEY, JSON.stringify(m));
}
