// 黄金棋盘浮岛 · 资源监视子面板（两种密度）。
// 与主窗口 ResourceMonitor 共用后端命令 get_resource_usage、共享数据层（@/components/resource/）
// 与**同一份 GPU 选择**。配色走浮岛深色系，不复用主窗口浅色卡片。
//
//   · 精简（默认）：2×2 四张卡 —— CPU / GPU 占用 / 显存占用 / 内存占用
//   · 全部（标题栏「全部」按钮）：在四项之后追加「网络速率」与「每个分区的空间占用 +
//     实时读/写速度 + 活动度」，多块被选中的 GPU 也逐块展开。
//
// ★ 底色加深：浮岛本体是「棋盘底纹(18,18,20 @0.45) + 轻暗叠层(@0.16→0.26)」的半透明结构，
//   桌面会透上来，读数（尤其是 10px 的小字和曲线）糊在底纹上根本看不清。
//   这里给资源监视面板**局部**补一层近不透明深底（只影响本面板，不动其他子面板的整体观感）。
//
// ★ 滚动：浮岛本体是 overflow:hidden 的定高窗口（RESOURCE_H = 344），本面板是唯一出口。
//   「全部」模式的内容必然超出该高度，因此网格容器必须保留 overflowY:'auto' ——
//   这是把内容从「被裁掉、滚不动」变成「可滚动查看」的关键，勿删。
import { Fragment, useState } from 'react';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { useI18n } from '@/lib/i18n';
import { KeepButton } from '@/components/KeepButton';
import {
  fmtBytes,
  fmtFreq,
  fmtPercent,
  fmtPower,
  fmtSpeed,
  levelColor,
  shortGpuName,
  vramPercent,
} from '@/components/resource/model';
import type { DiskUsage } from '@/components/resource/model';
import { useResourceUsage } from '@/components/resource/useResourceUsage';
import { NO_GPUS, useSyncedGpuSelection } from '@/components/resource/gpuSelection';
import { GpuPicker } from '@/components/resource/GpuPicker';
import { btnBase, GOLD } from './constants';
import { IconClose, IconGauge } from './icons';

const VRAM_COLOR = '#a78bfa';
const NA_COLOR = '#8b8b93';
const DISK_WARN = '#f7b955';
const DISK_BAD = '#ff6b6b';
const DISK_OK = '#4ade80';
// 深底上的网络配色（比主窗口浅底版更亮，保证 10.5px 小字可读）
const NET_DOWN_COLOR = '#38bdf8';
const NET_UP_COLOR = '#2dd4bf';

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
  bar = true,
  wide = false,
}: {
  title: string;
  value: string;
  unit?: string;
  color: string;
  percent: number;
  detail: string;
  /** 第二行附属读数（频率 / 功耗 / 磁盘 IO） */
  sub?: string;
  /** 是否画占用条（网络这种「速率」类指标没有百分比，画条会误导） */
  bar?: boolean;
  /** 横跨两列（内容较长的分区卡 / 网络卡） */
  wide?: boolean;
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
        gridColumn: wide ? '1 / -1' : undefined,
      }}
    >
      <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>{title}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: 12, fontWeight: 600, color }}>{unit}</span>}
      </div>
      {bar && <MiniBar percent={percent} color={color} />}
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

/** 单分区：空间占用 + 实时读/写速度 + 活动度（全部模式专属，横跨两列） */
function DiskTile({ d }: { d: DiskUsage }) {
  const { t } = useI18n();
  const pct = Math.max(0, Math.min(100, d.percent));
  return (
    <Tile
      wide
      title={`${t('capsule.res.disk')} · ${d.mount}`}
      value={pct.toFixed(0)}
      unit="%"
      color={pct > 85 ? DISK_BAD : pct > 60 ? DISK_WARN : DISK_OK}
      percent={pct}
      detail={`${fmtBytes(d.used_kb)} / ${fmtBytes(d.total_kb)}`}
      sub={
        `${t('capsule.res.read')} ${d.read_bps == null ? '—' : fmtSpeed(d.read_bps)}` +
        ` · ${t('capsule.res.write')} ${d.write_bps == null ? '—' : fmtSpeed(d.write_bps)}` +
        ` · ${t('capsule.res.activity')} ${fmtPercent(d.activity, 0)}`
      }
    />
  );
}

function CapsuleResource() {
  const { t } = useI18n();
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  const setResourceOpen = useCapsuleStore((s) => s.setResourceOpen);

  const [paused, setPaused] = useState(false);
  // 密度开关：false = 精简 2×2（只四项）；true = 全部（追加网络 + 逐分区磁盘 + 逐块 GPU）。
  // 不持久化：每次重开面板回到精简视图，避免上次的「全部」把首屏撑成滚动列表。
  const [all, setAll] = useState(false);
  const { data, error } = useResourceUsage(paused);

  const gpus = data?.gpus ?? NO_GPUS;
  const shownGpus = useSyncedGpuSelection(gpus);
  // 精简版面只放得下四张卡：GPU / 显存都取**第一块被选中**的卡；
  // 「全部」模式把所有被选中的卡逐块展开（信息不丢，靠滚动看）。
  const multi = shownGpus.length > 1;
  const renderGpus = all ? shownGpus : shownGpus.slice(0, 1);
  /** 全局序号（与主窗口面板的 GPU1/GPU2 对齐，便于跨面板对照） */
  const gpuOrd = (id: string) => gpus.findIndex((x) => x.id === id) + 1;

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
        {/* 密度切换：全部 ↔ 精简 */}
        <button
          onClick={() => setAll((v) => !v)}
          title={all ? t('capsule.res.briefHint') : t('capsule.res.allHint')}
          style={{
            ...btnBase,
            flex: '0 0 auto',
            padding: '4px 8px',
            fontSize: 11,
            borderRadius: 8,
            color: all ? '#1a1a1c' : GOLD,
            background: all ? GOLD : 'rgba(230,195,92,0.14)',
          }}
        >
          {all ? t('capsule.res.brief') : t('capsule.res.all')}
        </button>
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

            {/* GPU 占用 / 显存占用：精简=第 1 块；全部=逐块展开（占用与显存成对相邻） */}
            {renderGpus.map((g) => {
              const vramPct = vramPercent(g);
              const suffix = multi ? ` #${gpuOrd(g.id)}` : '';
              return (
                <Fragment key={g.id}>
                  <Tile
                    title={`${t('capsule.res.gpu')}${suffix}`}
                    value={g.util_percent != null ? g.util_percent.toFixed(1) : 'N/A'}
                    unit={g.util_percent != null ? '%' : undefined}
                    color={g.util_percent != null ? levelColor(g.util_percent, true) : NA_COLOR}
                    percent={g.util_percent ?? 0}
                    detail={shortGpuName(g.name)}
                    sub={`${fmtFreq(g.clock_mhz)} · ${fmtPower(g.power_w)}`}
                  />
                  <Tile
                    title={`${t('capsule.res.vram')}${suffix}`}
                    value={vramPct != null ? vramPct.toFixed(0) : 'N/A'}
                    unit={vramPct != null ? '%' : undefined}
                    color={vramPct == null ? NA_COLOR : vramPct > 85 ? DISK_BAD : vramPct > 60 ? DISK_WARN : VRAM_COLOR}
                    percent={vramPct ?? 0}
                    detail={
                      g.vram_total_kb != null && g.vram_used_kb != null
                        ? `${fmtBytes(g.vram_used_kb)} / ${fmtBytes(g.vram_total_kb)}`
                        : t('capsule.res.unsupported')
                    }
                    sub={vramPct == null ? shortGpuName(g.name) : undefined}
                  />
                </Fragment>
              );
            })}

            {/* 一块都没选中 / 本机没有可监视适配器时的占位 */}
            {renderGpus.length === 0 && (
              <Tile
                wide
                bar={false}
                title={t('capsule.res.gpu')}
                value="N/A"
                color={NA_COLOR}
                percent={0}
                detail={gpus.length ? t('capsule.res.gpuNotSelected') : t('capsule.res.unsupported')}
              />
            )}

            <Tile
              title={t('capsule.res.mem')}
              value={data.mem_percent.toFixed(1)}
              unit="%"
              color={levelColor(data.mem_percent, true)}
              percent={data.mem_percent}
              detail={`${fmtBytes(data.mem_used_kb)} / ${fmtBytes(data.mem_total_kb)}`}
            />

            {/* ── 以下是「全部」模式追加的内容 ── */}
            {all && (
              <>
                <Tile
                  wide
                  bar={false}
                  title={t('capsule.res.net')}
                  value={`↓ ${fmtSpeed(data.net_down_bps)}`}
                  color={NET_DOWN_COLOR}
                  percent={0}
                  detail={`↑ ${fmtSpeed(data.net_up_bps)}`}
                />
                {data.disks.map((d) => (
                  <DiskTile key={d.mount} d={d} />
                ))}
                {data.disks.length === 0 && (
                  <Tile
                    wide
                    bar={false}
                    title={t('capsule.res.disk')}
                    value="N/A"
                    color={NA_COLOR}
                    percent={0}
                    detail={t('capsule.res.noDisk')}
                  />
                )}
              </>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(244,244,246,0.38)', textAlign: 'center' }}>
            {all
              ? t('capsule.res.allNote')
              : `${t('capsule.res.note')}${multi ? ` · ${t('capsule.res.multiGpu')} ${shownGpus.length}` : ''}`}
          </div>
        </>
      )}
    </div>
  );
}

export default CapsuleResource;
