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
uniform vec2 u_size;         // 图片基础尺寸（CSS px）
uniform vec2 u_translate;    // 相机平移（CSS px）
uniform float u_scale;       // 相机缩放
uniform vec2 u_viewport;     // 视口尺寸（CSS px）
void main() {
  vec2 px = a_unit * u_size;                    // 图片内的像素坐标
  vec2 screen = px * u_scale + u_translate;     // 视口坐标
  vec2 clip = screen / u_viewport * 2.0 - 1.0;  // → NDC
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0); // Y 轴翻转（视口原点在左上）
  v_uv = a_unit;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  outColor = vec4(c.rgb, c.a * u_alpha);
}`;

export class WebglImageCanvas {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uSize: WebGLUniformLocation | null = null;
  private uTranslate: WebGLUniformLocation | null = null;
  private uScale: WebGLUniformLocation | null = null;
  private uViewport: WebGLUniformLocation | null = null;
  private uTex: WebGLUniformLocation | null = null;
  private uAlpha: WebGLUniformLocation | null = null;

  /** 纹理的实际像素尺寸（可能因超出 MAX_TEXTURE_SIZE 而降采样） */
  private texWidth = 0;
  private texHeight = 0;
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

  /** 纹理的实际像素尺寸（已考虑降采样）；未加载时为 null。 */
  getImageSize(): { width: number; height: number } | null {
    return this.tex ? { width: this.texWidth, height: this.texHeight } : null;
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

    this.uSize = gl.getUniformLocation(prog, 'u_size');
    this.uTranslate = gl.getUniformLocation(prog, 'u_translate');
    this.uScale = gl.getUniformLocation(prog, 'u_scale');
    this.uViewport = gl.getUniformLocation(prog, 'u_viewport');
    this.uTex = gl.getUniformLocation(prog, 'u_tex');
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
  async setImage(src: Blob | ImageBitmap | string): Promise<boolean> {
    if (!this.isAvailable() || this.disposed) return false;
    const gl = this.gl!;

    let bitmap: ImageBitmap | null = null;
    try {
      if (typeof src === 'string') {
        const res = await fetch(src);
        bitmap = await createImageBitmap(await res.blob());
      } else if (src instanceof Blob) {
        bitmap = await createImageBitmap(src);
      } else {
        bitmap = src;
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

    if (this.tex) gl.deleteTexture(this.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    // 关键：缩小用三线性 mipmap，放大用线性（mipmap 层都用得上）
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.tex = tex;
    this.texWidth = w;
    this.texHeight = h;
    bitmap.close?.();

    if (this.lastDraw) this.draw(this.lastDraw.camera, this.lastDraw.opts);
    return true;
  }

  /** 每帧调用：只更新 uniform 与 viewport，不重建纹理。 */
  draw(camera: CameraLike, opts: DrawOptions): void {
    if (!this.isAvailable() || this.disposed || !this.tex) return;
    const gl = this.gl!;
    const { width, height, viewportWidth, viewportHeight, dpr } = opts;
    this.lastDraw = { camera, opts };

    // 后备缓冲按物理像素分配（否则 HiDPI 上会糊）
    const bw = Math.max(1, Math.round(viewportWidth * dpr));
    const bh = Math.max(1, Math.round(viewportHeight * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }

    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    gl.uniform2f(this.uSize, width, height);
    gl.uniform2f(this.uTranslate, camera.x, camera.y);
    gl.uniform1f(this.uScale, camera.scale);
    gl.uniform2f(this.uViewport, viewportWidth, viewportHeight);
    gl.uniform1f(this.uAlpha, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (!gl) return;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.tex = null;
    this.vao = null;
    this.program = null;
    this.gl = null;
  }
}
