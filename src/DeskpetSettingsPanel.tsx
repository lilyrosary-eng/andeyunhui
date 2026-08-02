import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Sparkles } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import {
  DeskpetManifest,
  loadDeskpetManifest,
  saveDeskpetManifest,
  inferDeskpetAsset,
  DeskpetPreset,
  loadDeskpetPresets,
  saveDeskpetPresets,
  loadActivePresetId,
  saveActivePresetId,
  cloneOfficialManifest,
  normalizeManifestSources,
} from '@/deskpetManifest';

// 桌宠素材缩略图：从外部依赖包直接读取字节并预览（图片/视频）
function PetAssetThumb({ rel, mime }: { rel: string; mime: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<string>('read_external_dep_bytes', { relativePath: rel })
      .then((b64) => {
        if (alive) setUrl(`data:${mime};base64,${b64}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [rel, mime]);
  if (!url) return <div className="w-12 h-12 rounded-lg bg-neutral-100 dark:bg-stone-700 animate-pulse" />;
  if (mime.startsWith('video')) {
    return <video src={url} muted loop autoPlay playsInline className="w-12 h-12 rounded-lg object-cover" />;
  }
  return <img src={url} alt="" className="w-12 h-12 rounded-lg object-cover" />;
}

/**
 * 桌宠详细设置面板：原本位于「全局设置 · 常规」的「桌宠」分区，
 * 现抽出作为「茑萝」侧边栏「桌宠」项打开的面板（主程序组件，复用同一套状态与下发逻辑，
 * 经 localStorage + 全局事件与浮窗 / 插件同步）。全局设置里仅保留一个「显示桌宠」总开关。
 */
export function DeskpetSettingsPanel() {
  const { t } = useI18n();
  // ---- 桌宠 Phase A 基础设置（缩放 / 透明度 / 点击穿透）----
  // 与插件 / 浮窗共享 localStorage['deskpet:settings']：面板写入并全局 emit，
  // 浮窗直接收到应用；插件监听更新缓存并持久化，并在浮窗请求时回复。
  const DESKPET_SETTINGS_KEY = 'deskpet:settings';
  const [deskpetScale, setDeskpetScale] = useState(1);
  const [deskpetOpacity, setDeskpetOpacity] = useState(1);
  const [deskpetClickThrough, setDeskpetClickThrough] = useState(false);

  // 启动时从 localStorage 恢复缓存值（与插件 / 浮窗对齐）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DESKPET_SETTINGS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as {
          scale?: number;
          opacity?: number;
          clickThrough?: boolean;
        };
        if (typeof p.scale === 'number') setDeskpetScale(p.scale);
        if (typeof p.opacity === 'number') setDeskpetOpacity(p.opacity);
        if (typeof p.clickThrough === 'boolean') setDeskpetClickThrough(p.clickThrough);
      }
    } catch {
      /* 忽略解析失败 */
    }
  }, []);

  // 持久化并下发（浮窗经全局 emit 直接收到；插件监听并更新缓存）
  const pushDeskpetSettings = useCallback(
    (next: { scale: number; opacity: number; clickThrough: boolean }) => {
      try {
        localStorage.setItem(DESKPET_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* 忽略持久化失败 */
      }
      emit('deskpet:settings', next).catch(() => {});
    },
    [],
  );

  // ---- 桌宠素材清单（manifest）：用户可导入自己的图片/视频 ----
  // 与插件 / 浮窗共享 localStorage['deskpet:manifest']：面板写入并全局 emit，
  // 浮窗直接收到应用；插件监听更新缓存并在浮窗请求时回复。
  const [petManifest, setPetManifest] = useState<DeskpetManifest>(() => loadDeskpetManifest());
  const [petTargetState, setPetTargetState] = useState<string>('idle');
  const [petNewState, setPetNewState] = useState<string>('');
  const [petImportError, setPetImportError] = useState<string>('');

  const pushPetManifest = useCallback(
    (next: DeskpetManifest) => {
      setPetManifest(next);
      try {
        saveDeskpetManifest(next);
      } catch {
        /* 忽略持久化失败 */
      }
      emit('deskpet:manifest', next).catch(() => {});
    },
    [],
  );

  // ---- 桌宠预设：每个方案 = manifest + 基础设置，独立保存可切换 ----
  const [presets, setPresets] = useState<DeskpetPreset[]>(() => loadDeskpetPresets());
  const [activePresetId, setActivePresetId] = useState<string | null>(() => loadActivePresetId());
  const [newPresetName, setNewPresetName] = useState('');

  // 官方基线设置（缩放/透明度/穿透），用于「官方默认」与「新建预设」清空当前
  const OFFICIAL_SETTINGS = { scale: 1, opacity: 1, clickThrough: false };

  const applyPreset = useCallback((p: DeskpetPreset) => {
    const manifest = normalizeManifestSources(p.manifest);
    pushPetManifest(manifest);
    pushDeskpetSettings(p.settings);
    setDeskpetScale(p.settings.scale);
    setDeskpetOpacity(p.settings.opacity);
    setDeskpetClickThrough(p.settings.clickThrough);
  }, [pushPetManifest, pushDeskpetSettings]);

  // 选中预设：'' 表示「官方默认」基线，始终从官方清单干净还原（不携带任何自定义素材）
  const handleSelectPreset = useCallback((id: string) => {
    if (id === '') {
      const manifest = cloneOfficialManifest();
      setActivePresetId(null);
      saveActivePresetId(null);
      pushPetManifest(manifest);
      pushDeskpetSettings(OFFICIAL_SETTINGS);
      setDeskpetScale(OFFICIAL_SETTINGS.scale);
      setDeskpetOpacity(OFFICIAL_SETTINGS.opacity);
      setDeskpetClickThrough(OFFICIAL_SETTINGS.clickThrough);
      return;
    }
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setActivePresetId(id);
    saveActivePresetId(id);
    applyPreset(p);
  }, [presets, applyPreset, pushPetManifest, pushDeskpetSettings]);

  // 新建预设：从官方基线开始（清空当前的素材/设置），每套预设独立、互不串味。
  // 关键：不克隆正在编辑的 live manifest，避免把上一个方案的自定义素材带过来。
  const handleNewPreset = useCallback(() => {
    const id = `preset-${Date.now()}`;
    const name = newPresetName.trim() || `方案 ${presets.length + 1}`;
    const preset: DeskpetPreset = {
      id,
      name,
      manifest: cloneOfficialManifest(),
      settings: { ...OFFICIAL_SETTINGS },
    };
    const next = [...presets, preset];
    setPresets(next);
    saveDeskpetPresets(next);
    setActivePresetId(id);
    saveActivePresetId(id);
    setNewPresetName('');
    applyPreset(preset); // 立即切到干净官方基线，等于「清空当前」
  }, [presets, newPresetName, applyPreset]);

  // 保存当前预设：当前是「官方默认」时另存为新自定义预设（保护官方基线不被覆盖）；
  // 否则原地更新当前激活的自定义预设。
  const handleSavePreset = useCallback(() => {
    const settings = { scale: deskpetScale, opacity: deskpetOpacity, clickThrough: deskpetClickThrough };
    if (activePresetId === null) {
      const id = `preset-${Date.now()}`;
      const name = newPresetName.trim() || `我的方案 ${presets.length + 1}`;
      const preset: DeskpetPreset = {
        id,
        name,
        manifest: normalizeManifestSources(petManifest),
        settings,
      };
      const next = [...presets, preset];
      setPresets(next);
      saveDeskpetPresets(next);
      setActivePresetId(id);
      saveActivePresetId(id);
      setNewPresetName('');
      return;
    }
    const next = presets.map((p) =>
      p.id === activePresetId ? { ...p, manifest: normalizeManifestSources(petManifest), settings } : p,
    );
    setPresets(next);
    saveDeskpetPresets(next);
    setNewPresetName('');
  }, [presets, activePresetId, petManifest, deskpetScale, deskpetOpacity, deskpetClickThrough]);

  const handleDeletePreset = useCallback((id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    saveDeskpetPresets(next);
    if (activePresetId === id) {
      setActivePresetId(null);
      saveActivePresetId(null);
    }
  }, [presets, activePresetId]);

  const handleRenamePreset = useCallback((id: string, name: string) => {
    const next = presets.map((p) => (p.id === id ? { ...p, name } : p));
    setPresets(next);
    saveDeskpetPresets(next);
  }, [presets]);

  // 导入本地图片/视频作为桌宠素材：复制到 user_external_deps/deskpet-assets/pet/，并写入 manifest
  const handleImportPetAsset = useCallback(async () => {
    setPetImportError('');
    const targetId = petTargetState === '__new__' ? petNewState.trim() : petTargetState;
    if (!targetId) {
      setPetImportError('请选择或填写目标状态名称');
      return;
    }
    try {
      const picked = await invoke<string[]>('pick_file', {
        title: '选择桌宠图片或视频',
        filters: [
          {
            name: '图片/视频',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'ogg'],
          },
        ],
      });
      if (!picked || picked.length === 0) return;
      const src = picked[0];
      const fname = src.split(/[\\/]/).pop() || 'asset';
      const rel = await invoke<string>('import_deskpet_asset', { sourcePath: src, filename: fname });
      const { kind, mime } = inferDeskpetAsset(fname);
      const next: DeskpetManifest = {
        states: petManifest.states.map((s) =>
          s.id === targetId ? { ...s, assets: [...s.assets, { file: fname, rel, kind, mime, source: 'user' }] } : s,
        ),
      };
      if (!next.states.some((s) => s.id === targetId)) {
        next.states.push({ id: targetId, label: targetId, assets: [{ file: fname, rel, kind, mime, source: 'user' }] });
      }
      setPetNewState('');
      pushPetManifest(next);
    } catch (err) {
      setPetImportError(String(err));
    }
  }, [petManifest, petTargetState, petNewState, pushPetManifest]);

  const removePetAsset = useCallback(
    (stateId: string, rel: string) => {
      const next: DeskpetManifest = {
        states: petManifest.states.map((s) =>
          s.id === stateId ? { ...s, assets: s.assets.filter((a) => a.rel !== rel) } : s,
        ),
      };
      pushPetManifest(next);
    },
    [petManifest, pushPetManifest],
  );

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-stone-950">
      <div className="max-w-2xl mx-auto px-6 py-6">
        {/* 桌宠：显隐 + Phase A 基础设置（缩放 / 透明度 / 点击穿透） */}
        <section>
          <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
            <Sparkles size={14} />
            {t('deskpet.title')}
          </h2>
          <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
            {/* 使用引导：官方素材 / 自定义素材 / 预设隔离 一句话讲清 */}
            <div className="p-4 bg-amber-50/60 dark:bg-amber-900/10">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 mb-1.5">
                <Sparkles size={13} />
                {t('deskpet.guide')}
              </div>
              <ul className="text-xs text-neutral-600 dark:text-stone-300 space-y-1 leading-relaxed list-disc pl-4">
                <li><span className="font-medium text-amber-700 dark:text-amber-400">{t('deskpet.officialAssets')}</span>：{t('deskpet.officialAssetsDesc')}</li>
                <li><span className="font-medium text-sky-600 dark:text-sky-400">{t('deskpet.customAssets')}</span>：{t('deskpet.customAssetsDesc')}</li>
                <li><span className="font-medium text-emerald-600 dark:text-emerald-400">{t('deskpet.presets')}</span>：{t('deskpet.presetsDesc')}</li>
                <li>{t('deskpet.formatSupport')}</li>
              </ul>
            </div>
            {/* 缩放 */}
            <div className="p-4">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm text-neutral-600 dark:text-stone-300">{t('deskpet.scale')}</span>
                <span className="text-xs text-neutral-500 dark:text-stone-400">{Math.round(deskpetScale * 100)}%</span>
              </div>
              <Slider
                value={[deskpetScale]}
                onValueChange={([v]: number[]) => {
                  const s = v;
                  setDeskpetScale(s);
                  pushDeskpetSettings({ scale: s, opacity: deskpetOpacity, clickThrough: deskpetClickThrough });
                }}
                min={0.5}
                max={1.5}
                step={0.05}
                className="slider-themed"
              />
            </div>
            {/* 透明度 */}
            <div className="p-4">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm text-neutral-600 dark:text-stone-300">{t('deskpet.opacity')}</span>
                <span className="text-xs text-neutral-500 dark:text-stone-400">{Math.round(deskpetOpacity * 100)}%</span>
              </div>
              <Slider
                value={[deskpetOpacity]}
                onValueChange={([v]: number[]) => {
                  const o = v;
                  setDeskpetOpacity(o);
                  pushDeskpetSettings({ scale: deskpetScale, opacity: o, clickThrough: deskpetClickThrough });
                }}
                min={0.2}
                max={1}
                step={0.05}
                className="slider-themed"
              />
            </div>
            {/* 点击穿透 */}
            <div className="flex justify-between items-center p-4">
              <div>
                <span className="text-sm font-medium block">{t('deskpet.clickThrough')}</span>
                <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{t('deskpet.clickThroughDesc')}</p>
              </div>
              <Switch
                checked={deskpetClickThrough}
                onCheckedChange={(val: boolean) => {
                  setDeskpetClickThrough(val);
                  pushDeskpetSettings({ scale: deskpetScale, opacity: deskpetOpacity, clickThrough: val });
                }}
                className="data-[state=checked]:bg-[var(--element-color-raw)]"
              />
            </div>
            {/* 自定义素材：导入自己的图片 / 视频，按状态绑定 */}
            <div className="p-4 space-y-3">
              <div>
                <span className="text-sm font-medium block">{t('deskpet.customMaterial')}</span>
                <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{t('deskpet.customMaterialDesc')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={petTargetState}
                  onChange={(e) => setPetTargetState(e.target.value)}
                  className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                >
                  {petManifest.states.map((s) => (
                    <option key={s.id} value={s.id}>{s.label || s.id}</option>
                  ))}
                  <option value="__new__">+ {t('deskpet.newState')}</option>
                </select>
                {petTargetState === '__new__' && (
                  <input
                    value={petNewState}
                    onChange={(e) => setPetNewState(e.target.value)}
                    placeholder={t('deskpet.newStateName')}
                    className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)] w-28"
                  />
                )}
                <button
                  onClick={() => void handleImportPetAsset()}
                  className="btn-press px-3 py-1.5 rounded-lg bg-[var(--element-color-raw)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  {t('deskpet.importBtn')}
                </button>
              </div>
              {petImportError && (
                <p className="text-xs text-red-500">{t('deskpet.importFailed', { err: petImportError })}</p>
              )}
              <div className="space-y-2">
                {petManifest.states.map((s) => (
                  <div key={s.id}>
                    <div className="text-xs text-neutral-500 dark:text-stone-400 mb-1">{s.label || s.id}</div>
                    {s.assets.length === 0 ? (
                      <div className="text-xs text-neutral-400 dark:text-stone-500">{t('deskpet.noAssets')}</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {s.assets.map((a) => (
                          <div key={a.rel} className="relative group">
                            <PetAssetThumb rel={a.rel} mime={a.mime} />
                            <button
                              onClick={() => removePetAsset(s.id, a.rel)}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                              title={t('deskpet.remove')}
                            >
                              ×
                            </button>
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className={`text-[10px] px-1 rounded shrink-0 ${a.source === 'official' ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400'}`}>{a.source === 'official' ? t('deskpet.official') : t('deskpet.custom')}</span>
                              <span className="text-[10px] text-neutral-400 dark:text-stone-500 truncate max-w-[40px]">{a.file}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* 预设方案：每套方案（manifest+设置）独立保存、切换；新建从官方基线清空当前，防止串味 */}
            <div className="p-4 space-y-3 border-t border-neutral-200/50 dark:border-stone-700/50">
              <div>
                <span className="text-sm font-medium block">{t('deskpet.presets')}</span>
                <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{t('deskpet.presetsDesc')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={activePresetId ?? ''}
                  onChange={(e) => handleSelectPreset(e.target.value)}
                  className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                >
                  <option value="">{t('deskpet.officialDefault')}</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder={t('deskpet.presetName')}
                  className="px-2 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-300 outline-none focus:ring-2 focus:ring-[var(--element-border)] w-28"
                />
                <button
                  onClick={() => handleNewPreset()}
                  className="btn-press px-3 py-1.5 rounded-lg bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-200 text-sm font-medium border border-neutral-200/50 dark:border-stone-600/50 hover:bg-neutral-50 dark:hover:bg-stone-600"
                >
                  {t('deskpet.newPreset')}
                </button>
                <button
                  onClick={() => handleSavePreset()}
                  className="btn-press px-3 py-1.5 rounded-lg bg-[var(--element-color-raw)] text-white text-sm font-medium hover:opacity-90"
                >
                  {t('deskpet.savePreset')}
                </button>
              </div>
              {presets.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <div key={p.id} className="flex items-center gap-1 bg-neutral-100 dark:bg-stone-700 rounded-lg px-2 py-1">
                      <span className="text-xs text-neutral-700 dark:text-stone-200">{p.name}</span>
                      {activePresetId === p.id && <span className="text-[10px] text-emerald-500">{t('deskpet.current')}</span>}
                      <button
                        onClick={() => { const n = window.prompt(t('deskpet.renamePrompt'), p.name); if (n) handleRenamePreset(p.id, n.trim()); }}
                        className="text-xs text-neutral-400 hover:text-amber-500"
                        title={t('deskpet.rename')}
                      >{t('deskpet.renameShort')}</button>
                      <button
                        onClick={() => handleDeletePreset(p.id)}
                        className="text-xs text-neutral-400 hover:text-red-500"
                        title={t('deskpet.delete')}
                      >{t('deskpet.deleteShort')}</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
