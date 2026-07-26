// 桌宠素材清单（manifest）共享类型与工具。
// 状态可增删、每状态可绑多张图片/视频；用户可在设置面板导入自己的图片/视频。
// manifest 由设置面板写入 localStorage['deskpet:manifest'] 并全局 emit，
// 浮窗启动时也会向插件请求（插件从同源 localStorage 回复）。

export type DeskpetAsset = {
  file: string; // 文件名，如 idleface.png / mycat.webm
  rel: string; // 相对路径，如 "deskpet-assets/pet/idle1.png"
  kind: "image" | "video";
  mime: string;
  // 素材来源：官方 = 内置分发、不可被自定义覆盖基线；user = 用户自导入。
  // 用于设置面板区分标记，并支撑「官方默认」基线在预设切换时始终干净还原。
  source?: "official" | "user";
};

export type DeskpetStateDef = {
  id: string; // 状态标识，如 idle / work / 自定义
  label: string; // 展示名
  assets: DeskpetAsset[];
};

export type DeskpetManifest = {
  schemaVersion?: number; // 清单结构版本；低于当前值的内置默认清单会被回退重渲（见 loadDeskpetManifest）
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
// 清单结构版本：每当缺省 idle 帧集合等结构变化（如新增 idleup/idledown/idleright），
// 递增此值，让旧缓存的内置默认清单自动回退到最新缺省，避免浮窗停留在旧帧集合。
export const DESKPET_MANIFEST_SCHEMA = 2;
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

// 缺省清单：待机用完整 8 朝向多角度图（正脸/上/下/左/右/左上/右上/左下/右下），由鼠标方位选帧；
// 工作用 工作1(启动)/工作2(循环)/工作3(结束)，内存 >60% 时自动播放。
export const DESKPET_DEFAULT_MANIFEST: DeskpetManifest = {
  schemaVersion: DESKPET_MANIFEST_SCHEMA,
  states: [
    {
      id: "idle",
      label: "待机",
      assets: [
        { file: "idleface.png", rel: "deskpet-assets/pet/idleface.png", kind: "image", mime: "image/png" },
        { file: "idleup.png", rel: "deskpet-assets/pet/idleup.png", kind: "image", mime: "image/png" },
        { file: "idledown.png", rel: "deskpet-assets/pet/idledown.png", kind: "image", mime: "image/png" },
        { file: "idleleft.png", rel: "deskpet-assets/pet/idleleft.png", kind: "image", mime: "image/png" },
        { file: "idleright.png", rel: "deskpet-assets/pet/idleright.png", kind: "image", mime: "image/png" },
        { file: "idleleftup.png", rel: "deskpet-assets/pet/idleleftup.png", kind: "image", mime: "image/png" },
        { file: "idlerightup.png", rel: "deskpet-assets/pet/idlerightup.png", kind: "image", mime: "image/png" },
        { file: "idleleftdown.png", rel: "deskpet-assets/pet/idleleftdown.png", kind: "image", mime: "image/png" },
        { file: "idlerightdown.png", rel: "deskpet-assets/pet/idlerightdown.png", kind: "image", mime: "image/png" },
      ],
    },
    {
      id: "work",
      label: "工作",
      assets: [
        { file: "work1.webm", rel: "deskpet-assets/pet/work1.webm", kind: "video", mime: "video/webm" },
        { file: "work2.webm", rel: "deskpet-assets/pet/work2.webm", kind: "video", mime: "video/webm" },
        { file: "work3.webm", rel: "deskpet-assets/pet/work3.webm", kind: "video", mime: "video/webm" },
      ],
    },
    {
      id: "walk",
      label: "走动",
      assets: [
        { file: "walk.webm", rel: "deskpet-assets/pet/walk.webm", kind: "video", mime: "video/webm" },
      ],
    },
    {
      id: "sleep",
      label: "睡觉",
      assets: [
        { file: "sleep.webm", rel: "deskpet-assets/pet/sleep.webm", kind: "video", mime: "video/webm" },
      ],
    },
  ],
};

// 当前内置素材全部标记为「官方」：安装即带、作为不可被自定义覆盖的基线。
// 之后任何对默认清单的克隆都继承 source:'official'。
(DESKPET_DEFAULT_MANIFEST.states as DeskpetStateDef[]).forEach((s) =>
  s.assets.forEach((a) => {
    a.source = "official";
  }),
);

// 官方素材相对路径集合：用于把缺 source 的旧缓存清单资产归类为官方或自定义。
export const OFFICIAL_ASSET_RELS = new Set<string>(
  DESKPET_DEFAULT_MANIFEST.states.flatMap((s) => s.assets.map((a) => a.rel)),
);

// 深拷贝一份干净的官方基线清单（每次「新建预设」「切回官方默认」都从它开始，
// 不带任何用户自定义素材 —— 这是防止不同预设之间素材串味的核心）。
export function cloneOfficialManifest(): DeskpetManifest {
  return JSON.parse(JSON.stringify(DESKPET_DEFAULT_MANIFEST)) as DeskpetManifest;
}

// 归一化清单资产来源：给缺 source 的旧清单资产补齐标记。
// 缺省按 rel 是否在官方集合内判定官方/自定义，保证升级前后显示一致。
export function normalizeManifestSources(m: DeskpetManifest): DeskpetManifest {
  return {
    schemaVersion: m.schemaVersion,
    states: m.states.map((s) => ({
      ...s,
      assets: s.assets.map((a) => ({
        ...a,
        source: a.source ?? (OFFICIAL_ASSET_RELS.has(a.rel) ? "official" : "user"),
      })),
    })),
  };
}

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
// 内置视频已由 .mp4 重渲为带 Alpha 的 .webm：旧缓存清单若仍引用这些已删除的内置 mp4，
// 视为陈旧并回退缺省（webm），避免浮窗去加载不存在的 .mp4 而只显示兜底小球。
const STALE_BUILTIN_VIDEO_TOKENS = [
  "work1.mp4", "work2.mp4", "work3.mp4", "walk.mp4", "sleep.mp4",
];
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
      // 内置视频已重渲为 webm，缓存里残留的内置 .mp4 视为陈旧
      if (STALE_BUILTIN_VIDEO_TOKENS.some((tok) => t.includes(tok))) return true;
    }
  }
  // 内置 idle 状态：若文件名与当前缺省不一致、或 idle 为空（且非用户自定义 user_external_deps 目录），
  // 说明缓存的是改名前/损坏的「内置默认」清单，应回退到当前缺省。
  const idle = m.states.find((s) => s.id === "idle");
  const work = m.states.find((s) => s.id === "work");
  if (idle && Array.isArray(idle.assets) && work) {
    const idleBasenames = (idle.assets ?? [])
      .map((a) => ((a.file || a.rel || "").toLowerCase().split(/[\\/]/).pop() ?? ""))
      .filter(Boolean);
    const hasUserAsset = idleBasenames.some((b) => b.includes("user_external_deps"));
    if (!hasUserAsset) {
      // 缺帧检测：内置默认清单若少了当前缺省应有的朝向帧（如缺 idleup/idledown/idleright），
      // 说明是「加 8 朝向前的旧版」缓存。此时纯上/下/左/右方向无对应帧，宠物只能显示对角帧，
      // 用户感知为「上下左右不转向」。须回退到最新缺省以补齐全部朝向帧。
      // （仅对无 user_external_deps 自定义素材的内置清单回退，用户自定义清单不受影响。）
      const missingCanonical = CURRENT_IDLE_BASENAMES.some((b) => !idleBasenames.includes(b));
      const idleEmptyOrMismatch =
        idleBasenames.length === 0 ||
        idleBasenames.some((base) => !CURRENT_IDLE_BASENAMES.includes(base));
      if (idleEmptyOrMismatch || missingCanonical) return true;
    }
  }
  return false;
}

// 内置默认清单「结构陈旧」判定：无 user_external_deps 自定义素材、且 schemaVersion 低于当前值
// （缺失视为旧版）的内置默认清单，回退到最新缺省。有自定义素材的清单不会被误删。
function isStaleBuiltinManifest(m: DeskpetManifest): boolean {
  const schema = (m as { schemaVersion?: number }).schemaVersion;
  if (typeof schema === "number" && schema >= DESKPET_MANIFEST_SCHEMA) return false;
  const hasUser = m.states.some((s) =>
    (s.assets ?? []).some((a) => (a.rel || "").includes("user_external_deps")),
  );
  return !hasUser;
}

// 读取当前 manifest：优先 localStorage 中用户自定义值，否则回退缺省清单。
// 若缓存为旧版（引用已更名的素材，或内置默认清单结构版本过低缺新帧），清掉并回退缺省清单。
export function loadDeskpetManifest(): DeskpetManifest {
  try {
    const raw = localStorage.getItem(DESKPET_MANIFEST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DeskpetManifest;
      if (parsed && Array.isArray(parsed.states) && parsed.states.length > 0) {
        if (isLegacyDeskpetManifest(parsed) || isStaleBuiltinManifest(parsed)) {
          // 陈旧清单：清除并回退缺省（含新文件名），下次保存即刷新
          try {
            localStorage.removeItem(DESKPET_MANIFEST_KEY);
          } catch {
            /* 忽略 */
          }
          return normalizeManifestSources(DESKPET_DEFAULT_MANIFEST);
        }
        return normalizeManifestSources(parsed);
      }
    }
  } catch {
    /* 解析失败使用默认值 */
  }
  return normalizeManifestSources(DESKPET_DEFAULT_MANIFEST);
}

export function saveDeskpetManifest(m: DeskpetManifest): void {
  try {
    // 盖章当前结构版本，使后续读取不会因 schema 过低被回退（自定义清单同样需保留版本）。
    const stamped: DeskpetManifest = { ...m, schemaVersion: DESKPET_MANIFEST_SCHEMA };
    localStorage.setItem(DESKPET_MANIFEST_KEY, JSON.stringify(stamped));
  } catch {
    /* 忽略持久化失败 */
  }
}
