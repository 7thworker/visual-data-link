// GPU sample source (WebGL 1) for the receiver chain (pipeline.js).
//
// On the test iPhones, ~40 of ~47 ms per capture were spent copying the
// camera frame into a 2D canvas and reading its pixels back (drawImage +
// getImageData). Here the video frame is uploaded as a texture instead and
// only the values the chain needs are computed on the GPU and read back:
//   cells     one mean luma per logical cell (3 x 3 points over the central
//             50%, SPEC §5.1), mapped through the homography in the shader
//   profiles  luma along each edge normal for corner refinement
//             (acquisition.js layout: [edge][sample][step])
// Values are encoded as integer part (R) and fraction (G) of the luma in an
// RGBA8 target; B = 255 marks samples outside the frame (NaN).

import { edgeGeometry, profileSteps } from './acquisition.js';

const VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const COMMON = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_size;
float luma(vec2 p) {
  if (p.x < 0.0 || p.y < 0.0 || p.x > u_size.x || p.y > u_size.y) return -1.0;
  vec3 c = texture2D(u_tex, p / u_size).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
}
vec4 encode(float l) {
  if (l < 0.0) return vec4(0.0, 0.0, 1.0, 1.0);
  float f = floor(l);
  return vec4(f / 255.0, l - f, 0.0, 1.0);
}
`;

const FS_CELLS = `${COMMON}
uniform mat3 u_H;
vec2 mapPoint(vec2 q) {
  vec3 v = u_H * vec3(q, 1.0);
  return v.xy / v.z;
}
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  float sum = 0.0;
  float count = 0.0;
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      vec2 o = vec2(0.25 + 0.5 * (float(j) + 0.5) / 3.0, 0.25 + 0.5 * (float(i) + 0.5) / 3.0);
      float l = luma(mapPoint(cell + o));
      if (l >= 0.0) {
        sum += l;
        count += 1.0;
      }
    }
  }
  gl_FragColor = count > 0.0 ? encode(sum / count) : vec4(0.0, 0.0, 1.0, 1.0);
}
`;

const FS_PROFILES = `${COMMON}
uniform vec2 u_a0; uniform vec2 u_a1; uniform vec2 u_a2; uniform vec2 u_a3;
uniform vec2 u_b0; uniform vec2 u_b1; uniform vec2 u_b2; uniform vec2 u_b3;
uniform vec2 u_n0; uniform vec2 u_n1; uniform vec2 u_n2; uniform vec2 u_n3;
uniform float u_radius;
uniform float u_step;
uniform float u_margin;
uniform float u_samples;
void main() {
  float k = floor(gl_FragCoord.x);
  float row = floor(gl_FragCoord.y);
  float e = floor(row / u_samples);
  float s = row - e * u_samples;
  vec2 a = u_a3; vec2 b = u_b3; vec2 n = u_n3;
  if (e < 0.5) { a = u_a0; b = u_b0; n = u_n0; }
  else if (e < 1.5) { a = u_a1; b = u_b1; n = u_n1; }
  else if (e < 2.5) { a = u_a2; b = u_b2; n = u_n2; }
  float t = u_margin + (1.0 - 2.0 * u_margin) * s / (u_samples - 1.0);
  vec2 p = a + (b - a) * t;
  gl_FragColor = encode(luma(p + n * (u_radius - k * u_step)));
}
`;

// Must match acquisition.js DEFAULTS.
const SAMPLES_PER_EDGE = 32;
const EDGE_MARGIN = 0.06;
const STEP = 0.5;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  const loc = new Proxy({}, { get: (cache, name) => (cache[name] ??= gl.getUniformLocation(p, name)) });
  return { p, loc };
}

export function glSupported() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl');
  } catch {
    return false;
  }
}

export class GlSampler {
  constructor() {
    this.kind = 'gpu';
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.cellsProg = program(gl, FS_CELLS);
    this.profProg = program(gl, FS_PROFILES);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.video = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ]) {
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    this.targets = new Map(); // "w x h" -> { fb, tex, pixels }
    this.width = 0;
    this.height = 0;
    this.gpuMs = 0; // time spent in draws + readbacks since the last upload
  }

  #target(w, h) {
    const key = `${w}x${h}`;
    let t = this.targets.get(key);
    if (!t) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
      t = { fb, tex, pixels: new Uint8Array(w * h * 4) };
      this.targets.set(key, t);
      if (this.targets.size > 8) this.targets.delete(this.targets.keys().next().value);
    }
    return t;
  }

  // Uploads the current video frame (or any TexImageSource). Returns ms.
  upload(source) {
    const t0 = performance.now();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.width = source.videoWidth ?? source.width;
    this.height = source.videoHeight ?? source.height;
    this.gpuMs = 0;
    return performance.now() - t0;
  }

  #run(prog, w, h, setUniforms) {
    const t0 = performance.now();
    const gl = this.gl;
    const t = this.#target(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    gl.uniform1i(prog.loc.u_tex, 0);
    gl.uniform2f(prog.loc.u_size, this.width, this.height);
    setUniforms(gl, prog.loc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, t.pixels);
    const out = new Float32Array(w * h);
    const px = t.pixels;
    for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = px[o + 2] === 255 ? NaN : px[o] + px[o + 1] / 255;
    this.gpuMs += performance.now() - t0;
    return out;
  }

  // Sample-source interface (pipeline.js).
  cells(H, gridWidth, gridHeight, k) {
    if (k !== 3) throw new Error('GPU sampler supports the 3 x 3 kernel only');
    // Row-major H -> column-major mat3.
    const m = new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]);
    return this.#run(this.cellsProg, gridWidth, gridHeight, (gl, loc) => gl.uniformMatrix3fv(loc.u_H, false, m));
  }

  profiles(quad, radius) {
    const geo = edgeGeometry(quad, { samplesPerEdge: SAMPLES_PER_EDGE, edgeMargin: EDGE_MARGIN });
    const n = profileSteps(radius, { step: STEP });
    return this.#run(this.profProg, n, 4 * SAMPLES_PER_EDGE, (gl, loc) => {
      geo.forEach((g, e) => {
        gl.uniform2f(loc[`u_a${e}`], g.ax, g.ay);
        gl.uniform2f(loc[`u_b${e}`], g.bx, g.by);
        gl.uniform2f(loc[`u_n${e}`], g.nx, g.ny);
      });
      gl.uniform1f(loc.u_radius, radius);
      gl.uniform1f(loc.u_step, STEP);
      gl.uniform1f(loc.u_margin, EDGE_MARGIN);
      gl.uniform1f(loc.u_samples, SAMPLES_PER_EDGE);
    });
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
