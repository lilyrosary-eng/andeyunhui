/**
 * 图片查看器的 WebGL2 渲染层（mipmap 缩放）。
 *
 * # 为什么需要它
 *
 * 原实现是 `<img>` + CSS `transform: scale()`。对**缩小**场景这很糟：
 * 浏览器仍以**原图分辨率**持有这张位图，缩小 10 倍时每一帧都要从原图重采样
 * （8000×6000 → 视口 800×600，等于丢掉 99% 的采样点，且没有预滤波 ⇒ 闪烁 + 掉帧）。
 *
 * GNOME 的 Loupe 之所以"缩小也丝滑"，是因为它在 GPU 上做：
 *   1. 图片上传为纹理；
 *   2. `generateMipmap` 生成多级纹理；
 *   3. `LINEAR_MIPMAP_LINEAR` 让缩小 10 倍时直接采样 1/16 的那一级
 *      （采样量降 256 倍，且天然抗锯齿）。
 *
 * 这里复刻第 1–3 步。**不包含瓦片**：GPU 单纹理上限通常是 16384²，
 * 绝大多数照片（4K–12K）一张纹理足够；超过上限时按 `MAX_TEXTURE_SIZE` 降采样
 * （`downscaleToFit`），而不是切瓦片——瓦片留到确认确有必要时再做。
 *
 * # 与 useZoomPan 的契约
 *
 * `camera` 的语义必须与 `useZoomPan` 的 DOM 版完全一致：
 *   `transform: translate(x px, y px) scale(scale)`，`transform-origin: 0 0`
 * 即图片的**左上角**落在视口坐标 (x, y)，尺寸为 `baseRect * scale`。
 * 因此 `draw()` 拿到的 `width/height` 是**未缩放的基础尺寸**（baseRect 尺寸），
 * 不是原图尺寸。
 */

/** 与 useZoomPan 的 ZoomPanCamera 结构一致（不 import 以避免循环依赖） */
export interface CameraLike {
  scale: number;
  x: number;
  y: number;
}

export interface DrawOptions {
  /** 图片在 scale=1 时占据的尺寸（CSS 像素），由调用方按 baseRect 给出 */
  width: number;
  height: number;
  /** 视口（canvas 的 CSS 尺寸） */
  viewportWidth: number;
  viewportHeight: number;
  /** 设备像素比，用于让 canvas 后备缓冲匹配物理像素 */
  dpr: number;
}

const VERT = `#version 300 es
in vec2 a_unit;              // 0..1 的单位四边形
out vec2 v_uv;
uniform vec4 u_tileCss;      // 该瓦片在「图片局部坐标系」里的矩形 (x, y, w, h)，单位 CSS px
uniform vec2 u_translate;    // 相机平移（CSS px）
uniform float u_scale;       // 相机缩放
uniform vec2 u_viewport;     // 视口尺寸（CSS px）
void main() {
  vec2 local = u_tileCss.xy + a_unit * u_tileCss.zw;  // 图片局部坐标
  vec2 screen = local * u_scale + u_translate;        // 视口坐标
  vec2 clip = screen / u_viewport * 2.0 - 1.0;  // → NDC
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0); // Y 轴翻转（视口原点在左上）
  v_uv = a_unit;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_uvOffset;   // 该瓦片在整图中的归一化偏移
uniform vec2 u_uvScale;    // 该瓦片占整图的比例
uniform sampler2D u_tex;
uniform float u_alpha;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, u_uvOffset + v_uv * u_uvScale);
  outColor = vec4(c.rgb, c.a * u_alpha);
}`;

/**
 * 只读图片头部拿尺寸：`onload` 在元数据就绪时即可触发，不必等整像素解码。
 * 返回 null 表示读取失败（调用方回退到解码后取尺寸）。
 */
function readImageHeaderSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (v: { width: number; height: number } | null) => {
      img.onload = null;
      img.onerror = null;
      URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () =>
      done(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}

export class WebglImageCanvas {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tiles = new Map<string, WebGLTexture>();
  /** 正在异步切片中的瓦片（避免重复请求） */
  private pending = new Set<string>();
  /** 每帧最多发起几次异步切片（限流，避免解码队列把主线程压满） */
  private static readonly MAX_TILE_REQ_PER_FRAME = 2;
  /** 当前源地址（供使用方在 LOD 重载时复用，避免依赖外部作用域顺序） */
  private sourceUrl = '';
  /** 瓦片上传完成后请求重绘（由外部注入） */
  private requestRedraw: (() => void) | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uTileCss: WebGLUniformLocation | null = null;
  private uTranslate: WebGLUniformLocation | null = null;
  private uScale: WebGLUniformLocation | null = null;
  private uViewport: WebGLUniformLocation | null = null;
  private uTex: WebGLUniformLocation | null = null;
  private uUvOffset: WebGLUniformLocation | null = null;
  private uUvScale: WebGLUniformLocation | null = null;
  /** 解码后的源位图，瓦片按需从中切（不整体上传） */
  private source: ImageBitmap | null = null;
  /** 源位图的像素尺寸（已降采样） */
  private srcPixelW = 0;
  private srcPixelH = 0;
  /** 瓦片网格 */
  private cols = 0;
  private rows = 0;
  /** 单片边长（像素）；512 在常见视口下可见瓦片数 < 20 */
  private static readonly TILE = 512;
  private uAlpha: WebGLUniformLocation | null = null;

  /** 图片的**原始**像素尺寸（用于布局计算，不能拿纹理尺寸顶替） */
  private srcWidth = 0;
  private srcHeight = 0;
  /** 最近一次 draw 的参数，resize/image 变化后可重放 */
  private lastDraw: { camera: CameraLike; opts: DrawOptions } | null = null;
  private disposed = false;

  /**
   * @param canvas 目标 canvas。构造时即获取 WebGL2 上下文；
   *               **失败返回的实例 `isAvailable()` 为 false**，调用方应回退到 `<img>`。
   */
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      // 省电/降延迟：图片查看是交互式场景，不需要保留绘制缓冲
      preserveDrawingBuffer: false,
      desynchronized: true,
    });
    if (!gl) return;
    this.gl = gl;
    try {
      this.initGl();
    } catch (err) {
      console.error('[webgl] 初始化失败，将回退到 <img>：', err);
      this.gl = null;
    }
  }

  /**
   * 图片的**原始**尺寸（不是纹理尺寸）。
   * 布局要用它算适配比例，用纹理尺寸会把图片显示得比实际小。
   */
  getImageSize(): { width: number; height: number } | null {
    return this.srcWidth > 0 ? { width: this.srcWidth, height: this.srcHeight } : null;
  }

  /** 源位图尺寸与瓦片网格，仅供诊断 */
  getTextureInfo(): { srcWidth: number; srcHeight: number; cols: number; rows: number; tiles: number } | null {
    if (!this.source) return null;
    return {
      srcWidth: this.srcPixelW,
      srcHeight: this.srcPixelH,
      cols: this.cols,
      rows: this.rows,
      tiles: this.tiles.size,
    };
  }

  /** 当前图片地址；为空表示来源不是 URL（Blob/ImageBitmap） */
  getSourceUrl(): string {
    return this.sourceUrl;
  }

  /** 由使用方注入：瓦片异步就绪后触发一次重绘 */
  setRedrawRequester(fn: (() => void) | null): void {
    this.requestRedraw = fn;
  }

  isAvailable(): boolean {
    return this.gl !== null && this.program !== null;
  }

  private initGl(): void {
    const gl = this.gl!;

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`shader 编译失败: ${log}`);
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program 链接失败: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    this.uTileCss = gl.getUniformLocation(prog, 'u_tileCss');
    this.uTranslate = gl.getUniformLocation(prog, 'u_translate');
    this.uScale = gl.getUniformLocation(prog, 'u_scale');
    this.uViewport = gl.getUniformLocation(prog, 'u_viewport');
    this.uTex = gl.getUniformLocation(prog, 'u_tex');
    this.uUvOffset = gl.getUniformLocation(prog, 'u_uvOffset');
    this.uUvScale = gl.getUniformLocation(prog, 'u_uvScale');
    this.uAlpha = gl.getUniformLocation(prog, 'u_alpha');

    // 单位四边形（两个三角形）
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, 'a_unit');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(prog);
    gl.uniform1i(this.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultipliedAlpha
  }

  /**
   * 上传图片。内部用 `createImageBitmap` 解码（比 `<img>` + drawImage 少一次拷贝），
   * 超过 `MAX_TEXTURE_SIZE` 时按比例降采样到上限内。
   */
  async setImage(
    src: Blob | ImageBitmap | string,
    /** 解码时的尺寸上限（CSS 像素）；不给则按 MAX_TEXTURE_SIZE 处理 */
    maxSize?: { width: number; height: number },
  ): Promise<boolean> {
    if (!this.isAvailable() || this.disposed) return false;
    const gl = this.gl!;

    // 关键：**解码阶段**就降到目标尺寸，而不是解出全尺寸再缩。
    // 一张 8000×6000 的图全尺寸解码约 192MB，按屏幕尺寸解只要几 MB。
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const capW = maxSize ? Math.max(1, Math.round(maxSize.width * dpr)) : 0;
    const capH = maxSize ? Math.max(1, Math.round(maxSize.height * dpr)) : 0;
    const resizeOpts: ImageBitmapOptions =
      capW > 0 && capH > 0
        ? { resizeWidth: capW, resizeHeight: capH, resizeQuality: 'high' }
        : {};

    let bitmap: ImageBitmap | null = null;
    try {
      // resizeWidth/Height 会按比例适配（只给两者时浏览器取裁剪式；所以先量一下原尺寸）
      if (typeof src === 'string' || src instanceof Blob) {
        const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
        if (resizeOpts.resizeWidth) {
          // 只读**头部**拿原始尺寸（onload 即可，不必 decode()），
          // 之前用 createImageBitmap(blob) 探尺寸等于整图解码一次、再解码一次，
          // 加载耗时直接翻倍。
          const dim = await readImageHeaderSize(blob);
          if (dim) {
            this.srcWidth = dim.width;
            this.srcHeight = dim.height;
            const ratio = Math.min(
              resizeOpts.resizeWidth / dim.width,
              resizeOpts.resizeHeight! / dim.height,
              1, // 不放大
            );
            bitmap =
              ratio < 1
                ? await createImageBitmap(blob, {
                    resizeWidth: Math.max(1, Math.round(dim.width * ratio)),
                    resizeHeight: Math.max(1, Math.round(dim.height * ratio)),
                    resizeQuality: 'high',
                  })
                : await createImageBitmap(blob);
          } else {
            bitmap = await createImageBitmap(blob);
            this.srcWidth = bitmap.width;
            this.srcHeight = bitmap.height;
          }
        } else {
          bitmap = await createImageBitmap(blob);
          this.srcWidth = bitmap.width;
          this.srcHeight = bitmap.height;
        }
      } else {
        bitmap = src;
        this.srcWidth = bitmap.width;
        this.srcHeight = bitmap.height;
      }
    } catch (err) {
      console.error('[webgl] 解码失败：', err);
      return false;
    }

    // 超出纹理上限时降采样（避免上传失败 / 显存爆掉）
    const maxSide = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    let w = bitmap.width;
    let h = bitmap.height;
    if (w > maxSide || h > maxSide) {
      const r = Math.min(maxSide / w, maxSide / h);
      const nw = Math.max(1, Math.floor(w * r));
      const nh = Math.max(1, Math.floor(h * r));
      const off = document.createElement('canvas');
      off.width = nw;
      off.height = nh;
      off.getContext('2d')!.drawImage(bitmap, 0, 0, nw, nh);
      bitmap.close?.();
      bitmap = await createImageBitmap(off);
      w = nw;
      h = nh;
      console.warn(`[webgl] 图片超过纹理上限 ${maxSide}，已降采样到 ${w}×${h}`);
    }

    // 不整图上传：只保存 source，瓦片在 draw 时按可见区域切。
    // 这样显存只跟「可见瓦片数」有关，与图片总尺寸无关。
    this.sourceUrl = typeof src === 'string' ? src : '';
    this.source?.close?.();
    this.source = bitmap;
    this.srcPixelW = w;
    this.srcPixelH = h;
    this.cols = Math.max(1, Math.ceil(w / WebglImageCanvas.TILE));
    this.rows = Math.max(1, Math.ceil(h / WebglImageCanvas.TILE));
    this.clearTiles();

    if (this.lastDraw) this.draw(this.lastDraw.camera, this.lastDraw.opts);
    return true;
  }

  /** 删除所有瓦片纹理 */
  private clearTiles(): void {
    const gl = this.gl;
    if (gl) for (const t of this.tiles.values()) gl.deleteTexture(t);
    this.tiles.clear();
  }

  /**
   * 取某片瓦片。**只读缓存，不阻塞**：
   * 命中就返回纹理；未命中则发起一次异步切片并返回 null（本帧先跳过该片）。
   * 这样 draw 永远不阻塞主线程 —— 之前的同步 drawImage + texImage2D
   * 在首次加载时一帧内切 20 片，直接把界面卡死。
   */
  private ensureTile(col: number, row: number): WebGLTexture | null {
    const key = `${col},${row}`;
    const hit = this.tiles.get(key);
    if (hit) return hit;
    this.queueTile(col, row);
    return null;
  }

  /** 异步切片 + 上传。createImageBitmap 支持从源位图裁剪，解码在后台线程。 */
  private queueTile(col: number, row: number): void {
    const key = `${col},${row}`;
    if (this.pending.has(key) || this.pending.size >= WebglImageCanvas.MAX_TILE_REQ_PER_FRAME * 4) return;
    const source = this.source;
    if (!source) return;

    const T = WebglImageCanvas.TILE;
    const sx = col * T;
    const sy = row * T;
    const sw = Math.min(T, this.srcPixelW - sx);
    const sh = Math.min(T, this.srcPixelH - sy);
    if (sw <= 0 || sh <= 0) return;

    this.pending.add(key);
    void createImageBitmap(source, sx, sy, sw, sh)
      .then((bmp) => {
        this.pending.delete(key);
        const gl = this.gl;
        if (!gl || this.disposed || this.source !== source) {
          bmp.close?.();
          return;
        }
        const tex = gl.createTexture();
        if (!tex) {
          bmp.close?.();
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        bmp.close?.();
        this.tiles.set(key, tex);
        this.requestRedraw?.();
      })
      .catch(() => {
        this.pending.delete(key);
      });
  }

  /**
   * 每帧调用。**只画视口内可见的瓦片**：纹理按需从 source 切出并上传，
   * 所以显存占用与图片总尺寸无关，只与当前可见瓦片数有关。
   */
  draw(camera: CameraLike, opts: DrawOptions): void {
    if (!this.isAvailable() || this.disposed || !this.source) return;
    const gl = this.gl!;
    const { width, height, viewportWidth, viewportHeight, dpr } = opts;
    this.lastDraw = { camera, opts };

    const bw = Math.max(1, Math.round(viewportWidth * dpr));
    const bh = Math.max(1, Math.round(viewportHeight * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }

    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 图片在视口里的屏幕矩形（左上角 + 缩放后尺寸）
    const imgW = width * camera.scale;
    const imgH = height * camera.scale;
    if (imgW <= 0 || imgH <= 0) return;

    // 与视口求交，得到可见的归一化范围
    const u0 = Math.max(0, -camera.x / imgW);
    const v0 = Math.max(0, -camera.y / imgH);
    const u1 = Math.min(1, (viewportWidth - camera.x) / imgW);
    const v1 = Math.min(1, (viewportHeight - camera.y) / imgH);
    if (u1 <= u0 || v1 <= v0) return; // 整图都在视口外

    const c0 = Math.max(0, Math.floor(u0 * this.cols));
    const c1 = Math.min(this.cols, Math.ceil(u1 * this.cols));
    const r0 = Math.max(0, Math.floor(v0 * this.rows));
    const r1 = Math.min(this.rows, Math.ceil(v1 * this.rows));

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uTranslate, camera.x, camera.y);
    gl.uniform1f(this.uScale, camera.scale);
    gl.uniform2f(this.uViewport, viewportWidth, viewportHeight);
    gl.uniform1f(this.uAlpha, 1);
    gl.uniform1i(this.uTex, 0);

    // 每片在「图片局部坐标系」里的 CSS 尺寸
    const tileW = width / this.cols;
    const tileH = height / this.rows;

    for (let r = r0; r < r1; r += 1) {
      for (let c = c0; c < c1; c += 1) {
        const tex = this.ensureTile(c, r);
        if (!tex) continue;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4f(this.uTileCss, c * tileW, r * tileH, tileW, tileH);
        gl.uniform2f(this.uUvOffset, c / this.cols, r / this.rows);
        gl.uniform2f(this.uUvScale, 1 / this.cols, 1 / this.rows);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (!gl) return;
    for (const t of this.tiles.values()) gl.deleteTexture(t);
    this.tiles.clear();
    this.source?.close?.();
    this.source = null;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.vao = null;
    this.program = null;
    this.gl = null;
  }
}
