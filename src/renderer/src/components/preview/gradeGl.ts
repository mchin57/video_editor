/**
 * The preview's colour-table renderer: WebGL2 drawing a video frame or an
 * image through the baked 3D table (`bakeGradeTable`, shared/grade.ts) — the
 * export applies the very same table with ffmpeg `lut3d`. The fragment shader
 * is `lut3d`'s tetrahedral interpolation case for case (`tetrahedral`,
 * shared/cube.ts) on an `RGB32F` 3D texture read with `texelFetch`, and the
 * result is floored to 8 bits the way `lut3d` truncates; measured within 1
 * level of `lut3d` on every 24-bit colour, on the GPU and on WARP
 * (FFMPEG-NOTES "Colour table").
 *
 * Alpha: the source is uploaded STRAIGHT (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`
 * false), the table applies to the straight colour, and the output is
 * premultiplied for the canvas — so a background-removed clip keeps its matte.
 *
 * No React here; `GradeCanvas.tsx` owns the lifecycle.
 */

const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  // Texture row 0 is the top of the picture.
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D frame;
uniform highp sampler3D lut;
uniform float n;
in vec2 uv;
out vec4 o;
vec3 at(ivec3 i) { return texelFetch(lut, i, 0).rgb; }
void main() {
  vec4 src = texture(frame, uv);
  float s = n - 1.0;
  vec3 x = clamp(src.rgb, 0.0, 1.0) * s;
  ivec3 p = ivec3(min(floor(x), vec3(s)));
  ivec3 q = min(p + 1, ivec3(int(s)));
  vec3 d = x - vec3(p);
  vec3 c000 = at(p);
  vec3 c111 = at(q);
  vec3 c;
  if (d.r > d.g) {
    if (d.g > d.b) c = (1.0 - d.r) * c000 + (d.r - d.g) * at(ivec3(q.r, p.g, p.b)) + (d.g - d.b) * at(ivec3(q.r, q.g, p.b)) + d.b * c111;
    else if (d.r > d.b) c = (1.0 - d.r) * c000 + (d.r - d.b) * at(ivec3(q.r, p.g, p.b)) + (d.b - d.g) * at(ivec3(q.r, p.g, q.b)) + d.g * c111;
    else c = (1.0 - d.b) * c000 + (d.b - d.r) * at(ivec3(p.r, p.g, q.b)) + (d.r - d.g) * at(ivec3(q.r, p.g, q.b)) + d.g * c111;
  } else {
    if (d.b > d.g) c = (1.0 - d.b) * c000 + (d.b - d.g) * at(ivec3(p.r, p.g, q.b)) + (d.g - d.r) * at(ivec3(p.r, q.g, q.b)) + d.r * c111;
    else if (d.b > d.r) c = (1.0 - d.g) * c000 + (d.g - d.b) * at(ivec3(p.r, q.g, p.b)) + (d.b - d.r) * at(ivec3(p.r, q.g, q.b)) + d.r * c111;
    else c = (1.0 - d.g) * c000 + (d.g - d.r) * at(ivec3(p.r, q.g, p.b)) + (d.r - d.b) * at(ivec3(q.r, q.g, p.b)) + d.b * c111;
  }
  // lut3d truncates to 8 bits; the 1e-4 keeps float noise on an exact level from dropping one.
  c = floor(clamp(c, 0.0, 1.0) * 255.0 + 1e-4) / 255.0;
  o = vec4(c * src.a, src.a);
}`

/** What the canvas can be drawn from. */
export type GradeSource = HTMLVideoElement | HTMLImageElement

export interface GradeGl {
  /** Upload a baked table (`size`³ RGB, red fastest). */
  setTable(size: number, data: Float32Array): void
  /** Draw `source` through the table at `width`×`height` (the canvas is resized
   *  to match). False when there is nothing to draw yet (no table / no frame). */
  draw(source: GradeSource, width: number, height: number): boolean
  /** The context is gone (lost, or never made). */
  readonly lost: boolean
  /** Free everything and RELEASE the context (`WEBGL_lose_context`); the canvas can't be drawn on again. */
  dispose(): void
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null
}

/**
 * Set up WebGL2 on `canvas` (null when WebGL2 is unavailable, or the shader
 * won't build). A context lost later shows through `lost`; the caller listens
 * for `webglcontextlost` / `webglcontextrestored` itself and makes a new one.
 */
export function createGradeGl(canvas: HTMLCanvasElement): GradeGl | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
  if (!gl || gl.isContextLost()) return null
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  // The frame: sampled at its own size for video (NEAREST is then exact); an
  // image may be drawn smaller than it is, so LINEAR there.
  const frame = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, frame)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const table = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_3D, table)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.uniform1i(gl.getUniformLocation(prog, 'frame'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1)
  const nLoc = gl.getUniformLocation(prog, 'n')
  let hasTable = false

  return {
    get lost() {
      return gl.isContextLost()
    },
    setTable(size, data) {
      if (gl.isContextLost()) return
      gl.activeTexture(gl.TEXTURE1)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, data)
      gl.uniform1f(nLoc, size)
      hasTable = true
    },
    draw(source, width, height) {
      if (!hasTable || gl.isContextLost() || !(width > 0 && height > 0)) return false
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const scaled =
        source instanceof HTMLImageElement && (source.naturalWidth !== width || source.naturalHeight !== height)
      gl.activeTexture(gl.TEXTURE0)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, scaled ? gl.LINEAR : gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, scaled ? gl.LINEAR : gl.NEAREST)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
      } catch {
        return false // a frame that isn't ready yet (or a source that went away mid-draw)
      }
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return true
    },
    dispose() {
      if (gl.isContextLost()) return
      gl.deleteTexture(frame)
      gl.deleteTexture(table)
      gl.deleteBuffer(quad)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      // Give the context itself back now: Chromium keeps at most 16 and, past
      // that, takes the least recently used one, which may still be on screen.
      // The canvas can't draw again after this (GradeCanvas drops it).
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

/** Longest side a graded image is drawn at (the display PNG is ≤ 1920 already). */
export const MAX_GRADED_IMAGE_SIDE = 2048
