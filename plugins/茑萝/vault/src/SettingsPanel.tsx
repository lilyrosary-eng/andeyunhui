/// <reference path="../../../global.d.ts" />
// 设置页：自动锁定、改主密码、轮换备用码、明文导出。
// 危险动作都做两步确认；明文导出会明确提示「这就是明文」。
const React = window.__HOST_REACT__;
const { useMemo, useState } = React;

import { datedFileName, vaultApi, type VaultItem, type VaultStatus } from './api';
import type { VaultHook } from './useVault';
import { RecoveryCodesDialog } from './UnlockScreen';
import { parseImport, toBitwardenCsv, toChromeCsv } from './importExport';

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70 outline-none focus:border-[var(--element-muted)]';
const primaryBtn =
  'px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--element-muted)] text-[var(--element-bg)] disabled:opacity-50';
const ghostBtn = 'px-3 py-1.5 rounded-md text-xs hairline hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50';
const sectionCls = 'rounded-xl bg-white/60 dark:bg-stone-900/40 p-4';

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  React.useEffect(() => {
    void (async () => {
      try {
        setJson(await vaultApi.exportJson());
      } catch (e) {
        setError(typeof e === 'string' ? e : String(e));
      }
    })();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-2xl rounded-2xl bg-[#f5f5f0] dark:bg-[#1c1917] p-5 shadow-2xl flex flex-col max-h-[80vh]">
        <div className="text-sm font-semibold">导出明文 JSON</div>
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          注意：导出内容包含所有密码的明文。请只保存到受信任位置，用完立即删除。
        </p>
        {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
        <textarea
          readOnly
          value={json ?? '生成中…'}
          className="mt-3 flex-1 min-h-[240px] p-3 rounded-lg font-mono text-[11px] bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70 resize-none"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={async () => {
              if (!json) return;
              try {
                await navigator.clipboard.writeText(json);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setCopied(false);
              }
            }}
            className={ghostBtn}
          >
            {copied ? '已复制' : '复制全部'}
          </button>
          <button onClick={onClose} className={primaryBtn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (n: number) => void;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const pickFile = async () => {
    setError(null);
    try {
      const picked = await vaultApi.pickImportFile();
      if (!picked) return;
      setText(picked.content);
      setFileName(picked.path);
    } catch (e) {
      setError(typeof e === 'string' ? e : String(e));
    }
  };

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { ok: true as const, ...parseImport(text) };
    } catch (e) {
      return { ok: false as const, error: typeof e === 'string' ? e : String(e) };
    }
  }, [text]);

  const doImport = async () => {
    if (!parsed || !parsed.ok || parsed.items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const n = await vaultApi.importItems(parsed.items, mode);
      onImported(n);
    } catch (e) {
      setError(typeof e === 'string' ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-2xl rounded-2xl bg-[#f5f0e8] dark:bg-[#1c1917] p-5 shadow-2xl flex flex-col max-h-[85vh]">
        <div className="text-sm font-semibold">导入 CSV / JSON</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          支持 Bitwarden、1Password、Chrome/Edge、KeePass 的导出文件，按表头自动识别。可直接选择文件，或把内容粘贴进来。
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button onClick={pickFile} className={ghostBtn}>
            选择文件…
          </button>
          <span className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
            {fileName ?? '未选择文件（也可直接粘贴）'}
          </span>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴 CSV 或 JSON…"
          className="mt-3 flex-1 min-h-[220px] p-3 rounded-lg font-mono text-[11px] bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70 resize-none"
        />
        <div className="mt-2 flex items-center gap-3 text-xs">
          {parsed && parsed.ok && (
            <span className="text-emerald-600 dark:text-emerald-400">
              识别为 {parsed.format === 'json' ? 'JSON' : parsed.format}：{parsed.items.length} 条
              {parsed.skipped > 0 ? `，跳过 ${parsed.skipped} 行` : ''}
            </span>
          )}
          {parsed && !parsed.ok && <span className="text-red-600 dark:text-red-400">{parsed.error}</span>}
          {!parsed && <span className="text-neutral-400 dark:text-stone-500">等待粘贴内容…</span>}
        </div>

        <div className="mt-3 flex items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} />
            合并（保留现有条目）
          </label>
          <label className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
            <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            覆盖（清空现有条目）
          </label>
        </div>

        {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className={ghostBtn}>
            取消
          </button>
          <button
            onClick={doImport}
            disabled={busy || !parsed || !parsed.ok || parsed.items.length === 0}
            className={primaryBtn}
          >
            {busy ? '导入中…' : '开始导入'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsPanel({
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
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdNotice, setPwdNotice] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [ioNotice, setIoNotice] = useState<string | null>(null);
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [destroyPwd, setDestroyPwd] = useState('');
  const [destroyAck, setDestroyAck] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);

  const copyCsv = async (kind: 'bitwarden' | 'chrome') => {
    setIoNotice(null);
    try {
      const items: VaultItem[] = await vaultApi.list();
      const csv = kind === 'bitwarden' ? toBitwardenCsv(items) : toChromeCsv(items);
      await navigator.clipboard.writeText(csv);
      setIoNotice(`已复制 ${kind === 'bitwarden' ? 'Bitwarden' : 'Chrome'} CSV（${items.length} 条）。`);
    } catch (e) {
      setIoNotice(`复制失败：${typeof e === 'string' ? e : String(e)}`);
    }
  };

  const saveCsvFile = async (kind: 'bitwarden' | 'chrome') => {
    setIoNotice(null);
    try {
      const items: VaultItem[] = await vaultApi.list();
      const csv = kind === 'bitwarden' ? toBitwardenCsv(items) : toChromeCsv(items);
      const path = await vaultApi.pickSavePath(
        datedFileName(kind === 'bitwarden' ? 'vault-bitwarden' : 'vault-chrome', 'csv'),
      );
      if (!path) return;
      await vaultApi.writeTextFile(path, csv);
      setIoNotice(`已保存 ${items.length} 条到：${path}`);
    } catch (e) {
      setIoNotice(`保存失败：${typeof e === 'string' ? e : String(e)}`);
    }
  };

  const saveJsonFile = async () => {
    setIoNotice(null);
    try {
      const json = await vaultApi.exportJson();
      const path = await vaultApi.pickSavePath(datedFileName('vault-export', 'json'));
      if (!path) return;
      await vaultApi.writeTextFile(path, json);
      setIoNotice(`已保存明文 JSON 到：${path}`);
    } catch (e) {
      setIoNotice(`保存失败：${typeof e === 'string' ? e : String(e)}`);
    }
  };

  const changePassword = async () => {
    setPwdError(null);
    setPwdNotice(null);
    if (next.length < status.minPasswordChars) return setPwdError(`新主密码至少 ${status.minPasswordChars} 位`);
    if (next !== confirm) return setPwdError('两次输入的新主密码不一致');
    const ok = await run(() => vaultApi.changePassword(current, next));
    if (ok) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwdNotice('主密码已更新；本机免密解锁与备用码仍然有效。');
    }
  };

  const rotate = async () => {
    if (!rotateConfirm) {
      setRotateConfirm(true);
      setTimeout(() => setRotateConfirm(false), 3000);
      return;
    }
    const result = await run(() => vaultApi.rotateRecoveryCodes());
    setRotateConfirm(false);
    if (result) setCodes(result);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className={sectionCls}>
        <div className="text-sm font-medium">自动锁定</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          超过设定时长没有任何密码库操作即自动锁定；解锁需要主密码或本机凭据。
        </p>
        <div className="mt-2 flex items-center gap-2">
          <select
            value={status.autoLockMin}
            disabled={busy}
            onChange={(e) => void run(() => vaultApi.setAutoLock(Number(e.target.value)))}
            className="px-2 py-1.5 rounded-md text-xs bg-white/80 dark:bg-stone-800/70 border border-neutral-200/80 dark:border-stone-700/70"
          >
            {[1, 5, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} 分钟
              </option>
            ))}
          </select>
          <button onClick={() => void run(() => vaultApi.lock())} className={ghostBtn}>
            立即锁定
          </button>
        </div>
      </div>

      <div className={sectionCls}>
        <div className="text-sm font-medium">修改主密码</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          只重包主密码槽位，正文密文不变；已绑定的本机解锁与备用码继续有效。
        </p>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="当前主密码"
            className={inputCls}
          />
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder={`新主密码（≥ ${status.minPasswordChars} 位）`}
            className={inputCls}
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再次输入新主密码"
            className={inputCls}
          />
        </div>
        {pwdError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{pwdError}</div>}
        {pwdNotice && <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{pwdNotice}</div>}
        <div className="mt-2 flex justify-end">
          <button onClick={changePassword} disabled={busy || !current || !next} className={primaryBtn}>
            更新主密码
          </button>
        </div>
      </div>

      <div className={sectionCls}>
        <div className="text-sm font-medium">备用验证码</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          当前剩余 {status.recoverySlots} 个。重新生成会让全部旧码立即失效。
        </p>
        <div className="mt-2 flex justify-end">
          <button onClick={rotate} disabled={busy} className={ghostBtn}>
            {rotateConfirm ? '确认作废旧码并重新生成？' : '重新生成备用码'}
          </button>
        </div>
      </div>

      <div className={sectionCls}>
        <div className="text-sm font-medium">导入 / 导出</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          导出均为明文，请只保存到受信任位置。加密导出（PGP/RSA 信封）留给后续版本。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => setImportOpen(true)} disabled={busy} className={ghostBtn}>
            导入文件 / 粘贴…
          </button>
          <button onClick={() => void saveCsvFile('bitwarden')} disabled={busy} className={ghostBtn}>
            保存 Bitwarden CSV
          </button>
          <button onClick={() => void saveCsvFile('chrome')} disabled={busy} className={ghostBtn}>
            保存 Chrome CSV
          </button>
          <button onClick={() => void saveJsonFile()} disabled={busy} className={ghostBtn}>
            保存明文 JSON
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => void copyCsv('bitwarden')} disabled={busy} className={ghostBtn}>
            复制 Bitwarden CSV
          </button>
          <button onClick={() => void copyCsv('chrome')} disabled={busy} className={ghostBtn}>
            复制 Chrome CSV
          </button>
          <button onClick={() => setExportOpen(true)} disabled={busy} className={ghostBtn}>
            查看明文 JSON
          </button>
        </div>
        {ioNotice && <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{ioNotice}</div>}
      </div>

      <div className={sectionCls}>
        <div className="text-sm font-medium">库信息</div>
        <div className="mt-1 text-xs text-neutral-500 dark:text-stone-400 leading-relaxed">
          <div>条目 {status.itemCount} 个 · 回收站 {status.trashedCount} 个</div>
          <div>本机免密解锁：{status.hasDeviceSlot ? '已启用' : '未启用'}</div>
          <div>文件位置：应用数据目录 vault/vault.json，内容变更前自动保留最近 5 份备份。</div>
        </div>
      </div>

      <div className={sectionCls}>
        <div className="text-sm font-medium">生物识别（Windows Hello）</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">{status.biometricDetail}</p>
        <p className="mt-1 text-[11px] text-neutral-400 dark:text-stone-500">
          状态每 30 秒自动重测：在系统「设置 → 账户 → 登录选项」里注册指纹/人脸后，无需重启应用。
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          开启后「本机免密解锁」会被禁用，必须通过 Windows Hello（指纹 / 人脸 / PIN）或主密码解锁。
          生物识别只作为本机槽位的门闸，不参与密钥派生。
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={
              busy ||
              !status.hasDeviceSlot ||
              (!status.biometricSupported && !status.biometricRequired)
            }
            onClick={() => void run(() => vaultApi.setBiometricRequired(!status.biometricRequired))}
            className={status.biometricRequired ? ghostBtn : primaryBtn}
          >
            {status.biometricRequired ? '关闭生物识别要求' : '开启：本机解锁须生物识别'}
          </button>
          {!status.hasDeviceSlot && (
            <span className="text-[11px] text-neutral-400 dark:text-stone-500">
              需先启用本机免密解锁
            </span>
          )}
        </div>
      </div>

      <div className="rounded-xl bg-red-500/5 dark:bg-red-500/10 p-4 border border-red-500/20">
        <div className="text-sm font-medium text-red-600 dark:text-red-400">移除密码库</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-stone-400">
          删除 vault.json 与全部滚动备份，不可恢复。需要再次输入主密码确认。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={destroyPwd}
            onChange={(e) => {
              setDestroyPwd(e.target.value);
              setDestroyError(null);
            }}
            placeholder="主密码"
            className={`${inputCls} max-w-xs`}
          />
          <button
            onClick={async () => {
              setDestroyError(null);
              if (!destroyPwd) {
                setDestroyError('请输入主密码');
                return;
              }
              if (!destroyAck) {
                setDestroyError('请先勾选下方确认项');
                return;
              }
              try {
                await vaultApi.destroy(destroyPwd);
                setDestroyPwd('');
                setDestroyAck(false);
                await run(async () => undefined);
              } catch (e) {
                setDestroyError(typeof e === 'string' ? e : String(e));
              }
            }}
            disabled={busy || !destroyPwd || !destroyAck}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            移除密码库
          </button>
        </div>
        <label className="mt-2 flex items-start gap-2 text-xs text-neutral-600 dark:text-stone-300">
          <input
            type="checkbox"
            checked={destroyAck}
            onChange={(e) => setDestroyAck(e.target.checked)}
            className="mt-0.5"
          />
          <span>我了解：库文件与全部滚动备份都会被删除，且无法恢复。</span>
        </label>
        {destroyError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{destroyError}</div>}
      </div>

      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(n) => {
            setImportOpen(false);
            setIoNotice(`已导入 ${n} 条。`);
          }}
        />
      )}
      {codes && <RecoveryCodesDialog codes={codes} onDone={() => setCodes(null)} />}
    </div>
  );
}
