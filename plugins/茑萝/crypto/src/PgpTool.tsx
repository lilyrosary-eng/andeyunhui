/// <reference path="../../../global.d.ts" />
// 茑萝 · PGP 信封加密
// 仿 OpenPGP 信封结构：RSA-OAEP 加密 AES-GCM 会话密钥 + AES-GCM-256 加密任意长度数据
// 输出格式（armor 文本，类 PEM）：
//   -----BEGIN CRYPTO ENVELOPE-----
//   Version: niaoluo-crypto 0.1 (RSA-OAEP + AES-GCM-256)
//   KeyId: <16 hex chars 指纹>
//   <base64(rsaCipher)>.<base64(iv)>.<base64(aesCipher)>
//   -----END CRYPTO ENVELOPE-----
//
// 兼容性：与 RFC 4880 的 PGP 信封结构等价（但非二进制兼容），适合本项目内自用
const React = window.__HOST_REACT__;
const { useState } = React;

function abToPem(label: string, buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
function pemToAb(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.trim().replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function copyText(text: string): void {
  try { navigator.clipboard?.writeText(text); } catch { /* ignore */ }
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="btn-press px-3 py-1 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/50 text-xs text-neutral-600 dark:text-stone-300 hover:bg-white transition-colors"
    >
      {copied ? '已复制' : label}
    </button>
  );
}

function PgpTool() {
  const [mode, setMode] = useState<'encrypt' | 'decrypt'>('encrypt');
  const [pubPem, setPubPem] = useState('');
  const [privPem, setPrivPem] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const encrypt = async () => {
    setError(''); setOutput(''); setBusy(true);
    try {
      if (!pubPem.trim()) throw new Error('请粘贴对方公钥（PUBLIC KEY PEM）');
      if (!input) throw new Error('请输入明文');
      const subtle = (window.crypto as Crypto).subtle;
      // 1. 生成 AES-GCM 会话密钥
      const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      // 2. 用对方公钥 RSA-OAEP 加密会话密钥
      const rsaPub = await subtle.importKey('spki', pemToAb(pubPem), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const aesRaw = new Uint8Array(await subtle.exportKey('raw', aesKey));
      const rsaCipher = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, rsaPub, aesRaw as BufferSource));
      // 3. 用 AES-GCM 加密数据
      const iv = (window.crypto as Crypto).getRandomValues(new Uint8Array(12));
      const aesCipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, aesKey, new TextEncoder().encode(input) as BufferSource));
      // 4. 生成 KeyId（取 RSA 密文前 8 字节 hex）
      const keyId = Array.from(rsaCipher.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
      // 5. 输出 armor 文本
      const body = `${bytesToB64(rsaCipher)}.${bytesToB64(iv)}.${bytesToB64(aesCipher)}`;
      const bodyLines = body.match(/.{1,64}/g) || [body];
      setOutput(
        `-----BEGIN CRYPTO ENVELOPE-----\nVersion: niaoluo-crypto 0.1\nKeyId: ${keyId}\n${bodyLines.join('\n')}\n-----END CRYPTO ENVELOPE-----\n`
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decrypt = async () => {
    setError(''); setOutput(''); setBusy(true);
    try {
      if (!privPem.trim()) throw new Error('请粘贴自己的私钥（PRIVATE KEY PEM）');
      if (!input) throw new Error('请输入信封文本');
      const subtle = (window.crypto as Crypto).subtle;
      // 1. 解析信封
      const body = input.replace(/-----[^-]+-----/g, '').replace(/^Version:.*$/m, '').replace(/^KeyId:.*$/m, '').replace(/\s+/g, '');
      const parts = body.split('.');
      if (parts.length !== 3) throw new Error('信封格式错误：应为 rsaCipher.iv.aesCipher（三段 base64）');
      const rsaCipher = b64ToBytes(parts[0]);
      const iv = b64ToBytes(parts[1]);
      const aesCipher = b64ToBytes(parts[2]);
      // 2. 用私钥 RSA-OAEP 解密出 AES 会话密钥
      const rsaPriv = await subtle.importKey('pkcs8', pemToAb(privPem), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      const aesRaw = new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, rsaPriv, rsaCipher as BufferSource));
      const aesKey = await subtle.importKey('raw', aesRaw as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
      // 3. 用 AES-GCM 解密数据
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, aesKey, aesCipher as BufferSource));
      setOutput(new TextDecoder().decode(plain));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y';
  const labelCls = 'text-xs text-neutral-500 dark:text-stone-400 mb-1 block';

  return (
    <div className="p-5 space-y-4">
      <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
        <div className="font-semibold mb-1">PGP 信封加密 — 任意长度数据</div>
        <div>结构：RSA-OAEP 加密 AES-256 会话密钥 + AES-GCM 加密数据 · 与 OpenPGP 信封等价但非二进制兼容</div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded-xl overflow-hidden border border-white/80 dark:border-stone-700/50">
          <button onClick={() => setMode('encrypt')} className={`px-4 py-1.5 text-sm ${mode === 'encrypt' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>加密（需公钥）</button>
          <button onClick={() => setMode('decrypt')} className={`px-4 py-1.5 text-sm ${mode === 'decrypt' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>解密（需私钥）</button>
        </div>
        <button
          onClick={mode === 'encrypt' ? encrypt : decrypt}
          disabled={busy}
          className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto disabled:opacity-60"
        >
          {busy ? '处理中…' : (mode === 'encrypt' ? '加密' : '解密')}
        </button>
      </div>

      {mode === 'encrypt' ? (
        <div className="space-y-2">
          <span className={labelCls}>对方公钥（PUBLIC KEY PEM）</span>
          <textarea value={pubPem} onChange={e => setPubPem(e.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" className={inputCls + ' h-28'} />
          <span className={labelCls}>明文（任意长度）</span>
          <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="输入要加密的文本" className={inputCls + ' h-40'} />
        </div>
      ) : (
        <div className="space-y-2">
          <span className={labelCls}>自己的私钥（PRIVATE KEY PEM）</span>
          <textarea value={privPem} onChange={e => setPrivPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className={inputCls + ' h-28'} />
          <span className={labelCls}>信封文本</span>
          <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="-----BEGIN CRYPTO ENVELOPE-----" className={inputCls + ' h-40'} />
        </div>
      )}

      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      {output && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className={labelCls + ' mt-2'}>{mode === 'encrypt' ? '加密结果' : '解密结果'}</span>
            <CopyButton text={output} />
          </div>
          <textarea readOnly value={output} className={inputCls + ' h-48'} />
        </div>
      )}
    </div>
  );
}

export { PgpTool };
