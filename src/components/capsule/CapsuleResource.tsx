// 黄金棋盘浮岛 · 资源监视子面板（紧凑版）。
// 与主窗口 ResourceMonitor 共用后端命令 get_resource_usage，但只展示用户指定的四项：
// CPU / GPU / 显存 / 内存（不含网络与磁盘）。配色走浮岛深色系，不复用主窗口浅色卡片。
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { useI18n } from '@/lib/i18n';
import { KeepButton } from '@/components/KeepButton';
import { btnBase, GOLD } from './constants';
import { IconClose, IconGauge } from './icons';

// 与后端 get_resource_usage 返回结构一致（只取本面板用到的字段）
interface ResourceUsage {
  cpu_percent: number;
  cpu_per_core: number[];
  mem_total_kb: number;
  mem_used_kb: number;
  mem_percent: number;
  gpu_percent: number | null;
  gpu_name: string | null;
  vram_total_kb: number | null;
  vram_used_kb: number | null;
}

const VRAM_COLOR = '#a78bfa';

// 占用率配色（深色底上提高亮度）：<60 绿，60-85 琥珀，>85 红
function levelColor(p: number): string {
  if (p > 85) return '#ff6b6b';
  if (p > 60) return '#f7b955';
  return '#4ade80';
}

function fmtBytes(kb: number): string {
  const gb = kb / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(kb / 1024).toFixed(0)} MB`;
}

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
}: {
  title: string;
  value: string;
  unit?: string;
  color: string;
  percent: number;
  detail: string;
}) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.55)' }}>{title}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: 12, fontWeight: 600, color }}>{unit}</span>}
      </div>
      <MiniBar percent={percent} color={color} />
      <span
        title={detail}
        style={{
          fontSize: 10.5,
          color: 'rgba(244,244,246,0.5)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {detail}
      </span>
    </div>
  );
}

function CapsuleResource() {
  const { t } = useI18n();
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  const setResourceOpen = useCapsuleStore((s) => s.setResourceOpen);

  const [data, setData] = useState<ResourceUsage | null>(null);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      if (pausedRef.current) return;
      try {
        const r = (await invoke('get_resource_usage')) as ResourceUsage;
        if (!alive) return;
        setData(r);
        setError('');
      } catch (e) {
        if (alive) setError((e as Error).message || String(e));
      }
    };
    fetchOnce();
    // 实时级：与主窗口一致，1s 轮询；面板关闭时组件卸载，定时器随之清除（空闲零开销）
    const id = window.setInterval(fetchOnce, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const vramPct =
    data && data.vram_total_kb && data.vram_used_kb != null
      ? (data.vram_used_kb / data.vram_total_kb) * 100
      : 0;

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px' }}
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
              color={levelColor(data.cpu_percent)}
              percent={data.cpu_percent}
              detail={`${data.cpu_per_core.length} ${t('capsule.res.cores')}`}
            />
            <Tile
              title={t('capsule.res.gpu')}
              value={data.gpu_percent != null ? data.gpu_percent.toFixed(1) : 'N/A'}
              unit={data.gpu_percent != null ? '%' : undefined}
              color={data.gpu_percent != null ? levelColor(data.gpu_percent) : '#8b8b93'}
              percent={data.gpu_percent ?? 0}
              detail={data.gpu_name ?? t('capsule.res.unsupported')}
            />
            <Tile
              title={t('capsule.res.vram')}
              value={data.vram_total_kb != null && data.vram_used_kb != null ? vramPct.toFixed(0) : 'N/A'}
              unit={data.vram_total_kb != null && data.vram_used_kb != null ? '%' : undefined}
              color={data.vram_total_kb != null ? VRAM_COLOR : '#8b8b93'}
              percent={vramPct}
              detail={
                data.vram_total_kb != null && data.vram_used_kb != null
                  ? `${fmtBytes(data.vram_used_kb)} / ${fmtBytes(data.vram_total_kb)}`
                  : t('capsule.res.unsupported')
              }
            />
            <Tile
              title={t('capsule.res.mem')}
              value={data.mem_percent.toFixed(1)}
              unit="%"
              color={levelColor(data.mem_percent)}
              percent={data.mem_percent}
              detail={`${fmtBytes(data.mem_used_kb)} / ${fmtBytes(data.mem_total_kb)}`}
            />
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(244,244,246,0.35)', textAlign: 'center' }}>
            {t('capsule.res.note')}
          </div>
        </>
      )}
    </div>
  );
}

export default CapsuleResource;
