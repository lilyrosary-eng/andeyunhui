import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/lib/i18n';

// 全局接收确认弹窗：独立于任何传输面板挂载于主窗根，确保无论当前打开的是主窗传输标签页还是浮岛，
// 收到传输请求都会弹出确认框。否则接收端未打开传输面板时确认框不出现，发送端会 30s 超时失败
// （正是「只能接收、没法发送」的根因：发送目标的对端没有在监听该事件）。
// 同时兼容 Rust 两种载荷形态（alias/files 或 sender_alias/file_names）。
interface ReceiveFile {
  file_id?: string;
  file_name?: string;
  size?: number;
}
interface ReceiveRequest {
  session_id: string;
  alias?: string;
  sender_alias?: string;
  files?: ReceiveFile[];
  file_names?: string[];
}

function fmtSize(n?: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const GOLD = '#e6c35c';
const btn: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: GOLD,
  padding: '5px 12px',
  fontSize: 12,
  borderRadius: 8,
  cursor: 'pointer',
};

export default function TransferReceiveModal() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<ReceiveRequest[]>([]);
  const [saveDirError, setSaveDirError] = useState<{ path: string; reason: string } | null>(null);

  useEffect(() => {
    const offs: Array<() => void> = [];
    listen<ReceiveRequest>('transfer-receive-request', (e) => {
      const p = e.payload;
      if (!p?.session_id) return;
      setQueue((q) => (q.some((x) => x.session_id === p.session_id) ? q : [...q, p]));
    })
      .then((u) => offs.push(u))
      .catch(() => {});
    // 浮岛（黄金棋盘）作为主接收方：若它已接管该请求，主窗不再弹确认框
    listen<{ session_id?: string }>('transfer-receive-capsule-took', (e) => {
      const sid = e?.payload?.session_id;
      if (sid) setQueue((q) => q.filter((x) => x.session_id !== sid));
    })
      .then((u) => offs.push(u))
      .catch(() => {});
    const drop = (ev: { payload: { session_id?: string } }) => {
      if (ev?.payload?.session_id) {
        setQueue((q) => q.filter((x) => x.session_id !== ev.payload.session_id));
      }
    };
    listen<{ session_id?: string }>('transfer-receive-confirmed', drop)
      .then((u) => offs.push(u))
      .catch(() => {});
    listen<{ session_id?: string }>('transfer-receive-declined', drop)
      .then((u) => offs.push(u))
      .catch(() => {});
    // 首次保存失败兜底：后端写不进默认目录（如 C:\Program Files\send 无权限）时弹出目录选择框
    listen<{ path: string; reason: string }>('transfer:save-dir-invalid', (e) => {
      if (e?.payload?.path) setSaveDirError(e.payload);
    })
      .then((u) => offs.push(u))
      .catch(() => {});
    return () => offs.forEach((f) => f());
  }, []);

  const pickSaveDir = async () => {
    const dir = (await invoke('pick_directory').catch(() => null)) as string | null;
    if (dir) {
      await invoke('transfer_set_save_dir', { dir }).catch(() => {});
    }
    setSaveDirError(null);
  };

  const current = queue[0];

  // 保存目录不可用兜底：弹系统目录选择框，用户选定后后续接收落到新目录
  if (saveDirError) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }}
      >
        <div
          style={{
            background: '#1c1c1e',
            borderRadius: 12,
            padding: 16,
            width: 320,
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f6f6f8' }}>{t('transferReceive.cannotSave')}</div>
          <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.62)', marginTop: 6, wordBreak: 'break-all' }}>
            {saveDirError.path}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.45)', marginTop: 4 }}>{saveDirError.reason}</div>
          <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.45)', marginTop: 6 }}>
            {t('transferReceive.chooseWritableDir')}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            <button onClick={() => setSaveDirError(null)} style={btn}>
              {t('transferReceive.later')}
            </button>
            <button
              onClick={pickSaveDir}
              style={{ ...btn, color: '#1c1c1e', background: GOLD, fontWeight: 600 }}
            >
              {t('transferReceive.chooseDir')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!current) return null;

  const alias = current.alias || current.sender_alias || t('transferReceive.peer');
  const files: ReceiveFile[] = current.files?.length
    ? current.files
    : (current.file_names || []).map((name) => ({ file_name: name }));

  const accept = async () => {
    await invoke('transfer_receive_accept', { sessionId: current.session_id }).catch(() => {});
    setQueue((q) => q.filter((x) => x.session_id !== current.session_id));
  };
  const decline = async () => {
    await invoke('transfer_receive_decline', { sessionId: current.session_id }).catch(() => {});
    setQueue((q) => q.filter((x) => x.session_id !== current.session_id));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: '#1c1c1e',
          borderRadius: 12,
          padding: 16,
          width: 300,
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f6f6f8' }}>
          {t('transferReceive.sendPrompt', { alias })}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.62)', marginTop: 6 }}>
          {t('transferReceive.fileCount', { n: files.length })}（
          {files
            .slice(0, 3)
            .map((f) => f.file_name || '')
            .join(t('transferReceive.listSep'))}
          {files.length > 3 ? '…' : ''}）
        </div>
        {files.length > 0 && (
          <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.45)', marginTop: 4 }}>
            {files.slice(0, 3).map((f, i) => (
              <div key={i}>
                {(f as ReceiveFile).file_name} · {fmtSize((f as ReceiveFile).size)}
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.45)', marginTop: 4 }}>
          {t('transferReceive.saveDirNote')}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={decline} style={btn}>
            {t('transferReceive.decline')}
          </button>
          <button onClick={accept} style={{ ...btn, color: '#1c1c1e', background: GOLD, fontWeight: 600 }}>
            {t('transferReceive.accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
