// 文档持久化：使用宿主 WebView 的 localStorage（沙箱未遮蔽，插件可安全读写）。
// 与现有模块一致（见 music_service 注释：播放列表仅存前端 localStorage）。
// 注意：localStorage 约 5MB 上限，图片以 base64 内嵌时单文档不宜过大。

// 办公套件文件类型：文档 / 演示文件 / 表格。
// 旧文档数据无 kind 字段，统一按 'doc' 兼容（见 kindOf）。
export type FileKind = 'doc' | 'ppt' | 'sheet';

export interface DocMeta {
  id: string;
  title: string;
  updatedAt: number;
  kind?: FileKind; // 新增；缺省视为 'doc'（向后兼容）
  header?: string; // 页眉文本（可选）
  footer?: string; // 页脚文本（可选）
}

export interface DocData {
  id: string;
  title: string;
  content: unknown; // 文档：ProseMirror JSON；演示文件/表格：各自结构
  updatedAt: number;
  kind?: FileKind;
  header?: string;
  footer?: string;
}

// 读取文件类型，旧数据（无 kind）一律归为 'doc'。
export function kindOf(m: { kind?: FileKind } | null | undefined): FileKind {
  return m?.kind ?? 'doc';
}

// 按类型给出默认标题，如「演示文件 1」。
export function defaultTitle(kind: FileKind, n: number): string {
  const base = kind === 'ppt' ? '演示文件' : kind === 'sheet' ? '表格' : '文档';
  return `${base} ${n}`;
}

// ============ 演示文件（PPT）数据模型 ============
export interface PptTextStyle {
  fontSize: number; // 逻辑像素
  color: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  fontFamily?: string;
}

export type PptElementType = 'text' | 'image' | 'shape';

// 形状类型：矩形 / 圆角矩形 / 椭圆 / 直线 / 三角 / 右箭头
export type PptShapeKind = 'rect' | 'roundRect' | 'ellipse' | 'line' | 'triangle' | 'arrow';

export interface PptElement {
  id: string;
  type: PptElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  z: number;
  // text
  text?: string;
  style?: PptTextStyle;
  // image
  src?: string;
  // shape
  shape?: PptShapeKind;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface PptSlide {
  id: string;
  background: string; // CSS 颜色
  elements: PptElement[];
  transition?: 'none' | 'fade' | 'slide'; // 放映切换到本页时的动画
  sectionId?: string | null; // 归属的章节（嵌套），null/缺省为未分组
}

// 章节（幻灯片栏的一层嵌套，类比「茑萝」侧边栏母目录/子目录）
export interface PptSection {
  id: string;
  title: string;
  collapsed?: boolean;
}

// 持久化的演示文件内容（content 字段）
export interface PptContent {
  slides: PptSlide[];
  sections?: PptSection[];
}

const PREFIX = 'wps:doc:';
const INDEX_KEY = 'wps:index';

export function newId(): string {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function loadIndex(): DocMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as DocMeta[]) : [];
  } catch {
    return [];
  }
}

export function saveIndex(list: DocMeta[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* 配额溢出时静默失败，UI 仍可用 */
  }
}

export function loadDoc(id: string): DocData | null {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as DocData;
  } catch {
    return null;
  }
}

export function saveDoc(doc: DocData): void {
  try {
    localStorage.setItem(PREFIX + doc.id, JSON.stringify(doc));
  } catch {
    /* 配额溢出（如超大内嵌图片）时静默，避免阻塞编辑 */
  }
}

export function deleteDoc(id: string): void {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    /* noop */
  }
}
