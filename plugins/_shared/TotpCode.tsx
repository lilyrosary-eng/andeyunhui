/// <reference path="../global.d.ts" />
// 条目 TOTP 动态码展示（RFC 6238）。每 30 秒随周期重算，带倒计时与复制。
const React = window.__HOST_REACT__;
const { useEffect, useState } = React;

import { totp, totpProgress, totpRemainingSec } from './totp';

export function TotpCode({ secret }: { secret: string }) {
  const [now, setNow] = useState(Date.now());
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const cycle = Math.floor(now / 30_000);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    totp(secret)
      .then((value) => {
        if (alive) setCode(value);
      })
      .catch((e) => {
        if (alive) {
          setCode('');
          setError(typeof e === 'string' ? e : String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [secret, cycle]);

  if (error) {
    return <div className="mt-2 text-[11px] text-red-600 dark:text-red-400">TOTP 种子无效：{error}</div>;
  }

  const remaining = totpRemainingSec(now);
  const progress = totpProgress(now);
  const grouped = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

  return (
    <div className="mt-2 rounded-lg bg-white/70 dark:bg-stone-800/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-neutral-400 dark:text-stone-500">动态码</span>
        <code className="font-mono text-base tracking-wider tabular-nums">{grouped || '······'}</code>
        <div className="flex-1" />
        <span className="text-[11px] tabular-nums text-neutral-400 dark:text-stone-500">{remaining}s</span>
        <button
          onClick={async () => {
            if (!code) return;
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              setCopied(false);
            }
          }}
          className="text-[11px] px-2 py-0.5 rounded-md hairline hover:bg-black/5 dark:hover:bg-white/10"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="mt-1.5 h-0.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
        <div
          className="h-full bg-emerald-500/70"
          style={{ width: `${Math.round((1 - progress) * 100)}%` }}
        />
      </div>
    </div>
  );
}
