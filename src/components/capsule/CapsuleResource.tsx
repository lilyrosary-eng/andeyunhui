// 黄金棋盘浮岛 · 资源监视子面板（紧凑版）。
// 与主窗口 ResourceMonitor 共用后端命令 get_resource_usage、共享数据层（@/components/resource/）
// 与**同一份 GPU 选择**，但只展示用户指定的四项：CPU / GPU / 显存 / 内存（不含网络与磁盘）。
// 配色走浮岛深色系，不复用主窗口浅色卡片。
//
// ★ 底色加深：浮岛本体是「棋盘底纹(18,18,20 @0.45) + 轻暗叠层(@0.16→0.26)」的半透明结构，
//   桌面会透上来，读数（尤其是 10px 的小字和曲线）糊在底纹上根本看不清。
//   这里给资源监视面板**局部**补一层近不透明深底（只影响本面板，不动其他子面板的整体观感）。
import { useState } from 'react';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { useI18n } from '@/lib/i18n';
import { KeepButton } from '@/components/KeepButton';
import {
  fmtBytes,
  fmtFreq,
  fmtPower,
  levelColor,
  shortGpuName,
  vramPercent,
} from '@/components/resource/model';
import { useResourceUsage } from '@/components/resource/useResourceUsage';
import { NO_GPUS, useSyncedGpuSelection } from '@/components/resource/gpuSelection';
import { GpuPicker } from '@/components/resource/GpuPicker';
import { btnBase, GOLD } from './constants';
import { IconClose, IconGauge } from './icons';

const VRAM_COLOR = '#a78bfa';
const NA_COLOR = '#8b8b93';

function MiniBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.09)', overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          borderRadius: 2,
          width: `${Math.max(0, Math.min(100, percent))}%`,
          background: color,
          transition: 'width 500ms ease',
        }}
      />
    </div>
  );
}

function Tile({
  title,
  value,
  unit,
  color,
  percent,
  detail,
  sub,
}: {
  title: string;
  value: string;
  unit?: string;
  color: string;
  percent: number;
  detail: string;
  /** 第二行附属读数（频率 / 功耗 / 显卡名） */
  sub?: string;
}) {
  const lineStyle = {
    fontSize: 10.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  };
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.055)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: 10,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>{title}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: 12, fontWeight: 600, color }}>{unit}</span>}
      </div>
      <MiniBar percent={percent} color={color} />
      <span title={detail} style={{ ...lineStyle, color: 'rgba(244,244,246,0.55)' }}>
        {detail}
      </span>
      {sub && (
        <span title={sub} style={{ ...lineStyle, color: 'rgba(244,244,246,0.42)' }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function CapsuleResource() {
  const { t } = useI18n();
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  const setResourceOpen = useCapsuleStore((s) => s.setResourceOpen);

  const [paused, setPaused] = useState(false);
  const { data, error } = useResourceUsage(paused);

  const gpus = data?.gpus ?? NO_GPUS;
  const shownGpus = useSyncedGpuSelection(gpus);
  // 浮岛版面只放得下四张卡：GPU / 显存都取**第一块被选中**的卡。
  // 多选时的信息不丢——下面有一行提示说明还有几块，主窗口面板会全部展开。
  const gpu = shownGpus[0] ?? null;

  const vramPct = gpu ? vramPercent(gpu) : null;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        padding: '10px 12px 10px',
        // 局部加深底色：alpha 0.93/0.96 ≈ 不透明，把棋盘底纹与桌面挡在外面
        background: 'linear-gradient(160deg, rgba(10,10,12,0.93), rgba(6,6,8,0.96))',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 标题栏（与传输/搜索子面板同一版式） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            flex: '0 0 40px',
            background: 'rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: GOLD,
          }}
        >
          <IconGauge />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8' }}>{t('capsule.action.resource')}</div>
          <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.62)' }}>
            {data ? (paused ? t('capsule.paused') : t('capsule.liveNow')) : t('capsule.collecting')}
          </div>
        </div>
        <GpuPicker
          gpus={gpus}
          tone="dark"
          iconOnly
          labels={{
            trigger: t('capsule.res.gpuPick'),
            title: t('capsule.res.gpuPickTitle'),
            all: t('capsule.res.gpuAll'),
            none: t('capsule.res.gpuNone'),
            footer: t('capsule.res.gpuFooter'),
          }}
        />
        <button
          onClick={() => setPaused((p) => !p)}
          title={paused ? t('capsule.resume') : t('capsule.pause')}
          style={{
            ...btnBase,
            flex: '0 0 auto',
            padding: '4px 8px',
            fontSize: 11,
            borderRadius: 8,
            color: '#f2f2f4',
            background: 'rgba(255,255,255,0.06)',
          }}
        >
          {paused ? t('capsule.resume') : t('capsule.pause')}
        </button>
        <KeepButton pinned={keepOpen} onToggle={() => setKeepOpen(!keepOpen)} size={28} />
        <button onClick={() => setResourceOpen(false)} title={t('capsule.backToPlayer')} style={{ ...btnBase, width: 28, height: 28 }}>
          <IconClose />
        </button>
      </div>

      {error && (
        <div
          style={{
            marginTop: 10,
            fontSize: 11.5,
            color: '#ffb4b4',
            background: 'rgba(255,107,107,0.12)',
            border: '1px solid rgba(255,107,107,0.28)',
            borderRadius: 9,
            padding: '8px 10px',
          }}
        >
          {t('capsule.collectFailed')}：{error}
        </div>
      )}

      {!data && !error && (
        <div style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: 'rgba(244,244,246,0.5)' }}>
          {t('capsule.collecting')}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              marginTop: 10,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              alignContent: 'start',
            }}
          >
            <Tile
              title={t('capsule.res.cpu')}
              value={data.cpu_percent.toFixed(1)}
              unit="%"
              color={levelColor(data.cpu_percent, true)}
              percent={data.cpu_percent}
              detail={`${data.cpu_per_core.length} ${t('capsule.res.cores')} · ${fmtFreq(data.cpu_freq_mhz)}`}
              sub={`${t('capsule.res.power')} ${fmtPower(data.cpu_power_w)}`}
            />
            <Tile
              title={t('capsule.res.gpu')}
              value={gpu?.util_percent != null ? gpu.util_percent.toFixed(1) : 'N/A'}
              unit={gpu?.util_percent != null ? '%' : undefined}
              color={gpu?.util_percent != null ? levelColor(gpu.util_percent, true) : NA_COLOR}
              percent={gpu?.util_percent ?? 0}
              detail={gpu ? shortGpuName(gpu.name) : gpus.length ? t('capsule.res.gpuNotSelected') : t('capsule.res.unsupported')}
              sub={gpu ? `${fmtFreq(gpu.clock_mhz)} · ${fmtPower(gpu.power_w)}` : undefined}
            />
            <Tile
              title={t('capsule.res.vram')}
              value={vramPct != null ? vramPct.toFixed(0) : 'N/A'}
              unit={vramPct != null ? '%' : undefined}
              color={vramPct == null ? NA_COLOR : vramPct > 85 ? '#ff6b6b' : vramPct > 60 ? '#f7b955' : VRAM_COLOR}
              percent={vramPct ?? 0}
              detail={
                gpu && gpu.vram_total_kb != null && gpu.vram_used_kb != null
                  ? `${fmtBytes(gpu.vram_used_kb)} / ${fmtBytes(gpu.vram_total_kb)}`
                  : t('capsule.res.unsupported')
              }
              sub={gpu && vramPct == null ? shortGpuName(gpu.name) : undefined}
            />
            <Tile
              title={t('capsule.res.mem')}
              value={data.mem_percent.toFixed(1)}
              unit="%"
              color={levelColor(data.mem_percent, true)}
              percent={data.mem_percent}
              detail={`${fmtBytes(data.mem_used_kb)} / ${fmtBytes(data.mem_total_kb)}`}
            />
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(244,244,246,0.38)', textAlign: 'center' }}>
            {t('capsule.res.note')}
            {shownGpus.length > 1 && ` · ${t('capsule.res.multiGpu')} ${shownGpus.length}`}
          </div>
        </>
      )}
    </div>
  );
}

export default CapsuleResource;
