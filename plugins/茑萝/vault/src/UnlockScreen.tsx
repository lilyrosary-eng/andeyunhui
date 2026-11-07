/// <reference path="../../../global.d.ts" />
// 解锁 / 首次创建 / 备用码兜底。三件事共用一张居中卡片：未建库 → 创建；已建库未解锁 → 解锁。
const React = window.__HOST_REACT__;
const { useState } = React;

import { datedFileName, vaultApi, type VaultStatus } from './api';
import type { VaultHook } from './useVault';

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70 outline-none focus:border-[var(--element-muted)]';

const primaryBtn =
  'px-4 py-2 rounded-lg text-sm font-medium bg-[var(--element-muted)] text-[var(--element-bg)] disabled:opacity-50';
const ghostBtn =
  'px-3 py-2 rounded-lg text-sm hairline hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50';

function ShieldMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function RecoveryCodesDialog({
  codes,
  onDone,
  title = '备用验证码（只显示这一次）',
}: {
  codes: string[];
  onDone: () => void;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const saveFile = async () => {
    setSaveMsg(null);
    try {
      const path = await vaultApi.pickSavePath(datedFileName('vault-recovery-codes', 'txt'));
      if (!path) return;
      const content = [
        '安得云荟 · 密码库备用验证码',
        `生成时间：${new Date().toLocaleString()}`,
        '每个码只能使用一次；请离线保存，不要放进云端同步笔记。',
        '',
        ...codes,
      ].join('\n');
      await vaultApi.writeTextFile(path, content);
      setSaveMsg(`已保存到：${path}`);
    } catch (e) {
      setSaveMsg(`保存失败：${typeof e === 'string' ? e : String(e)}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-lg rounded-2xl bg-[#f5f5f0] dark:bg-[#1c1917] p-5 shadow-2xl">
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          忘记主密码时，任选一个码 + 新主密码即可重置。每个码只能使用一次，请离线抄写保存；关闭后无法再次查看。
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono text-[13px]">
          {codes.map((code) => (
            <div key={code} className="px-2 py-1.5 rounded-md bg-white/70 dark:bg-stone-800/60 select-all">
              {code}
            </div>
          ))}
        </div>
        {saveMsg && <div className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400 break-all">{saveMsg}</div>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={copyAll} className={ghostBtn}>
            {copied ? '已复制全部' : '复制全部'}
          </button>
          <button onClick={saveFile} className={ghostBtn}>
            保存为文件
          </button>
          <button onClick={onDone} className={primaryBtn}>
            我已保存
          </button>
        </div>
      </div>
    </div>
  );
}

export function VaultOnboarding({
  run,
  minPasswordChars = 8,
  busy = false,
  error = null,
  onCreated,
}: {
  run: VaultHook['run'];
  minPasswordChars?: number;
  busy?: boolean;
  error?: string | null;
  /** 备用码只在创建时出现一次：交给父组件持有，避免本组件被主界面替换后丢失 */
  onCreated: (codes: string[]) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deviceUnlock, setDeviceUnlock] = useState(true);
  const [autoLock, setAutoLock] = useState(5);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    setLocalError(null);
    if (password.length < minPasswordChars) return setLocalError(`主密码至少 ${minPasswordChars} 位`);
    if (password !== confirm) return setLocalError('两次输入的主密码不一致');
    const outcome = await run(() => vaultApi.create(password, deviceUnlock, autoLock));
    if (outcome) {
      setPassword('');
      setConfirm('');
      onCreated(outcome.recoveryCodes);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6 bg-[#f5f5f0] dark:bg-[#1c1917]" data-vault-ui>
      <div className="w-full max-w-md rounded-2xl bg-white/70 dark:bg-stone-900/60 p-6 shadow-sm">
        <div className="flex items-center gap-3 text-[var(--element-bg)]">
          <ShieldMark />
          <div>
            <div className="text-base font-semibold text-neutral-800 dark:text-stone-100">创建密码库</div>
            <div className="text-xs text-neutral-500 dark:text-stone-400">
              数据只留在本机；主密码无法找回，只能靠备用码重置。
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">主密码（≥ {minPasswordChars} 位）</div>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
              placeholder="建议用生成器产出的高强度密码"
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">再次输入</div>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              className={inputCls}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-stone-300">
            <input type="checkbox" checked={deviceUnlock} onChange={(e) => setDeviceUnlock(e.target.checked)} />
            启用本机免密解锁（绑定当前系统账户与机器；换机/改名后需用主密码）
          </label>

          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-stone-300">
            闲置自动锁定
            <select
              value={autoLock}
              onChange={(e) => setAutoLock(Number(e.target.value))}
              className="px-2 py-1 rounded-md bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70 text-xs"
            >
              {[1, 5, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} 分钟
                </option>
              ))}
            </select>
          </label>
        </div>

        {localError && <div className="mt-3 text-xs text-red-600 dark:text-red-400">{localError}</div>}
        {!localError && error && (
          <div className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</div>
        )}

        <div className="mt-5 flex justify-end">
          <button onClick={submit} disabled={busy} className={primaryBtn}>
            {busy ? '创建中…（首次 KDF 较慢）' : '创建并生成备用码'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UnlockScreen({
  status,
  run,
  busy,
  error,
}: {
  status: VaultStatus;
  run: VaultHook['run'];
  busy: boolean;
  error: string | null;
}) {
  const [password, setPassword] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const unlock = async () => {
    setNotice(null);
    if (!password) return;
    await run(() => vaultApi.unlock(password));
  };

  const unlockByDevice = async () => {
    setNotice(null);
    await run(() => vaultApi.unlockDevice());
  };

  const unlockByBiometric = async () => {
    setNotice(null);
    await run(() => vaultApi.unlockBiometric());
  };

  const redeem = async () => {
    setNotice(null);
    const outcome = await run(() => vaultApi.redeemRecovery(code, newPassword));
    if (outcome) {
      setNotice(`已重置主密码。剩余可用备用码：${outcome.remainingRecoveryCodes} 个。`);
      setRecoveryMode(false);
      setCode('');
      setNewPassword('');
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6 bg-[#f5f5f0] dark:bg-[#1c1917]" data-vault-ui>
      <div className="w-full max-w-md rounded-2xl bg-white/70 dark:bg-stone-900/60 p-6 shadow-sm">
        <div className="flex items-center gap-3 text-[var(--element-bg)]">
          <ShieldMark />
          <div>
            <div className="text-base font-semibold text-neutral-800 dark:text-stone-100">密码库已锁定</div>
            <div className="text-xs text-neutral-500 dark:text-stone-400">
              {/* 锁定态读不到加密后的 meta，autoLockMin 只能是默认值，不在这里报具体分钟数 */}
              闲置自动锁定 · 备用码剩余 {status.recoverySlots} 个
            </div>
          </div>
        </div>

        {!recoveryMode ? (
          <div className="mt-5 flex flex-col gap-3">
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unlock();
              }}
              placeholder="主密码"
              className={inputCls}
            />
            <button onClick={unlock} disabled={busy || !password} className={primaryBtn}>
              {busy ? '解锁中…' : '解锁'}
            </button>
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                {status.biometricRequired && status.hasDeviceSlot ? (
                  <button onClick={unlockByBiometric} disabled={busy} className={ghostBtn}>
                    🖐 Windows Hello 解锁
                  </button>
                ) : status.hasDeviceSlot ? (
                  <button onClick={unlockByDevice} disabled={busy} className={ghostBtn}>
                    本机免密解锁
                  </button>
                ) : (
                  <span className="text-[11px] text-neutral-400 dark:text-stone-500">
                    未启用本机免密解锁
                  </span>
                )}
                {!status.biometricRequired && status.hasDeviceSlot && status.biometricSupported && (
                  <button onClick={unlockByBiometric} disabled={busy} className={ghostBtn}>
                    🖐 Windows Hello 解锁
                  </button>
                )}
              </div>
              <button
                onClick={() => {
                  setRecoveryMode(true);
                  setNotice(null);
                }}
                className="text-xs text-neutral-500 hover:text-neutral-700 dark:text-stone-400 dark:hover:text-stone-200"
              >
                忘记主密码？
              </button>
            </div>
            {status.biometricRequired && (
              <div className="text-[11px] text-neutral-400 dark:text-stone-500">
                本机解锁已要求生物识别（{status.biometricDetail}）
              </div>
            )}
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            <div className="text-xs text-neutral-500 dark:text-stone-400">
              输入任一备用验证码，并设置新的主密码。备用码用掉即作废。
            </div>
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXXX-XXXXX-XXXXX"
              className={`${inputCls} font-mono`}
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={`新主密码（≥ ${status.minPasswordChars} 位）`}
              className={inputCls}
            />
            <div className="flex items-center justify-between">
              <button onClick={() => setRecoveryMode(false)} className={ghostBtn}>
                返回
              </button>
              <button onClick={redeem} disabled={busy || !code || newPassword.length < status.minPasswordChars} className={primaryBtn}>
                {busy ? '重置中…' : '重置主密码'}
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</div>}
        {notice && <div className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">{notice}</div>}
      </div>
    </div>
  );
}
