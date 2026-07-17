/// <reference path="../../../global.d.ts" />
// 茑萝 · RSA 密钥对：生成 / 加解密 / 签名 / 验签
// 零依赖，全用 Web Crypto API
// 注意：RSA-OAEP 单次加密长度受限于 modulusLength - 2*hashLength - 2（2048 位时约 190 字节）
//       长文本请使用 PgpTool 的混合信封加密
const React = window.__HOST_REACT__;
const { useState } = React;

// ========== PEM 工具 ==========
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

type KeyBits = 2048 | 4096;

function RsaTool() {
  const [bits, setBits] = useState<KeyBits>(2048);
  const [publicPem, setPublicPem] = useState('');
  const [privatePem, setPrivatePem] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // 加解密
  const [pubPemForEnc, setPubPemForEnc] = useState('');
  const [plainText, setPlainText] = useState('');
  const [cipherB64, setCipherB64] = useState('');
  const [privPemForDec, setPrivPemForDec] = useState('');
  const [decryptedText, setDecryptedText] = useState('');
  const [errorEnc, setErrorEnc] = useState('');

  // 签名验签
  const [privPemForSign, setPrivPemForSign] = useState('');
  const [signText, setSignText] = useState('');
  const [signature, setSignature] = useState('');
  const [pubPemForVerify, setPubPemForVerify] = useState('');
  const [verifyResult, setVerifyResult] = useState<string>('');

  const generate = async () => {
    setBusy(true); setStatus('生成中…（4096 位约需 1-3 秒）');
    try {
      const subtle = (window.crypto as Crypto).subtle;
      const pair = await subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: bits,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        } as RsaHashedKeyGenParams,
        true,
        ['encrypt', 'decrypt']
      );
      const pubBuf = await subtle.exportKey('spki', pair.publicKey);
      const privBuf = await subtle.exportKey('pkcs8', pair.privateKey);
      setPublicPem(abToPem('PUBLIC KEY', pubBuf));
      setPrivatePem(abToPem('PRIVATE KEY', privBuf));
      setStatus(`已生成 ${bits} 位 RSA-OAEP-SHA-256 密钥对`);
    } catch (e) {
      setStatus('错误：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const encrypt = async () => {
    setErrorEnc(''); setCipherB64('');
    try {
      if (!pubPemForEnc.trim()) throw new Error('请粘贴 PUBLIC KEY PEM');
      if (!plainText) throw new Error('请输入明文');
      const subtle = (window.crypto as Crypto).subtle;
      const key = await subtle.importKey('spki', pemToAb(pubPemForEnc), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const data = new TextEncoder().encode(plainText);
      // RSA-OAEP 2048 位最大 190 字节
      const maxLen = bits / 8 - 2 * 32 - 2;
      if (data.length > maxLen) throw new Error(`明文过长（${data.length} > ${maxLen} 字节），请使用 PGP 信封`);
      const cipher = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, key, data as BufferSource));
      setCipherB64(bytesToB64(cipher));
    } catch (e) {
      setErrorEnc((e as Error).message);
    }
  };

  const decrypt = async () => {
    setErrorEnc(''); setDecryptedText('');
    try {
      if (!privPemForDec.trim()) throw new Error('请粘贴 PRIVATE KEY PEM');
      if (!cipherB64) throw new Error('请输入密文 base64');
      const subtle = (window.crypto as Crypto).subtle;
      const key = await subtle.importKey('pkcs8', pemToAb(privPemForDec), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      const plain = new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, key, b64ToBytes(cipherB64) as BufferSource));
      setDecryptedText(new TextDecoder().decode(plain));
    } catch (e) {
      setErrorEnc((e as Error).message);
    }
  };

  const sign = async () => {
    setErrorEnc(''); setSignature('');
    try {
      if (!privPemForSign.trim()) throw new Error('请粘贴 PRIVATE KEY PEM');
      if (!signText) throw new Error('请输入待签名文本');
      const subtle = (window.crypto as Crypto).subtle;
      // RSASSA-PKCS1-v1_5 需要单独 importKey
      const key = await subtle.importKey('pkcs8', pemToAb(privPemForSign), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      const data = new TextEncoder().encode(signText);
      const sig = new Uint8Array(await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data as BufferSource));
      setSignature(bytesToB64(sig));
    } catch (e) {
      setErrorEnc((e as Error).message);
    }
  };

  const verify = async () => {
    setErrorEnc(''); setVerifyResult('');
    try {
      if (!pubPemForVerify.trim()) throw new Error('请粘贴 PUBLIC KEY PEM');
      if (!signature) throw new Error('请输入签名 base64');
      const subtle = (window.crypto as Crypto).subtle;
      const key = await subtle.importKey('spki', pemToAb(pubPemForVerify), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const data = new TextEncoder().encode(signText);
      const ok = await subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, b64ToBytes(signature) as BufferSource, data as BufferSource);
      setVerifyResult(ok ? '✓ 验签通过' : '✗ 验签失败（签名不匹配或数据被篡改）');
    } catch (e) {
      setErrorEnc((e as Error).message);
    }
  };

  const inputCls = 'w-full px-3 py-2 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y';
  const labelCls = 'text-xs text-neutral-500 dark:text-stone-400 mb-1 block';

  return (
    <div className="p-5 space-y-6">
      {/* 1. 生成密钥对 */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">① 生成 RSA 密钥对</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-xl overflow-hidden border border-white/80 dark:border-stone-700/50">
            {[2048, 4096].map(b => (
              <button key={b} onClick={() => setBits(b as KeyBits)}
                className={`px-4 py-1.5 text-sm ${bits === b ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>
                {b} 位
              </button>
            ))}
          </div>
          <button onClick={generate} disabled={busy} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors disabled:opacity-60">
            {busy ? '生成中…' : '生成密钥对'}
          </button>
          {status && <span className="text-xs text-neutral-500 dark:text-stone-400">{status}</span>}
        </div>
        {publicPem && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelCls + ' mt-2'}>PUBLIC KEY</span>
              <CopyButton text={publicPem} />
            </div>
            <textarea readOnly value={publicPem} className={inputCls + ' h-32'} />
          </div>
        )}
        {privatePem && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelCls + ' mt-2'}>PRIVATE KEY（务必妥善保管）</span>
              <CopyButton text={privatePem} />
            </div>
            <textarea readOnly value={privatePem} className={inputCls + ' h-40'} />
          </div>
        )}
      </section>

      {/* 2. 加解密 */}
      <section className="space-y-3 pt-4 border-t border-white/80 dark:border-stone-700/50">
        <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">② RSA-OAEP 加解密</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <span className={labelCls}>加密：粘贴对方公钥（PEM）</span>
            <textarea value={pubPemForEnc} onChange={e => setPubPemForEnc(e.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" className={inputCls + ' h-24'} />
            <textarea value={plainText} onChange={e => setPlainText(e.target.value)} placeholder="明文（≤ 190 字节 / 2048 位）" className={inputCls + ' h-20'} />
            <button onClick={encrypt} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 text-sm">加密 →</button>
            <textarea readOnly value={cipherB64} placeholder="密文（base64）" className={inputCls + ' h-20'} />
          </div>
          <div className="space-y-2">
            <span className={labelCls}>解密：粘贴自己的私钥（PEM）</span>
            <textarea value={privPemForDec} onChange={e => setPrivPemForDec(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className={inputCls + ' h-24'} />
            <textarea value={cipherB64} onChange={e => setCipherB64(e.target.value)} placeholder="密文（base64）" className={inputCls + ' h-20'} />
            <button onClick={decrypt} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 text-sm">← 解密</button>
            <textarea readOnly value={decryptedText} placeholder="明文输出" className={inputCls + ' h-20'} />
          </div>
        </div>
      </section>

      {/* 3. 签名验签 */}
      <section className="space-y-3 pt-4 border-t border-white/80 dark:border-stone-700/50">
        <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">③ RSASSA-PKCS1-v1_5 签名 / 验签</h3>
        <div className="space-y-2">
          <span className={labelCls}>待签名文本（验签时使用相同文本）</span>
          <textarea value={signText} onChange={e => setSignText(e.target.value)} placeholder="输入文本" className={inputCls + ' h-20'} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <span className={labelCls}>签名：粘贴自己的私钥（PEM）</span>
            <textarea value={privPemForSign} onChange={e => setPrivPemForSign(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className={inputCls + ' h-24'} />
            <button onClick={sign} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 text-sm">生成签名</button>
            <textarea readOnly value={signature} onChange={e => setSignature(e.target.value)} placeholder="签名（base64）" className={inputCls + ' h-20'} />
          </div>
          <div className="space-y-2">
            <span className={labelCls}>验签：粘贴对方公钥（PEM）</span>
            <textarea value={pubPemForVerify} onChange={e => setPubPemForVerify(e.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" className={inputCls + ' h-24'} />
            <button onClick={verify} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 text-sm">验证签名</button>
            {verifyResult && (
              <div className={`px-3 py-2 rounded-xl text-sm ${verifyResult.startsWith('✓') ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'}`}>
                {verifyResult}
              </div>
            )}
          </div>
        </div>
      </section>

      {errorEnc && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{errorEnc}</div>}
    </div>
  );
}

export { RsaTool };
