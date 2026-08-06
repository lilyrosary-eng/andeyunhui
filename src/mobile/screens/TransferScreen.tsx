/**
 * TransferScreen — 局域网传输屏（黄金棋盘 · 传输）。
 *
 * 导航位置：发现 Tab → 茑萝 → 传输（由 NiaoluoScreen push 入栈）。
 * 注意：传输 ≠ 中转站。中转站（transfer Tab 根屏 StationHome）是「文件暂存箱」，
 * 传输是「设备间发送/接收」能力，二者语义分离，与桌面端保持一致。
 *
 * 移动端传输主界面，复用 useTransfer hook 的全部状态：
 *   - 状态卡：服务运行态 + 别名 + 刷新
 *   - 暂存区：SAF 选中的待发文件
 *   - 对端列表：发现到的设备，点击发送
 *   - 进度列表：收/发实时进度
 *   - 接收请求 BottomSheet：入站传输确认
 *   - 确认发送 BottomSheet：暂存文件 → 指定对端
 *
 * AppBar 由 MobileApp 全局渲染（title="传输"），本组件仅渲染内容区。
 * BottomSheet 开合同步到 navStore.bottomSheetOpen，供 Android 返回键优先级拦截。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Send,
  RefreshCw,
  Smartphone,
  Monitor,
  Laptop,
  FileText,
  Check,
  X,
  Trash2,
  Inbox,
  Wifi,
  WifiOff,
  Plus,
  Settings2,
} from 'lucide-react';
import { useTransfer, type TransferPeer, type TransferProgressItem, type ReceiveRequest } from '../hooks/useTransfer';
import { BottomSheet } from '../components/BottomSheet';
import { useNavStore } from '../stores/navStore';
import { fmtSize } from '../../lib/formatSize';

/** 进度百分比。 */
function pct(p: TransferProgressItem): number {
  if (!p.total) return 0;
  return Math.min(100, Math.round((p.received / p.total) * 100));
}

/** 按 device_type 选图标。 */
function DeviceIcon({ type }: { type?: string | null }) {
  if (type === 'mobile') return <Smartphone size={22} />;
  if (type === 'desktop') return <Monitor size={22} />;
  return <Laptop size={22} />;
}

export function TransferScreen() {
  const t = useTransfer();
  const bottomSheetOpen = useNavStore((s) => s.bottomSheetOpen);
  const setBottomSheetOpen = useNavStore((s) => s.setBottomSheetOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 手动添加对端（组播/广播失效时的兜底）
  const [addPeerOpen, setAddPeerOpen] = useState(false);
  const [addPeerIp, setAddPeerIp] = useState('');
  const [addPeerErr, setAddPeerErr] = useState('');
  const [addingPeer, setAddingPeer] = useState(false);

  // 任意 BottomSheet 打开 → 同步到 navStore，供 Android 返回键拦截
  const anySheetOpen = settingsOpen || !!t.confirmPeer || t.receiveRequests.length > 0;
  useEffect(() => {
    setBottomSheetOpen(anySheetOpen);
    return () => setBottomSheetOpen(false);
  }, [anySheetOpen, setBottomSheetOpen]);

  const currentReceive = t.receiveRequests[0] ?? null;

  // 反向同步：Android 返回键把 navStore.bottomSheetOpen 置 false 时，关闭本地 sheet。
  // 否则返回键仅改了 nav 标志，本地 sheet 仍 open → 视觉上「返回键无反应」。
  // 仅在 navOpen 由 true→false 且本地仍有 sheet 打开时触发，避免循环。
  const { setConfirmPeer, declineReceive } = t;
  useEffect(() => {
    if (!bottomSheetOpen && anySheetOpen) {
      setSettingsOpen(false);
      setConfirmPeer(null);
      if (currentReceive) declineReceive(currentReceive.session_id);
    }
  }, [bottomSheetOpen, anySheetOpen, currentReceive, setConfirmPeer, declineReceive]);

  const activeProgress = useMemo(
    () => t.progress.filter((p) => !p.done),
    [t.progress],
  );
  const doneProgress = useMemo(
    () => t.progress.filter((p) => p.done),
    [t.progress],
  );

  return (
    <div
      className="flex flex-col h-full overflow-y-auto overscroll-contain"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      {/* ===== 状态卡 ===== */}
      <section className="px-4 pt-3">
        <div
          className="rounded-2xl p-4 bg-[var(--card)] border border-[var(--border)] flex items-center gap-3"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <span
            className="flex items-center justify-center rounded-xl shrink-0"
            style={{
              width: '44px',
              height: '44px',
              background: 'var(--element-muted)',
              color: 'var(--element-bg)',
            }}
          >
            {t.running ? <Wifi size={22} /> : <WifiOff size={22} />}
          </span>
          <div className="flex-1 min-w-0">
            <div
              className="font-semibold text-[var(--foreground)] truncate"
              style={{ fontSize: 'var(--m-text-headline)' }}
            >
              {t.alias}
            </div>
            <div
              className="flex items-center gap-1.5 text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              <span
                className="inline-block rounded-full"
                style={{
                  width: '8px',
                  height: '8px',
                  background: t.running ? 'var(--compute-local)' : 'var(--compute-down)',
                }}
              />
              {t.running ? `服务运行中 · 发现 ${t.peers.length} 台设备` : (t.startError ? `启动失败：${t.startError}` : '服务未开启')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => t.refresh()}
            aria-label="刷新"
            className="flex items-center justify-center shrink-0 text-[var(--foreground)] active:scale-95 transition-transform"
            style={{ width: 'var(--touch-min)', height: 'var(--touch-min)' }}
          >
            <RefreshCw size={20} className={t.peers.length === 0 ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="设置"
            className="flex items-center justify-center shrink-0 text-[var(--foreground)] active:scale-95 transition-transform"
            style={{ width: 'var(--touch-min)', height: 'var(--touch-min)' }}
          >
            <Settings2 size={20} />
          </button>
        </div>
      </section>

      {/* ===== 暂存区（有待发文件时显示） ===== */}
      {t.staged.length > 0 && (
        <section className="px-4 pt-3">
          <div className="rounded-2xl p-3 bg-[var(--card)] border border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <span
                className="font-medium text-[var(--foreground)]"
                style={{ fontSize: 'var(--m-text-label)' }}
              >
                待发送 · {t.staged.length}
              </span>
              <button
                type="button"
                onClick={() => t.setStaged([])}
                className="text-[var(--muted-foreground)] active:scale-95 transition-transform"
                style={{ fontSize: 'var(--m-text-caption)' }}
              >
                清空
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {t.staged.slice(0, 4).map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-[var(--foreground)] min-w-0"
                  style={{ fontSize: 'var(--m-text-caption)' }}
                >
                  <FileText size={14} className="shrink-0 text-[var(--muted-foreground)]" />
                  <span className="truncate flex-1">{fileNameOf(p)}</span>
                  <button
                    type="button"
                    onClick={() => t.setStaged((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-[var(--muted-foreground)] active:scale-90 transition-transform shrink-0"
                    aria-label="移除"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              {t.staged.length > 4 && (
                <div
                  className="text-[var(--muted-foreground)]"
                  style={{ fontSize: 'var(--m-text-caption)' }}
                >
                  …还有 {t.staged.length - 4} 个文件
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={t.addFiles}
              className="mt-2 flex items-center justify-center gap-1.5 w-full rounded-xl py-2 text-[var(--foreground)] border border-[var(--border)] active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              <Plus size={14} /> 添加更多
            </button>
          </div>
        </section>
      )}

      {/* ===== 对端列表 ===== */}
      <section className="px-4 pt-3">
        <div className="flex items-center justify-between mb-2 px-1">
          <h3
            className="font-medium text-[var(--muted-foreground)]"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            附近设备
          </h3>
          <button
            type="button"
            onClick={() => setAddPeerOpen(true)}
            className="flex items-center gap-1 text-[var(--element-bg)] active:opacity-70"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            <Plus size={14} /> 手动添加
          </button>
        </div>
        {t.peers.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center text-center py-10 rounded-2xl border border-dashed border-[var(--border)]"
          >
            <Inbox size={36} className="text-[var(--muted-foreground)] mb-2" />
            <p
              className="text-[var(--foreground)] mb-0.5"
              style={{ fontSize: 'var(--m-text-body)' }}
            >
              正在发现设备
            </p>
            <p
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              请确保双方均已开启传输服务且在同一局域网
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {t.peers.map((peer) => (
              <PeerRow key={peer.fingerprint} peer={peer} onSend={() => t.sendTo(peer)} />
            ))}
          </div>
        )}
      </section>

      {/* ===== 进度列表 ===== */}
      {(activeProgress.length > 0 || doneProgress.length > 0) && (
        <section className="px-4 pt-3">
          <h3
            className="font-medium text-[var(--muted-foreground)] mb-2 px-1"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            传输中
          </h3>
          <div className="flex flex-col gap-2">
            {activeProgress.map((p) => (
              <ProgressRow key={`${p.session_id}-${p.file_id}`} p={p} />
            ))}
            {doneProgress.map((p) => (
              <ProgressRow key={`${p.session_id}-${p.file_id}`} p={p} />
            ))}
          </div>
        </section>
      )}

      {/* ===== 发送错误提示 ===== */}
      {t.sendErr && (
        <section className="px-4 pt-3">
          <div
            className="rounded-xl p-3 text-[var(--destructive-foreground)]"
            style={{ fontSize: 'var(--m-text-caption)', background: 'var(--destructive)' }}
          >
            发送失败：{t.sendErr}
          </div>
        </section>
      )}

      {/* ===== 底部发送入口（无暂存文件时显示，引导选文件） ===== */}
      {t.staged.length === 0 && (
        <section className="px-4 pt-3 pb-4">
          <button
            type="button"
            onClick={t.addFiles}
            className="flex items-center justify-center gap-2 w-full rounded-2xl py-3.5 font-medium active:scale-[0.98] transition-transform"
            style={{
              fontSize: 'var(--m-text-label)',
              background: 'var(--element-bg)',
              color: 'var(--element-fg)',
            }}
          >
            <Send size={18} /> 选择文件发送
          </button>
        </section>
      )}

      {/* ===== 接收请求 BottomSheet ===== */}
      <BottomSheet
        open={!!currentReceive}
        onClose={() => {
          // auto_accept 会话后端已自动建会话，仅本地 dismissing；否则视为拒绝
          if (!currentReceive) return;
          if (currentReceive.auto_accept) {
            t.declineReceive(currentReceive.session_id); // no-op，仅移出队列
          } else {
            t.declineReceive(currentReceive.session_id);
          }
        }}
        title={currentReceive?.auto_accept ? '正在接收' : '收到文件'}
      >
        {currentReceive && <ReceiveContent req={currentReceive} />}
        {currentReceive && currentReceive.auto_accept ? (
          <div className="px-4 pb-4 pt-2">
            <button
              type="button"
              onClick={() => t.declineReceive(currentReceive.session_id)}
              className="w-full rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform"
              style={{
                fontSize: 'var(--m-text-label)',
                background: 'var(--element-bg)',
                color: 'var(--element-fg)',
              }}
            >
              知道了
            </button>
          </div>
        ) : (
          currentReceive && (
            <div className="flex gap-2 px-4 pb-4 pt-2">
              <button
                type="button"
                onClick={() => t.declineReceive(currentReceive.session_id)}
                className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
                style={{ fontSize: 'var(--m-text-label)' }}
              >
                拒绝
              </button>
              <button
                type="button"
                onClick={() => t.acceptReceive(currentReceive.session_id)}
                className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform"
                style={{
                  fontSize: 'var(--m-text-label)',
                  background: 'var(--element-bg)',
                  color: 'var(--element-fg)',
                }}
              >
                接收
              </button>
            </div>
          )
        )}
      </BottomSheet>

      {/* ===== 确认发送 BottomSheet ===== */}
      <BottomSheet
        open={!!t.confirmPeer}
        onClose={() => t.setConfirmPeer(null)}
        title={t.confirmPeer ? `发送到 ${t.confirmPeer.alias}` : ''}
      >
        {t.confirmPeer && (
          <>
            <div className="px-4 pb-2">
              <div
                className="text-[var(--muted-foreground)] mb-2"
                style={{ fontSize: 'var(--m-text-caption)' }}
              >
                共 {t.staged.length} 个文件：
              </div>
              <div className="flex flex-col gap-1.5 max-h-[30vh] overflow-y-auto">
                {t.staged.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[var(--foreground)] min-w-0"
                    style={{ fontSize: 'var(--m-text-caption)' }}
                  >
                    <FileText size={14} className="shrink-0 text-[var(--muted-foreground)]" />
                    <span className="truncate">{fileNameOf(p)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-2 px-4 pb-4 pt-2">
              <button
                type="button"
                onClick={() => t.setConfirmPeer(null)}
                className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
                style={{ fontSize: 'var(--m-text-label)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={t.confirmSend}
                className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform"
                style={{
                  fontSize: 'var(--m-text-label)',
                  background: 'var(--element-bg)',
                  color: 'var(--element-fg)',
                }}
              >
                发送
              </button>
            </div>
          </>
        )}
      </BottomSheet>

      {/* ===== 设置 BottomSheet ===== */}
      <BottomSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="传输设置">
        <div className="px-4 pb-4">
          {/* 别名 */}
          <div className="py-3 border-b border-[var(--border)]">
            <label
              className="block text-[var(--muted-foreground)] mb-1.5"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              设备名称
            </label>
            <input
              type="text"
              value={t.alias}
              onChange={(e) => {
                // 实时保存（带节流），避免真机 onBlur 不触发导致改名无效
                t.setAlias(e.target.value);
                t.applyAlias(e.target.value);
              }}
              onBlur={(e) => t.applyAlias(e.target.value)}
              className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
              style={{ fontSize: 'var(--m-text-body)' }}
            />
          </div>

          {/* 自动接收开关 */}
          <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
            <div>
              <div
                className="text-[var(--foreground)]"
                style={{ fontSize: 'var(--m-text-label)' }}
              >
                自动接收
              </div>
              <div
                className="text-[var(--muted-foreground)]"
                style={{ fontSize: 'var(--m-text-caption)' }}
              >
                开启后无需确认直接接收
              </div>
            </div>
            <Toggle on={t.autoAccept} onChange={t.toggleAutoAccept} />
          </div>

          {/* 保存目录 */}
          <div className="py-3">
            <div
              className="text-[var(--muted-foreground)] mb-1"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              接收文件保存到
            </div>
            <div
              className="text-[var(--foreground)] break-all"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              {t.saveDir || '应用私有目录'}
            </div>
          </div>
        </div>
      </BottomSheet>

      {/* ===== 手动添加对端 BottomSheet ===== */}
      <BottomSheet open={addPeerOpen} onClose={() => !addingPeer && setAddPeerOpen(false)} title="手动添加设备">
        <div className="px-4 pb-4">
          <label
            className="block text-[var(--muted-foreground)] mb-1.5"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            设备 IP
          </label>
          <input
            type="text"
            value={addPeerIp}
            onChange={(e) => setAddPeerIp(e.target.value)}
            placeholder="如 192.168.1.5"
            className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
            style={{ fontSize: 'var(--m-text-body)' }}
          />
          {addPeerErr && (
            <p className="mt-2 text-red-500" style={{ fontSize: 'var(--m-text-caption)' }}>
              {addPeerErr}
            </p>
          )}
          <button
            type="button"
            disabled={addingPeer || !addPeerIp.trim()}
            onClick={async () => {
              setAddingPeer(true);
              setAddPeerErr('');
              try {
                await t.addPeer(addPeerIp.trim());
                setAddPeerOpen(false);
                setAddPeerIp('');
              } catch (e) {
                setAddPeerErr(String(e));
              } finally {
                setAddingPeer(false);
              }
            }}
            className="mt-3 w-full rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform disabled:opacity-50"
            style={{
              fontSize: 'var(--m-text-label)',
              background: 'var(--element-bg)',
              color: 'var(--element-fg)',
            }}
          >
            {addingPeer ? '添加中…' : '添加'}
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}

/** 对端行。 */
function PeerRow({ peer, onSend }: { peer: TransferPeer; onSend: () => void }) {
  return (
    <button
      type="button"
      onClick={onSend}
      className="flex items-center gap-3 px-3 py-3 rounded-2xl bg-[var(--card)] border border-[var(--border)] text-left active:scale-[0.99] transition-transform"
    >
      <span
        className="flex items-center justify-center rounded-xl shrink-0"
        style={{
          width: '40px',
          height: '40px',
          background: 'var(--element-muted)',
          color: 'var(--element-bg)',
        }}
      >
        <DeviceIcon type={peer.device_type} />
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="font-medium text-[var(--foreground)] truncate"
          style={{ fontSize: 'var(--m-text-body)' }}
        >
          {peer.alias}
        </div>
        <div
          className="text-[var(--muted-foreground)] truncate"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          {peer.ip}
        </div>
      </div>
      <Send size={18} className="text-[var(--muted-foreground)] shrink-0" />
    </button>
  );
}

/** 进度行。 */
function ProgressRow({ p }: { p: TransferProgressItem }) {
  const isSend = p.direction === 'send';
  return (
    <div
      className="rounded-xl px-3 py-2.5 bg-[var(--card)] border border-[var(--border)]"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="shrink-0"
          style={{ color: isSend ? 'var(--compute-cloud)' : 'var(--compute-local)' }}
        >
          {p.done ? <Check size={14} /> : isSend ? <Send size={14} /> : <Inbox size={14} />}
        </span>
        <span
          className="flex-1 truncate text-[var(--foreground)]"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          {p.file_name}
        </span>
        <span
          className="text-[var(--muted-foreground)] shrink-0"
          style={{ fontSize: 'var(--m-text-overline)' }}
        >
          {p.done ? '完成' : `${pct(p)}%`}
        </span>
      </div>
      {!p.done && (
        <div
          className="w-full rounded-full overflow-hidden"
          style={{ height: '3px', background: 'var(--muted)' }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct(p)}%`,
              background: isSend ? 'var(--compute-cloud)' : 'var(--compute-local)',
            }}
          />
        </div>
      )}
      <div
        className="text-[var(--muted-foreground)] mt-1"
        style={{ fontSize: 'var(--m-text-overline)' }}
      >
        {isSend ? `→ ${p.peer_alias}` : `← ${p.peer_alias}`} · {fmtSize(p.received)} / {fmtSize(p.total)}
      </div>
    </div>
  );
}

/** 接收请求内容。 */
function ReceiveContent({ req }: { req: ReceiveRequest }) {
  const alias = req.alias || req.sender_alias || '未知设备';
  const names = req.file_names?.length
    ? req.file_names
    : req.files?.map((f) => f.file_name || '').filter(Boolean) || [];
  const count = req.file_count ?? names.length;
  return (
    <div className="px-4 pb-2">
      <div
        className="text-[var(--foreground)]"
        style={{ fontSize: 'var(--m-text-body)' }}
      >
        <span className="font-medium">{alias}</span> 想发送给你
      </div>
      <div
        className="text-[var(--muted-foreground)] mt-1"
        style={{ fontSize: 'var(--m-text-caption)' }}
      >
        共 {count} 个文件
      </div>
      {names.length > 0 && (
        <div className="flex flex-col gap-1 mt-2 max-h-[25vh] overflow-y-auto">
          {names.slice(0, 8).map((n, i) => (
            <div
              key={i}
              className="flex items-center gap-2 text-[var(--foreground)] min-w-0"
              style={{ fontSize: 'var(--m-text-caption)' }}
            >
              <FileText size={13} className="shrink-0 text-[var(--muted-foreground)]" />
              <span className="truncate">{n}</span>
            </div>
          ))}
          {names.length > 8 && (
            <div
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: 'var(--m-text-overline)' }}
            >
              …还有 {names.length - 8} 个
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 轻量开关（无外部依赖）。 */
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="relative shrink-0 rounded-full transition-colors"
      style={{
        width: '44px',
        height: '24px',
        background: on ? 'var(--element-bg)' : 'var(--muted)',
      }}
    >
      <span
        className="absolute top-0.5 rounded-full bg-white transition-transform"
        style={{
          width: '20px',
          height: '20px',
          transform: on ? 'translateX(22px)' : 'translateX(2px)',
        }}
      />
    </button>
  );
}

/** 从路径提取文件名。 */
function fileNameOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : p;
}
