import type { Bezier4 } from './curve';

export type Tool =
  | 'pen'
  | 'eraser'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'fill'
  | 'pick'
  | 'selectRect'
  | 'selectLasso'
  | 'move';
export type ColorMode = 'wheel' | 'rgb' | 'hsv' | 'palette';
export type ColorTarget = 'fg' | 'bg';
export type BlendMode =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'source-over', label: '正常' },
  { id: 'multiply', label: '正片叠底' },
  { id: 'screen', label: '滤色' },
  { id: 'overlay', label: '叠加' },
  { id: 'darken', label: '变暗' },
  { id: 'lighten', label: '变亮' },
  { id: 'color-dodge', label: '颜色减淡' },
  { id: 'color-burn', label: '颜色加深' },
  { id: 'hard-light', label: '强光' },
  { id: 'soft-light', label: '柔光' },
  { id: 'difference', label: '差值' },
  { id: 'exclusion', label: '排除' },
  { id: 'hue', label: '色相' },
  { id: 'saturation', label: '饱和度' },
  { id: 'color', label: '颜色' },
  { id: 'luminosity', label: '明度' },
];

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  canvas: HTMLCanvasElement;
}

export interface LayerMeta {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
}

export interface DocInfo {
  w: number;
  h: number;
  name: string;
  dirty: boolean;
}

export interface BrushPreset {
  name: string;
  size: number;
  opacity: number;
  hardness: number;
  flow: number;
  spacing: number;
  pressureCurve: number;
  /** 拖拽精调的压感曲线；null 表示用 pressureCurve 的 gamma 模式 */
  pressureBezier: Bezier4 | null;
  /** 首尾渐细窗口（沿路径长度 px，0=关） */
  taper: number;
  /** 无压感输入时，把速度换算成粗细的强度 0–1 */
  velocity: number;
  stabilizer: number;
}

export interface EditorState {
  ready: boolean;
  doc: DocInfo;
  layers: LayerMeta[];
  activeId: string;
  tool: Tool;
  color: string;
  bgColor: string;
  /**
   * 橡皮行为。SAI/SAI2 的橡皮是「用背景色画」而非抠掉像素
   * （这正是「消しゴムカマ/橡皮陷阱」的成因：擦掉的像素其实还在）。
   * 我们有多图层真透明需求，所以做成两档：
   *   'bg'    涂背景色（SAI 式，默认）—— 适合线稿/平涂在底色层上作画
   *   'alpha' 擦成透明 —— 上层图层需要抠掉像素时用
   */
  eraserMode: 'bg' | 'alpha';
  size: number;
  opacity: number;
  hardness: number;
  flow: number;
  spacing: number;
  pressureCurve: number;
  /** 拖拽精调的压感曲线；null 表示用 pressureCurve 的 gamma 模式 */
  pressureBezier: Bezier4 | null;
  /** 首尾渐细窗口（沿路径长度 px，0=关） */
  taper: number;
  /** 无压感输入时，把速度换算成粗细的强度 0–1 */
  velocity: number;
  stabilizer: number;
  zoom: number;
  transparent: boolean;
  colorMode: ColorMode;
  recentColors: string[];
  status: string;
  canUndo: boolean;
  canRedo: boolean;
  /** 图层内容版本号：抬笔/撤销/图层操作后递增，驱动缩略图与导航器重绘 */
  revision: number;
  rightDockWidth: number;
  rightDockCollapsed: boolean;
  quickbarVisible: boolean;
  chromeVisible: boolean;
  contextMenu: { x: number; y: number } | null;
  selectionVersion: number;
  hasSelection: boolean;
  selectionW: number;
  selectionH: number;
  hasClipboard: boolean;
  presets: BrushPreset[];
  feather: number;
}

export interface CursorInfo {
  x: number;
  y: number;
  inside: boolean;
  pressure: number;
}

export const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'pen', label: '画笔', key: 'B' },
  { id: 'eraser', label: '橡皮', key: 'E' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'ellipse', label: '椭圆', key: 'O' },
  { id: 'line', label: '直线', key: 'L' },
  { id: 'arrow', label: '箭头', key: '⇧A' },
  { id: 'fill', label: '填充', key: 'G' },
  { id: 'pick', label: '吸管', key: 'I' },
  { id: 'selectRect', label: '选框', key: 'M' },
  { id: 'selectLasso', label: '套索', key: 'Q' },
  { id: 'move', label: '移动', key: 'V' },
];
