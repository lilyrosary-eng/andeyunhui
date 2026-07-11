/**
 * 系统字体检测工具
 * 策略：queryLocalFonts 为主，document.fonts 验证为回退
 */

import { logger } from '@/lib/logger';

export interface FontInfo {
  family: string;
  displayName: string;
  isChinese: boolean;
}

// Windows 中文字体英文名 → 中文名映射
const CHINESE_FONT_MAP: Record<string, string> = {
  'SimSun': '宋体', 'NSimSun': '新宋体', 'SimHei': '黑体',
  'Microsoft YaHei': '微软雅黑', 'Microsoft YaHei UI': '微软雅黑 UI',
  'KaiTi': '楷体', 'FangSong': '仿宋', 'DengXian': '等线',
  'DengXian Light': '等线 Light', 'YouYuan': '幼圆',
  'STSong': '华文宋体', 'STKaiti': '华文楷体', 'STFangsong': '华文仿宋',
  'STXihei': '华文细黑', 'STHupo': '华文琥珀', 'STLiti': '华文隶书',
  'STXingkai': '华文行楷', 'STCaiyun': '华文彩云', 'STXinwei': '华文新魏',
  'STZhongsong': '华文中宋', 'FZXiaoBiaoSong-B05S': '方正小标宋',
  'FZShuTi': '方正书宋', 'FZYaoti': '方正姚体', 'FZHei-B01S': '方正黑体',
  'FZKai-Z03S': '方正楷体', 'FZFangSong-Z02S': '方正仿宋', 'LiSu': '隶书',
  'MingLiU': '细明体', 'PMingLiU': '新细明体', 'MingLiU_HKSCS': '细明体_HKSCS',
  'Microsoft JhengHei': '微软正黑体', 'Microsoft JhengHei UI': '微软正黑体 UI',
  'DFKai-SB': '标楷体',
};

// 完整字体候选列表（用于 document.fonts 验证）
const ALL_FONT_CANDIDATES: string[] = [
  // 中文
  '宋体', '黑体', '微软雅黑', '楷体', '仿宋', '等线', '幼圆', '隶书', '新宋体',
  '华文宋体', '华文楷体', '华文仿宋', '华文细黑', '华文琥珀', '华文隶书', '华文行楷', '华文彩云', '华文新魏', '华文中宋',
  '方正小标宋', '方正书宋', '方正姚体', '方正黑体', '方正楷体', '方正仿宋',
  '细明体', '新细明体', '微软正黑体', '标楷体',
  '思源黑体', '思源宋体', 'Noto Sans SC', 'Noto Serif SC',
  '文泉驿微米黑', '文泉驿正黑', '文泉驿等宽微米黑',
  '霞鹜文楷', 'LXGW WenKai', '霞鹜文楷 GB',
  '更纱黑体', 'Sarasa Gothic SC',
  '站酷文艺体', '站酷快乐体', '站酷高端黑',
  '庞门正道标题体', '庞门正道粗书体',
  '造字工房悦黑', '造字工房俊雅', '造字工房刻宋',
  '阿里巴巴普惠体', 'Alibaba PuHuiTi',
  'HarmonyOS Sans SC', 'HarmonyOS Sans',
  'MiSans', 'MiSans VF',
  'OPPOSans', 'vivo Sans',
  '霞鹜尚智黑', 'LXGW Bright',
  // 日文/韩文
  'Meiryo', 'MS Gothic', 'MS Mincho', 'MS PGothic', 'MS PMincho',
  'Yu Gothic', 'Yu Gothic UI', 'Malgun Gothic', 'Gungsuh', 'Batang',
  'Dotum', 'Gulim',
  // 等宽
  'Consolas', 'Courier New', 'Lucida Console', 'Monaco', 'Menlo',
  'Source Code Pro', 'Fira Code', 'JetBrains Mono', 'Cascadia Code',
  'Cascadia Mono', 'Droid Sans Mono', 'DejaVu Sans Mono',
  'Inconsolata', 'Ubuntu Mono', 'Liberation Mono',
  // 无衬线
  'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Segoe UI', 'Calibri', 'Candara', 'Corbel', 'Carlito',
  'Open Sans', 'Lato', 'Roboto', 'Montserrat', 'Raleway',
  'Noto Sans', 'Ubuntu', 'Oswald', 'PT Sans', 'Source Sans Pro',
  'Fira Sans', 'Droid Sans', 'Liberation Sans',
  'Inter', 'Poppins', 'Nunito', 'Rubik', 'Work Sans',
  'DM Sans', 'Manrope', 'Outfit', 'Plus Jakarta Sans',
  // 衬线
  'Times New Roman', 'Georgia', 'Garamond', 'Book Antiqua',
  'Palatino Linotype', 'Cambria', 'Constantia',
  'Merriweather', 'Playfair Display', 'Libre Baskerville',
  'Noto Serif', 'PT Serif', 'Source Serif Pro', 'Droid Serif',
  'Lora', 'EB Garamond', 'Cormorant Garamond', 'Spectral',
  'Liberation Serif', 'DejaVu Serif',
  // 手写/装饰
  'Comic Sans MS', 'Impact', 'Century Gothic', 'Franklin Gothic Medium',
  'Lucida Sans Unicode', 'Lucida Sans', 'Gill Sans', 'Futura',
  'Cooper Black', 'Rockwell', 'Bodoni MT', 'Bookman Old Style',
  'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold',
];

function containsChinese(str: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str);
}

function getDisplayName(family: string): { displayName: string; isChinese: boolean } {
  if (containsChinese(family)) return { displayName: family, isChinese: true };
  const mapped = CHINESE_FONT_MAP[family];
  if (mapped) return { displayName: mapped, isChinese: true };
  return { displayName: family, isChinese: false };
}

// ========== 方法 1：queryLocalFonts（Chromium only） ==========
async function detectViaQueryLocalFonts(): Promise<FontInfo[]> {
  if (!('queryLocalFonts' in window)) {
    logger.log('[Fonts] queryLocalFonts 不可用');
    return [];
  }
  try {
    const fonts = await (window as any).queryLocalFonts();
    const fontMap = new Map<string, FontInfo>();
    for (const font of fonts) {
      const family = font.family || font.fullName || '';
      if (!family || fontMap.has(family)) continue;
      const { displayName, isChinese } = getDisplayName(family);
      fontMap.set(family, { family, displayName, isChinese });
    }
    const result = Array.from(fontMap.values());
    logger.log(`[Fonts] queryLocalFonts 检测到 ${result.length} 个字体`);
    return result;
  } catch (err) {
    logger.log('[Fonts] queryLocalFonts 失败:', err);
    return [];
  }
}

// ========== 方法 2：document.fonts.load 验证候选字体 ==========
async function detectViaDocumentFonts(): Promise<FontInfo[]> {
  const result: FontInfo[] = [];
  const results = await Promise.allSettled(
    ALL_FONT_CANDIDATES.map(async (family) => {
      try {
        // 触发字体加载，如果系统安装了该字体会立即加载成功
        await document.fonts.load(`1em "${family}"`);
        if (document.fonts.check(`1em "${family}"`)) {
          const { displayName, isChinese } = getDisplayName(family);
          return { family, displayName, isChinese } as FontInfo;
        }
      } catch { /* 字体加载失败跳过 */ }
      return null;
    })
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) result.push(r.value);
  }
  logger.log(`[Fonts] document.fonts 验证到 ${result.length} 个字体`);
  return result;
}

// ========== 主检测函数 ==========
export async function detectSystemFonts(): Promise<FontInfo[]> {
  // 1. 优先 queryLocalFonts
  const localFonts = await detectViaQueryLocalFonts();
  if (localFonts.length >= 10) {
    return sortFonts(localFonts);
  }

  // 2. 回退到 document.fonts 验证
  logger.log('[Fonts] queryLocalFonts 结果不足，回退到 document.fonts 验证');
  const verifiedFonts = await detectViaDocumentFonts();

  // 合并去重
  const fontMap = new Map<string, FontInfo>();
  for (const f of localFonts) fontMap.set(f.family, f);
  for (const f of verifiedFonts) {
    if (!fontMap.has(f.family)) fontMap.set(f.family, f);
  }

  const merged = Array.from(fontMap.values());
  if (merged.length >= 5) return sortFonts(merged);

  // 3. 最终回退：全部候选直接返回
  logger.log('[Fonts] 所有检测方法均失败，使用完整候选列表');
  return sortFonts(ALL_FONT_CANDIDATES.map(f => ({
    family: f,
    ...getDisplayName(f),
  })));
}

function sortFonts(fonts: FontInfo[]): FontInfo[] {
  fonts.sort((a, b) => {
    if (a.isChinese !== b.isChinese) return a.isChinese ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, 'zh-CN');
  });
  return fonts;
}