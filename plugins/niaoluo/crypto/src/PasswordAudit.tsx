/// <reference path="../../../global.d.ts" />
// 茑萝 · 密码强度审计
// 纯 JS 实现，零依赖
// 评分维度：
//   1. 长度评分（0-25）
//   2. 字符集多样性（小写/大写/数字/符号/扩展 ASCII，0-25）
//   3. 熵估算（基于实际字符集，0-25）
//   4. 模式惩罚（连续、重复、键盘序列、年份、常见密码）-25~0
//   5. 字典命中（top 1000 弱密码 + 常见姓氏）-30~0
// 总分 0-100，映射 5 级：极弱 / 弱 / 中 / 强 / 极强
const React = window.__HOST_REACT__;
const { useState, useMemo } = React;

// 弱密码字典（top 100，精简版；完整 zxcvbn 词典太大不符合"轻量"原则）
const WEAK_PASSWORDS = new Set([
  '123456', '123456789', 'password', 'qwerty', '111111', '12345678', 'abc123', '12345',
  'password1', 'admin', 'letmein', 'welcome', 'monkey', '1234567', 'dragon', '1234',
  'iloveyou', 'trustno1', 'sunshine', 'princess', 'football', 'shadow', 'superman', 'michael',
  'master', '696969', 'mustang', 'access', 'batman', 'login', 'hello', 'charlie', 'donald',
  'loveme', 'baseball', 'starwars', '11111111', 'flower', 'whatever', 'qazwsx', 'michael1',
  'ninja', 'azerty', 'solo', 'snowman', 'gizmodo', 'hottie', 'loveme', 'buster', 'pass',
  'phoenix', 'test', 'test1', 'root', 'toor', 'guest', 'user', 'admin123', 'administrator',
  'qwerty123', 'password123', '1q2w3e', '1q2w3e4r', 'zxcvbn', 'asdfgh', 'asdfghjkl',
  '000000', '121212', '666666', '888888', '159753', '987654321', 'secret', 'jordan',
  'justin', 'hunter', 'soccer', 'harley', 'ranger', 'daniel', 'andrew', 'matthew',
  'jessica', 'ashley', 'joshua', 'thomas', 'george', 'summer', 'winter', 'spring', 'autumn',
]);

// 常见键盘序列
const KEYBOARD_SEQUENCES = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  '1234567890', 'qazwsxedc', '!@#$%^&*()',
  'qwertyuiop[]\\', 'asdfghjkl;\'',
];
// 常见字母序列
const LETTER_SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  'abcdef', 'abcd', 'abcde', 'abcdefghijklmnopqrstuvwxyz',
];
// 常见日期模式
const YEAR_RE = /(?:19|20)\d{2}/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{8}/g;

interface AuditResult {
  score: number;        // 0-100
  level: 0 | 1 | 2 | 3 | 4; // 极弱 / 弱 / 中 / 强 / 极强
  entropy: number;      // bits
  charsetSize: number;  // 实际字符集大小
  length: number;
  suggestions: string[];
  breakdown: { name: string; score: number; max: number }[];
}

function auditPassword(pw: string): AuditResult {
  const len = pw.length;
  const suggestions: string[] = [];

  // 1. 字符集检测
  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^a-zA-Z0-9]/.test(pw);
  let charsetSize = 0;
  if (hasLower) charsetSize += 26;
  if (hasUpper) charsetSize += 26;
  if (hasDigit) charsetSize += 10;
  if (hasSymbol) charsetSize += 33; // ASCII 可打印符号约 33 个
  if (charsetSize === 0) charsetSize = 1;

  // 2. 长度评分（0-25）
  let lengthScore: number;
  if (len < 4) lengthScore = 0;
  else if (len < 6) lengthScore = 5;
  else if (len < 8) lengthScore = 10;
  else if (len < 12) lengthScore = 15;
  else if (len < 16) lengthScore = 20;
  else if (len < 24) lengthScore = 23;
  else lengthScore = 25;
  if (len < 8) suggestions.push('密码至少应 8 位以上，推荐 12 位以上');

  // 3. 字符集多样性评分（0-25）
  let diversity = 0;
  if (hasLower) diversity += 5;
  if (hasUpper) diversity += 6;
  if (hasDigit) diversity += 5;
  if (hasSymbol) diversity += 9;
  if (!hasUpper) suggestions.push('加入大写字母可提升强度');
  if (!hasSymbol) suggestions.push('加入符号可显著提升强度');

  // 4. 熵估算（bits）
  const entropy = Math.round(len * Math.log2(charsetSize) * 10) / 10;
  // 5. 熵评分（0-25）
  let entropyScore: number;
  if (entropy < 28) entropyScore = Math.round(entropy / 28 * 10);
  else if (entropy < 36) entropyScore = 10 + Math.round((entropy - 28) / 8 * 5);
  else if (entropy < 60) entropyScore = 15 + Math.round((entropy - 36) / 24 * 5);
  else if (entropy < 128) entropyScore = 20 + Math.round((entropy - 60) / 68 * 5);
  else entropyScore = 25;
  if (entropy < 36) suggestions.push(`熵仅 ${entropy} bits，建议 ≥ 36 bits（NIST 800-63 最低线）`);

  // 6. 模式惩罚（-25 ~ 0）
  let patternPenalty = 0;
  const lower = pw.toLowerCase();
  // 6a. 连续 / 重复
  const repeats = lower.match(/(.)\1{2,}/g) || [];
  if (repeats.length > 0) {
    patternPenalty -= 4 * repeats.length;
    suggestions.push(`检测到 ${repeats.length} 处重复字符（如 "${repeats[0]}"）`);
  }
  const seqs = lower.match(/(.{2,})\1{1,}/g) || [];
  if (seqs.length > 0) patternPenalty -= 3 * seqs.length;
  // 6b. 键盘 / 字母序列
  for (const seq of [...KEYBOARD_SEQUENCES, ...LETTER_SEQUENCES]) {
    let inRow = 0;
    for (let i = 0; i < pw.length - 2; i++) {
      const slice = lower.slice(i, i + 3);
      if (seq.includes(slice) || seq.includes(slice.split('').reverse().join(''))) inRow++;
    }
    if (inRow >= 3) {
      patternPenalty -= Math.min(15, inRow * 3);
      suggestions.push('包含键盘 / 字母序列（如 qwerty / abcde）');
      break;
    }
  }
  // 6c. 年份 / 日期模式
  const years = pw.match(YEAR_RE) || [];
  if (years.length > 0) {
    patternPenalty -= 3 * years.length;
    suggestions.push(`检测到年份 ${years.join(', ')}（易被字典攻击）`);
  }
  const dates = pw.match(DATE_RE) || [];
  if (dates.length > 0) {
    patternPenalty -= 5 * dates.length;
    suggestions.push('检测到日期模式');
  }
  patternPenalty = Math.max(-25, patternPenalty);

  // 7. 字典命中惩罚（-30 ~ 0）
  let dictPenalty = 0;
  if (WEAK_PASSWORDS.has(lower)) {
    dictPenalty = -30;
    suggestions.unshift('命中 top100 弱密码字典（强烈建议更换）');
  } else if (WEAK_PASSWORDS.has(lower.replace(/[^a-z]/g, '')) && lower.replace(/[^a-z]/g, '').length >= 4) {
    dictPenalty = -15;
    suggestions.push('移除数字 / 符号后命中弱密码字典');
  } else if (/\d{4,}$/.test(pw) || /^[a-z]+\d+$/i.test(pw)) {
    dictPenalty = -8;
    suggestions.push('形如「字母 + 数字」的简单组合易被字典攻击');
  }

  const score = Math.max(0, Math.min(100, lengthScore + diversity + entropyScore + patternPenalty + dictPenalty));
  let level: AuditResult['level'];
  if (score < 20) level = 0;
  else if (score < 40) level = 1;
  else if (score < 60) level = 2;
  else if (score < 80) level = 3;
  else level = 4;

  if (suggestions.length === 0) suggestions.push('密码强度良好，无明显可识别模式');
  if (level === 4) suggestions.unshift('密码强度极高，适合用作主密码 / 加密密钥');

  return {
    score,
    level,
    entropy,
    charsetSize,
    length: len,
    suggestions: suggestions.slice(0, 5),
    breakdown: [
      { name: '长度', score: lengthScore, max: 25 },
      { name: '字符多样性', score: diversity, max: 25 },
      { name: '熵', score: entropyScore, max: 25 },
      { name: '模式惩罚', score: patternPenalty, max: 25 }, // 负值
      { name: '字典惩罚', score: dictPenalty, max: 30 },     // 负值
    ],
  };
}

const LEVEL_LABELS = ['极弱', '弱', '中', '强', '极强'];
const LEVEL_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-emerald-500', 'bg-emerald-600',
];
const LEVEL_TEXT_COLORS = [
  'text-red-600 dark:text-red-400',
  'text-orange-600 dark:text-orange-400',
  'text-yellow-600 dark:text-yellow-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-emerald-700 dark:text-emerald-300',
];

function PasswordAudit() {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const result = useMemo(() => pw ? auditPassword(pw) : null, [pw]);

  return (
    <div className="p-5 space-y-4">
      <div className="rounded-xl bg-white/50 dark:bg-stone-800/40 border border-white/80 dark:border-stone-700/50 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <input
            type={show ? 'text' : 'password'}
            value={pw}
            onChange={e => setPw(e.target.value)}
            placeholder="输入密码进行实时审计…"
            className="flex-1 px-3 py-2 rounded-xl bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/50 text-sm font-mono outline-none focus:border-[var(--element-border)]"
          />
          <button onClick={() => setShow(!show)} className="btn-press px-3 py-2 rounded-xl bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/50 text-xs text-neutral-600 dark:text-stone-300">
            {show ? '隐藏' : '显示'}
          </button>
        </div>

        {result && (
          <>
            {/* 评分等级条 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className={`text-2xl font-bold ${LEVEL_TEXT_COLORS[result.level]}`}>
                  {LEVEL_LABELS[result.level]}
                </span>
                <span className="text-sm text-neutral-500 dark:text-stone-400">
                  {result.score} / 100 · {result.entropy} bits 熵
                </span>
              </div>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className={`flex-1 h-2 rounded-full ${i <= result.level ? LEVEL_COLORS[result.level] : 'bg-neutral-200 dark:bg-stone-700'}`}
                  />
                ))}
              </div>
            </div>

            {/* 明细 */}
            <div className="space-y-1 text-xs">
              {result.breakdown.map(b => (
                <div key={b.name} className="flex items-center gap-2">
                  <span className="w-20 text-neutral-500 dark:text-stone-400">{b.name}</span>
                  <div className="flex-1 h-1.5 bg-neutral-200 dark:bg-stone-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${b.score < 0 ? 'bg-red-500' : 'bg-[var(--element-muted)]'}`}
                      style={{ width: `${Math.max(0, Math.min(100, (b.score / b.max) * 100))}%` }}
                    />
                  </div>
                  <span className={`w-12 text-right ${b.score < 0 ? 'text-red-500' : 'text-neutral-600 dark:text-stone-300'}`}>
                    {b.score > 0 ? '+' : ''}{b.score}
                  </span>
                </div>
              ))}
            </div>

            {/* 建议 */}
            <div className="pt-2 border-t border-white/60 dark:border-stone-700/40">
              <div className="text-xs font-medium text-neutral-600 dark:text-stone-300 mb-1.5">改进建议</div>
              <ul className="space-y-1">
                {result.suggestions.map((s, i) => (
                  <li key={i} className="text-xs text-neutral-600 dark:text-stone-400 flex items-start gap-1.5">
                    <span className="text-[var(--element-muted)] mt-0.5">›</span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>

            <div className="text-[10px] text-neutral-400 dark:text-stone-500 pt-1">
              字符集大小：{result.charsetSize} · 长度：{result.length} · 估算破解时间（在线攻击 ~10000 次/秒）：{
                result.entropy < 28 ? '秒级' :
                result.entropy < 36 ? '分钟级' :
                result.entropy < 60 ? '天 / 月级' :
                result.entropy < 100 ? '年 / 世纪级' :
                '不可行（宇宙寿命级）'
              }
            </div>
          </>
        )}

        {!result && (
          <div className="text-xs text-neutral-400 dark:text-stone-500 text-center py-6">
            输入密码即时审计 · 所有计算均在本地完成，不上传任何数据
          </div>
        )}
      </div>

      <div className="text-xs text-neutral-500 dark:text-stone-400 space-y-1">
        <div className="font-medium text-neutral-600 dark:text-stone-300">评分模型</div>
        <div>长度（0-25）+ 字符多样性（0-25）+ 熵（0-25）+ 模式惩罚（-25~0）+ 字典惩罚（-30~0）</div>
        <div>等级阈值：极弱 &lt; 20 · 弱 &lt; 40 · 中 &lt; 60 · 强 &lt; 80 · 极强 ≥ 80</div>
        <div>NIST SP 800-63B 推荐：≥ 8 位，熵 ≥ 36 bits（本工具严格按此阈值提示）</div>
      </div>
    </div>
  );
}

export { PasswordAudit };
