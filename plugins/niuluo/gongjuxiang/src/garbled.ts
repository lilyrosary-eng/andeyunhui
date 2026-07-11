// 乱码修复 — 纯函数（无 React 依赖，可在插件沙箱中安全执行）
//
// 移植自「万能乱码修复器」：把字节/文本在多种编码间尝试「重新解码」，
// 按「中文字符数 * 20 + 字母数字数」评分，列出所有可行方案供挑选。
// 另含一组文本清洗（全半角 / 去不可见 / NFC / 简繁），作为附加能力。

import { encodeStringToBytes, decodeBytes, COMMON_ENCODINGS } from './codec';

export { COMMON_ENCODINGS };

// ============ 编码修复：候选方案扫描 ============

// 智能优先的常用「误配」对
export const SMART_PAIRS: [string, string][] = [
  ['utf-8', 'gbk'], ['utf-8', 'gb18030'], ['gbk', 'utf-8'], ['gb18030', 'utf-8'],
  ['utf-8', 'big5'], ['big5', 'utf-8'], ['gbk', 'gb18030'], ['gb18030', 'gbk'],
  ['shift-jis', 'utf-8'], ['utf-8', 'shift-jis'],
];

// 解码后的人工校正映射（针对特定字符误还原）
export const REPLACE_MAP: Record<string, string> = {
  '弢': '开', '靿': '面', '丼': '个', '锷': '键',
  '叻': '可', '罼': '设', '攌': '持', '友': '拖',
  '罡': '置', '臮': '义', '叔': '只', '内': '内容',
};

export function applyReplaceMap(text: string): string {
  let out = text;
  for (const k of Object.keys(REPLACE_MAP)) out = out.split(k).join(REPLACE_MAP[k]);
  return out;
}

function countCjk(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x4e00 && cp <= 0x9fff) n++;
  }
  return n;
}

function countAlnum(s: string): number {
  let n = 0;
  for (const ch of s) if (/[0-9a-zA-Z]/.test(ch)) n++;
  return n;
}

export interface FixCandidate {
  desc: string;
  text: string;
  score: number;
}

// 字节路径：from_enc 仅作合法性校验，结果以 to_enc 解码
function recodeBytes(bytes: Uint8Array, fromEnc: string, toEnc: string, strict: boolean): { ok: boolean; text: string } {
  if (strict) {
    try {
      decodeBytes(bytes, fromEnc, true);
    } catch {
      return { ok: false, text: '' };
    }
  }
  return { ok: true, text: decodeBytes(bytes, toEnc, false) };
}

// 字符串路径：把字符串按 from_enc 还原字节，再用 to_enc 解码（典型 mojibake 修复）
function recodeString(text: string, fromEnc: string, toEnc: string): { ok: boolean; text: string } {
  const raw = encodeStringToBytes(text, fromEnc);
  if (!raw) return { ok: false, text: '' };
  return { ok: true, text: decodeBytes(raw, toEnc, false) };
}

function tryDecode(data: Uint8Array | string, fromEnc: string, toEnc: string, strict: boolean): { ok: boolean; text: string; score: number } {
  const res = typeof data === 'string' ? recodeString(data, fromEnc, toEnc) : recodeBytes(data, fromEnc, toEnc, strict);
  if (!res.ok) return { ok: false, text: '', score: 0 };
  const cjk = countCjk(res.text);
  const alnum = countAlnum(res.text);
  const score = cjk * 20 + alnum;
  // 过滤无意义结果
  if (res.text.trim().length < 5 || cjk < 2) return { ok: false, text: '', score: 0 };
  return { ok: true, text: res.text, score };
}

function uniqueCombos(list: [string, string][]): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const c of list) {
    const k = c[0] + '|' + c[1];
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

export type ScanMode = 'smart' | 'bruteforce' | 'double';

// 核心：扫描所有可行修复方案，按评分降序返回
export function scanFixes(data: Uint8Array | string, mode: ScanMode): FixCandidate[] {
  const results: FixCandidate[] = [];

  if (mode === 'double') {
    const mids = ['utf-8', 'gbk', 'gb18030', 'big5'];
    for (const f of COMMON_ENCODINGS) {
      for (const mid of mids) {
        for (const t of COMMON_ENCODINGS) {
          if (new Set([f, mid, t]).size < 2) continue;
          // 第一阶段：data -> mid（from = f）
          const s1 = typeof data === 'string' ? recodeString(data, f, mid) : recodeBytes(data, f, mid, false);
          if (!s1.ok || s1.text.trim().length < 3) continue;
          // 第二阶段：mid_text -> t（from = f）
          const s2 = recodeString(s1.text, f, t);
          if (!s2.ok) continue;
          const cjk = countCjk(s2.text);
          const alnum = countAlnum(s2.text);
          const score = cjk * 20 + alnum;
          if (s2.text.trim().length < 5 || cjk < 2) continue;
          results.push({ desc: `双重 ${f} → ${mid} → ${t}`, text: s2.text, score });
        }
      }
    }
  } else {
    let combos: [string, string][] = [];
    if (mode === 'smart') {
      combos = SMART_PAIRS.slice();
      for (const f of ['utf-8', 'gbk', 'gb18030', 'big5']) {
        for (const t of ['utf-8', 'gbk', 'gb18030', 'big5']) {
          if (f !== t) combos.push([f, t]);
        }
      }
    } else {
      for (const f of COMMON_ENCODINGS) {
        for (const t of COMMON_ENCODINGS) {
          if (f !== t) combos.push([f, t]);
        }
      }
    }
    combos = uniqueCombos(combos);
    for (const [f, t] of combos) {
      let r = tryDecode(data, f, t, true);
      if (!r.ok) r = tryDecode(data, f, t, false);
      if (r.ok) results.push({ desc: `${f} → ${t}`, text: r.text, score: r.score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ============ 文本清洗（附加能力） ============

// 全角 ↔ 半角
const FULL_OFFSET = 0xfee0;

export function fullToHalf(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - FULL_OFFSET);
    else out += ch;
  }
  return out;
}

export function halfToFull(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20) out += '　';
    else if (code >= 0x21 && code <= 0x7e) out += String.fromCharCode(code + FULL_OFFSET);
    else out += ch;
  }
  return out;
}

// 去除不可见 / 控制字符
const INVISIBLE = new Set<number>([
  0x200b, 0x200c, 0x200d, 0xfeff, 0x2060, 0x00ad, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x202f, 0x205f, 0x00a0,
  0x1680,
]);

export function removeInvisible(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0xfeff) continue;
    if (INVISIBLE.has(code)) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return out;
}

// Unicode 归一化
export function normalizeUnicode(s: string): string {
  try {
    return s.normalize('NFC');
  } catch {
    return s;
  }
}

// 简繁转换（内置常用字对照，best-effort）
const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = {
  们: '們', 个: '個', 这: '這', 来: '來', 国: '國', 说: '說', 时: '時',
  对: '對', 为: '為', 会: '會', 过: '過', 还: '還', 两: '兩', 与: '與',
  并: '並', 关: '關', 从: '從', 发: '發', 点: '點', 无: '無', 东: '東',
  车: '車', 马: '馬', 鸟: '鳥', 鱼: '魚', 长: '長', 门: '門', 问: '問',
  间: '間', 闻: '聞', 实: '實', 学: '學', 觉: '覺', 见: '見', 气: '氣',
  话: '話', 书: '書', 电: '電', 纸: '紙', 买: '買', 卖: '賣', 读: '讀',
  写: '寫', 体: '體', 动: '動', 库: '庫', 应: '應', 开: '開', 进: '進',
  远: '遠', 认: '認', 识: '識', 让: '讓', 议: '議', 论: '論', 设: '設',
  计: '計', 语: '語', 词: '詞', 诗: '詩', 数: '數', 据: '據', 总: '總',
  结: '結', 网: '網', 页: '頁', 题: '題', 类: '類', 系: '係', 红: '紅',
  绿: '綠', 蓝: '藍', 颜: '顏', 风: '風', 云: '雲', 岁: '歲', 县: '縣',
  处: '處', 务: '務', 劳: '勞', 营: '營', 术: '術', 药: '藥', 爱: '愛',
  亲: '親', 义: '義', 权: '權', 杀: '殺', 产: '產', 决: '決', 单: '單',
  简: '簡', 谁: '誰', 虽: '雖', 随: '隨', 举: '舉', 乡: '鄉', 币: '幣',
  势: '勢', 参: '參', 变: '變', 条: '條', 万: '萬', 虑: '慮', 忧: '憂',
  庆: '慶', 广: '廣', 厂: '廠', 厅: '廳', 压: '壓', 盐: '鹽', 监: '監',
  盘: '盤', 众: '眾', 爷: '爺', 妈: '媽', 孙: '孫', 带: '帶', 帮: '幫',
  师: '師', 归: '歸', 当: '當', 战: '戰', 戏: '戲', 观: '觀', 欢: '歡',
  饮: '飲', 饭: '飯', 馆: '館', 图: '圖', 圆: '圓', 块: '塊', 坏: '壞',
  亚: '亞', 业: '業', 严: '嚴', 丧: '喪', 丰: '豐', 临: '臨', 丽: '麗',
  么: '麼', 乌: '烏', 乐: '樂', 于: '於', 亏: '虧', 击: '擊', 扑: '撲',
  旧: '舊', 帅: '帥', 龙: '龍', 灭: '滅', 盖: '蓋', 断: '斷', 显: '顯',
  晓: '曉', 干: '乾', 制: '製', 复: '復', 备: '備', 够: '夠', 党: '黨',
  难: '難', 离: '離', 稳: '穩', 穷: '窮', 职: '職', 脱: '脫', 脑: '腦',
  脏: '髒', 舰: '艦', 茶: '茶', 茧: '繭', 汉: '漢', 宁: '寧', 宝: '寶',
  审: '審', 宠: '寵', 宪: '憲', 宫: '宮', 宽: '寬', 宾: '賓', 密: '密',
  寻: '尋', 寿: '壽', 将: '將', 尔: '爾', 尘: '塵', 尝: '嘗', 层: '層',
  岛: '島', 岩: '巖', 岳: '嶽', 希: '希', 废: '廢', 张: '張', 强: '強',
  录: '錄', 径: '徑', 志: '誌', 忘: '忘', 卷: '捲', 取: '取', 受: '受',
  叙: '敘', 香: '香', 恒: '恆', 恳: '懇', 恶: '惡', 慧: '慧', 态: '態',
  感: '感', 户: '戶', 房: '房', 所: '所', 才: '才', 扎: '紮', 承: '承',
  抱: '抱', 拢: '攏', 拥: '擁', 挥: '揮', 推: '推', 描: '描', 提: '提',
  扬: '揚', 换: '換', 捷: '捷',
};

const TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = (() => {
  const rev: Record<string, string> = {};
  for (const k of Object.keys(SIMPLIFIED_TO_TRADITIONAL)) {
    const v = SIMPLIFIED_TO_TRADITIONAL[k];
    if (!(v in rev)) rev[v] = k;
  }
  return rev;
})();

export function simplifiedToTraditional(s: string): string {
  let out = '';
  for (const ch of s) out += SIMPLIFIED_TO_TRADITIONAL[ch] || ch;
  return out;
}

export function traditionalToSimplified(s: string): string {
  let out = '';
  for (const ch of s) out += TRADITIONAL_TO_SIMPLIFIED[ch] || ch;
  return out;
}
