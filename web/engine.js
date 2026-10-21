/* Handwriting engine: Graves RNN handwriting synthesis, a port of ../model.py.
 * Classic script, no dependencies: <script src> (global HWEngine), importScripts in a Worker, or require() in Node.
 * Weights: sjvasquez/handwriting-synthesis (IAM-OnDB) as the f16 KGM1 blob from tibordp/kurvengefahr (GPL-2.0).
 *
 * With weights.js and styles.js loaded:
 *   const model = HWEngine.loadModel(HWEngine.b64ToBytes(HW_WEIGHTS_B64));
 *   const hand = new HWEngine.Hand(model, HWEngine.decodePreset(HW_PRESETS[9]));
 *   const strokes = hand.word(HWEngine.cleanText("hello").clean, seed); */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HWEngine = Object.assign(factory(), { source: String(factory) }); // source: to start Web Workers from file://
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ALPHABET = "\x00 !\"#'(),-.0123456789:;?ABCDEFGHIJKLMNOPRSTUVWYabcdefghijklmnopqrstuvwxyz";
  const IDX = new Map(Array.from(ALPHABET, (c, i) => [c, i]));
  const MAX_STROKE_LEN = 1200;
  const MAX_BATCH = 4;   // words written at once (stepMany): 4 already gets most of the gain with 6 workers
  const BLOCK_ROWS = 32; // weight rows per block in stepMany: 32 x 1600 floats = 200 KB, stays in cache while every word uses it

  // Word-sampling knobs from kurvengefahr model.rs, in model units of style 9 (its calibration style),
  // scaled to each style's own x-height (see Hand.k).
  const CALIBRATION_XH = 9.85;
  const TRAIL_MAX_STEPS = 48; // keep sampling this long after the word ends, for t-bars and i-dots
  const TRAIL_MARGIN_LEFT = 6.0, TRAIL_MARGIN_RIGHT = 12.0, TRAIL_MARGIN_Y = 7.0;
  const TRAIL_BAR_SPAN = 4.5, TRAIL_BAR_OVERLAP = 2.0, TRAIL_DOT_OVERLAP = 4.0;
  const TRAIL_MIN_Y = 0.3; // in x-heights above baseline: t-bars and i-dots ride high, a next word's start doesn't
  const TRAIL_PUNCT_SIZE = 0.7; // in x-heights: a final '.' or ',' is a small mark just right of the word
  const WORD_ATTEMPTS = 4;
  const MIN_REL_DWELL = 0.45;
  const FOLLOW_ON = "the";     // filler written after each word so the model finishes it naturally (then cut off)
  const FOLLOW_GAP = 0.6;      // x-heights right of the word where a new stroke counts as the filler starting
  const FOLLOW_ATTEMPTS = 6; // resample a word if attention skipped one of its letters

  // Characters the model never saw, mapped to ones it did (from kurvengefahr compose.rs).
  const SUBST = new Map([["Q", "q"], ["X", "x"], ["Z", "z"], ["‘", "'"], ["’", "'"], ["`", "'"],
    ["“", '"'], ["”", '"'], ["–", "-"], ["—", "-"], ["…", "..."], [" ", " "]]);
  for (const [plain, accented] of Object.entries({ a: "áàâäãå", e: "éèêë", i: "íìîï", o: "óòôöõ", u: "úùûü", n: "ñ", c: "ç" }))
    for (const ch of accented) SUBST.set(ch, plain);

  /** Map text into the model alphabet. keep: extra characters to let through, such as layout marks the caller strips
   *  before writing ("_*"). Returns {clean, dropped: Set of characters that were removed}. */
  function cleanText(text, keep = "") {
    let clean = "";
    const dropped = new Set();
    for (const ch of text) {
      const c = /\s/.test(ch) && ch !== "\n" ? " " : SUBST.get(ch) ?? ch; // tabs etc. still separate words
      if (c === "\n" || (c.length === 1 && keep.includes(c)) || Array.from(c).every(x => IDX.has(x) && x !== "\x00")) clean += c;
      else dropped.add(c);
    }
    return { clean, dropped };
  }

  /** Clean text -> alphabet indices plus the NUL terminator (model.py one_hot, kept as indices). */
  function encode(text) {
    const idx = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) {
      const v = IDX.get(text[i]);
      if (v === undefined || v === 0) throw new Error(`character ${JSON.stringify(text[i])} is not in the model alphabet; run cleanText first`);
      idx[i] = v;
    }
    return idx;
  }

  // ---- stroke preprocessing (sjvasquez drawing.py). Coords are flat Float64Arrays of [x, y, eos] rows. ----

  /** Remove global slant/offset with a least-squares line fit y = offset + slope * x. */
  function align(c) {
    const n = c.length / 3;
    let mx = 0, my = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { mx += c[3 * i]; my += c[3 * i + 1]; }
    mx /= n; my /= n;
    for (let i = 0; i < n; i++) { const dx = c[3 * i] - mx; sxx += dx * dx; sxy += dx * (c[3 * i + 1] - my); }
    let slope = sxy / sxx, offset = my - slope * mx;
    if (!(sxx > 0)) { const x0 = c[0]; slope = my * x0 / (1 + x0 * x0); offset = my / (1 + x0 * x0); } // lstsq's min-norm answer when every x is equal
    const t = Math.atan(slope), cos = Math.cos(t), sin = Math.sin(t), out = new Float64Array(c);
    for (let i = 0; i < n; i++) {
      const x = c[3 * i], y = c[3 * i + 1];
      out[3 * i] = x * cos + y * sin - offset;
      out[3 * i + 1] = -x * sin + y * cos - offset;
    }
    return out;
  }

  const SAVGOL_7_3 = [-2, 3, 6, 7, 6, 3, -2].map(v => v / 21); // == scipy savgol_filter(x, 7, 3, mode='nearest')

  /** Savitzky-Golay smoothing per stroke; eos=1 marks each stroke's last point. */
  function denoise(c) {
    const n = c.length / 3, out = new Float64Array(c);
    for (let s = 0; s < n;) {
      let e = s;
      while (e < n - 1 && c[3 * e + 2] !== 1) e++;
      for (let i = s; i <= e; i++) {
        let vx = 0, vy = 0;
        for (let j = 0; j < 7; j++) {
          const p = 3 * Math.min(Math.max(i + j - 3, s), e); // edge padding
          vx += c[p] * SAVGOL_7_3[j];
          vy += c[p + 1] * SAVGOL_7_3[j];
        }
        out[3 * i] = vx;
        out[3 * i + 1] = vy;
      }
      s = e + 1;
    }
    return out;
  }

  function coordsToOffsets(c) {
    const out = new Float64Array(c.length);
    out[2] = 1;
    for (let i = 3; i < c.length; i += 3) {
      out[i] = c[i] - c[i - 3];
      out[i + 1] = c[i + 1] - c[i - 2];
      out[i + 2] = c[i + 2];
    }
    return out;
  }

  /** A new handwriting from an existing primer: slant (degrees, + leans right) and width factor. The model copies
   *  the primer's geometry, so a slanted/wider sample gives a slanted/wider hand. Returns new [dx, dy, eos] rows. */
  function transformPrimer(strokes, slantDeg = 0, width = 1) {
    if (!slantDeg && width === 1) return Float32Array.from(strokes);
    const T = strokes.length / 3, k = Math.tan(slantDeg * Math.PI / 180), out = new Float32Array(strokes.length);
    let x = 0, y = 0, px = 0, py = 0;
    const steps = [];
    for (let t = 0; t < T; t++) {
      x += strokes[3 * t]; y += strokes[3 * t + 1];
      const nx = (x + k * y) * width;
      if (t) steps.push(Math.hypot(nx - px, y - py));
      out[3 * t] = t ? nx - px : 0; out[3 * t + 1] = t ? y - py : 0; out[3 * t + 2] = strokes[3 * t + 2];
      px = nx; py = y;
    }
    steps.sort((a, b) => a - b);
    const med = steps.length ? steps[steps.length >> 1] : 1; // back to median step 1, as the training data was
    for (let t = 0; t < T; t++) { out[3 * t] /= med; out[3 * t + 1] /= med; }
    return out;
  }

  // ---- WebAssembly SIMD kernel: out[0..cols) += x[0..rows) @ K[rows, cols] (row-major, cols % 4 == 0) ----
  const SIMD_KERNEL = (() => {
    const uleb = n => { const b = []; do { let c = n & 127; n >>>= 7; if (n) c |= 128; b.push(c); } while (n); return b; };
    const sleb = n => { const b = []; for (;;) { const c = n & 127; n >>= 7; if ((n === 0 && !(c & 64)) || (n === -1 && (c & 64))) { b.push(c); return b; } b.push(c | 128); } };
    const sec = (id, body) => [id, ...uleb(body.length), ...body];
    const vec = items => [...uleb(items.length), ...items.flat()];
    const str = s => [...uleb(s.length), ...Array.from(s, c => c.charCodeAt(0))];
    const I32 = 0x7f, V128 = 0x7b;
    const lg = n => [0x20, n], ls = n => [0x21, n], i32c = n => [0x41, ...sleb(n)];
    const SIMD = (op, ...imm) => [0xfd, ...uleb(op), ...imm];
    // params: 0 x, 1 k, 2 rows, 3 cols, 4 out (byte addresses) ; locals: 5 i, 6 j, 7 kp, 8 op, 9 xi (v128)
    const code = [
      ...lg(1), ...ls(7),                                  // kp = k
      0x02, 0x40, 0x03, 0x40,                              // block loop (rows)
      ...lg(5), ...lg(2), 0x4f, 0x0d, 1,                   //   if i >= rows break
      ...lg(0), ...lg(5), ...i32c(2), 0x74, 0x6a,          //   x + i*4
      0x2a, 2, 0, ...SIMD(0x13), ...ls(9),                 //   xi = splat(f32.load)
      ...i32c(0), ...ls(6), ...lg(4), ...ls(8),            //   j = 0; op = out
      0x02, 0x40, 0x03, 0x40,                              //   block loop (cols)
      ...lg(6), ...lg(3), 0x4f, 0x0d, 1,                   //     if j >= cols break
      ...lg(8),                                            //     store address
      ...lg(8), ...SIMD(0x00, 4, 0),                       //     v128.load(op)
      ...lg(7), ...SIMD(0x00, 4, 0), ...lg(9), ...SIMD(0xe6), //   f32x4.mul(load(kp), xi)
      ...SIMD(0xe4), ...SIMD(0x0b, 4, 0),                  //     f32x4.add; v128.store
      ...lg(8), ...i32c(16), 0x6a, ...ls(8),
      ...lg(7), ...i32c(16), 0x6a, ...ls(7),
      ...lg(6), ...i32c(4), 0x6a, ...ls(6),
      0x0c, 0, 0x0b, 0x0b,                                 //   br loop; end; end
      ...lg(5), ...i32c(1), 0x6a, ...ls(5),                //   i++
      0x0c, 0, 0x0b, 0x0b,                                 // br loop; end; end
      0x0b];
    const func = [2, 4, I32, 1, V128, ...code];
    return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
      ...sec(1, vec([[0x60, ...vec([[I32], [I32], [I32], [I32], [I32]]), 0]])), // type (i32 x5) -> ()
      ...sec(2, vec([[...str("env"), ...str("memory"), 2, 0, 1]])),          // import memory, min 1 page
      ...sec(3, vec([[0]])),
      ...sec(7, vec([[...str("matvec"), 0, 0]])),
      ...sec(10, vec([[...uleb(func.length), ...func]]))]);
  })();
  const simdSupported = typeof WebAssembly === "object" && WebAssembly.validate(SIMD_KERNEL);

  const prod = new Float32Array(1);
  /** Pure-JS twin of the SIMD kernel on heap F (float indices). Rounding each product to f32 makes it
   *  bit-identical to f32x4 mul+add. It rounds by storing to `prod`, not Math.fround: V8's Maglev tier
   *  does not inline fround, and callers it compiles ran this loop 10x slower. */
  function matvecJS(F, x, k, rows, cols, out) {
    for (let i = 0; i < rows; i++) {
      const xi = F[x + i], p = k + i * cols;
      for (let j = 0; j < cols; j++) { prod[0] = xi * F[p + j]; F[out + j] += prod[0]; }
    }
  }

  const sigmoid = v => 1 / (1 + Math.exp(-v));
  const softplus = v => Math.log1p(Math.exp(-Math.abs(v))) + Math.max(v, 0);

  function f16Table() {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1;
      t[h] = s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
    }
    return t;
  }

  class Model {
    /** blob: ArrayBuffer or typed array holding model.f16.bin; useSimd: false forces the pure-JS path. */
    constructor(blob, useSimd = true) {
      const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
      const head = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 24));
      if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(0, 4)) !== "KGM1") throw new Error("bad weight file");
      const [A, H, K, M] = [8, 12, 16, 20].map(o => head.getUint32(o, true));
      if (A !== ALPHABET.length) throw new Error("weight file alphabet does not match");
      const I1 = A + 3 + H, I2 = 3 + H + A + H, G = 4 * H, U = 6 * M + 1;
      // Blob order first (k1 .. gb), then scratch: x = matvec input, att = attention head, g = MDN head, and per batch
      // slot (stepMany): xs = LSTM input, zs = LSTM gates, gs = MDN head. I2 and G are multiples of 4, so slots stay aligned.
      const UP = Math.ceil(U / 4) * 4;
      const sizes = { k1: I1 * G, b1: G, aw: I1 * 3 * K, ab: 3 * K, k2: I2 * G, b2: G, k3: I2 * G, b3: G, gw: H * U, gb: U,
        x: I2, att: 3 * K, g: U, xs: MAX_BATCH * I2, zs: MAX_BATCH * G, gs: MAX_BATCH * UP };
      const o = {};
      let total = 0;
      for (const [name, n] of Object.entries(sizes)) { o[name] = total; total += Math.ceil(n / 4) * 4; } // 16-byte aligned for v128
      const nWeights = Object.keys(sizes).slice(0, 10).reduce((s, name) => s + sizes[name], 0);
      if (bytes.length !== 24 + 2 * nWeights) throw new Error("bad weight file size");

      this.simd = useSimd && simdSupported;
      if (this.simd) {
        const memory = new WebAssembly.Memory({ initial: Math.ceil(total * 4 / 65536) });
        const { matvec } = new WebAssembly.Instance(new WebAssembly.Module(SIMD_KERNEL), { env: { memory } }).exports;
        this.F = new Float32Array(memory.buffer, 0, total);
        this.matvec = (x, k, rows, out) => matvec(x * 4, k * 4, rows, G, out * 4);
      } else {
        this.F = new Float32Array(total);
        this.matvec = (x, k, rows, out) => matvecJS(this.F, x, k, rows, G, out);
      }

      const f16 = new Uint16Array(bytes.slice(24).buffer), table = f16Table();
      let pos = 0;
      for (const name of Object.keys(sizes).slice(0, 10))
        for (let i = 0, d = o[name]; i < sizes[name]; i++) this.F[d + i] = table[f16[pos++]];

      Object.assign(this, { A, H, K, M, o, I1, I2 });
      this.gView = this.F.subarray(o.g, o.g + U);
      this.gViews = Array.from({ length: MAX_BATCH }, (_, b) => this.F.subarray(o.gs + b * UP, o.gs + b * UP + U));
      this.alpha = new Float64Array(K);
      this.beta = new Float64Array(K);
      this.pis = new Float64Array(M);
    }

    zeroState() {
      const { H, K, A } = this, z = n => new Float32Array(n);
      return { h1: z(H), c1: z(H), h2: z(H), c2: z(H), h3: z(H), c3: z(H), kappa: z(K), w: z(A) };
    }

    /** One LSTM layer for every item in the batch; input b sits at slot xs[b]. Each block of weight rows is read once
     *  for all items. Rows still add up in order, so each item gets bit for bit what it would get alone. */
    lstm(rows, k, b, items, hKey, cKey) {
      const { F, H, I2 } = this, o = this.o, G = 4 * H, n = items.length;
      F.fill(0, o.zs, o.zs + n * G);
      for (let r = 0; r < rows; r += BLOCK_ROWS)
        for (let i = 0; i < n; i++) this.matvec(o.xs + i * I2 + r, k + r * G, Math.min(BLOCK_ROWS, rows - r), o.zs + i * G);
      for (let i = 0; i < n; i++) {
        const h = items[i][1][hKey], c = items[i][1][cKey], z = o.zs + i * G;
        for (let j = 0; j < H; j++) {
          const zi = F[z + j] + F[b + j], zg = F[z + H + j] + F[b + H + j];
          const zf = F[z + 2 * H + j] + F[b + 2 * H + j], zo = F[z + 3 * H + j] + F[b + 3 * H + j];
          c[j] = sigmoid(zf + 1) * c[j] + sigmoid(zi) * Math.tanh(zg); // forget_bias 1.0
          h[j] = sigmoid(zo) * Math.tanh(c[j]);
        }
      }
    }

    /** MDN parameters for top-layer output h3. Returns a view that the next mdn()/step() overwrites
     *  (slot = a stepMany batch slot: its own view, overwritten only by the next stepMany). */
    mdn(h3, slot = -1) {
      const { F, H } = this, o = this.o, out = slot < 0 ? this.gView : this.gViews[slot], g = out.byteOffset / 4, n = out.length;
      F.set(h3, o.x);
      F.fill(0, g, g + n);
      matvecJS(F, o.x, o.gw, H, n, g);
      for (let j = 0; j < n; j++) F[g + j] += F[o.gb + j];
      return out;
    }

    /** One timestep. x = [dx, dy, eos]; st is updated in place; idx = encode(text).
     *  Returns {g: MDN params (view, overwritten by the next step), phi: attention weights over idx (Float32Array)}. */
    step(x, st, idx) { return this.stepMany([[x, st, idx]])[0]; }

    /** One timestep for each of up to MAX_BATCH items [x, st, idx] (different texts and states, even different
     *  styles): bit for bit what step() gives each one, but the LSTM weights stream from memory once for all of them.
     *  Several workers each streaming their own 14 MB of weights make memory, not arithmetic, the bottleneck. */
    stepMany(items) {
      const { F, A, H, K, I2, alpha, beta } = this, o = this.o, n = items.length, out = [];
      if (!(n >= 1 && n <= MAX_BATCH)) throw new Error(`batch of ${n} steps`);
      for (let i = 0; i < n; i++) {
        const [x, st] = items[i], X = o.xs + i * I2;
        F.set(st.w, X); F[X + A] = x[0]; F[X + A + 1] = x[1]; F[X + A + 2] = x[2]; F.set(st.h1, X + A + 3);
      }
      this.lstm(this.I1, o.k1, o.b1, items, "h1", "c1");

      for (let i = 0; i < n; i++) {
        const [x, st, idx] = items[i], X = o.xs + i * I2, U = idx.length;
        F.set(st.h1, X + A + 3); // attention reads [w, x, new h1]
        F.fill(0, o.att, o.att + 3 * K);
        matvecJS(F, X, o.aw, this.I1, 3 * K, o.att);
        for (let k = 0; k < K; k++) {
          alpha[k] = softplus(F[o.att + k] + F[o.ab + k]);
          beta[k] = Math.max(softplus(F[o.att + K + k] + F[o.ab + K + k]), 0.01);
          st.kappa[k] += softplus(F[o.att + 2 * K + k] + F[o.ab + 2 * K + k]) / 25;
        }
        const phi = new Float32Array(U);
        for (let u = 0; u < U; u++) {
          let s = 0;
          for (let k = 0; k < K; k++) { const d = st.kappa[k] - u; s += alpha[k] * Math.exp(-(d * d) / beta[k]); }
          phi[u] = s;
        }
        st.w.fill(0);
        for (let u = 0; u < U; u++) st.w[idx[u]] += phi[u];
        F[X] = x[0]; F[X + 1] = x[1]; F[X + 2] = x[2]; F.set(st.h1, X + 3); F.set(st.w, X + 3 + H); F.set(st.h2, X + 3 + H + A);
        out.push({ g: null, phi });
      }
      this.lstm(I2, o.k2, o.b2, items, "h2", "c2");
      for (let i = 0; i < n; i++) { const st = items[i][1], X = o.xs + i * I2; F.set(st.h2, X + 3); F.set(st.h3, X + 3 + H + A); }
      this.lstm(I2, o.k3, o.b3, items, "h3", "c3");
      for (let i = 0; i < n; i++) out[i].g = this.mdn(items[i][1].h3, i);
      return out;
    }

    /** Sample one [dx, dy, pen_up] like sjvasquez rnn_cell, incl. its <1% mixture cut-off. */
    sample(g, bias, rng) {
      const M = this.M, pis = this.pis;
      let max = -Infinity, sum = 0;
      for (let i = 0; i < M; i++) { pis[i] = g[i] * (1 + bias); if (pis[i] > max) max = pis[i]; }
      for (let i = 0; i < M; i++) { pis[i] = Math.exp(pis[i] - max); sum += pis[i]; }
      for (let i = 0; i < M; i++) { pis[i] /= sum; if (pis[i] < 0.01) pis[i] = 0; }
      const k = rng.choice(pis);
      const s1 = Math.max(Math.exp(g[M + k] - bias), 1e-4), s2 = Math.max(Math.exp(g[2 * M + k] - bias), 1e-4);
      const rho = Math.min(Math.max(Math.tanh(g[3 * M + k]), -1 + 1e-8), 1 - 1e-8);
      const z1 = rng.normal(), z2 = rng.normal();
      const e = sigmoid(g[6 * M]);
      return new Float32Array([g[4 * M + k] + s1 * z1, g[5 * M + k] + s2 * (rho * z1 + Math.sqrt(1 - rho * rho) * z2),
        e >= 0.01 && rng.random() < e ? 1 : 0]);
    }
  }

  /** Synchronous; awaiting the result also works. opts.simd = false forces the pure-JS kernel. */
  function loadModel(blob, opts = {}) {
    return new Model(blob, opts.simd !== false);
  }

  /** Deterministic RNG: mulberry32 + Box-Muller. */
  function makeRng(seed) {
    let a = seed | 0, spare = null;
    const random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random,
      normal() {
        if (spare !== null) { const z = spare; spare = null; return z; }
        const r = Math.sqrt(-2 * Math.log(1 - random())), t = 2 * Math.PI * random();
        spare = r * Math.sin(t);
        return r * Math.cos(t);
      },
      /** Index drawn with probability proportional to weights p. */
      choice(p) {
        let total = 0, acc = 0;
        for (let i = 0; i < p.length; i++) total += p[i];
        const u = random() * total;
        for (let i = 0; i < p.length; i++) { acc += p[i]; if (u < acc) return i; }
        for (let i = p.length - 1; i >= 0; i--) if (p[i] > 0) return i;
        throw new Error("choice: no positive weight");
      },
    };
  }

  /** [xmin, xmax, ymin, ymax] of trajectory points from..to (flat [x, y, pen] rows). */
  function bbox(traj, from, to) {
    const b = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = from; i < to; i++) {
      const x = traj[3 * i], y = traj[3 * i + 1];
      if (x < b[0]) b[0] = x; if (x > b[1]) b[1] = x;
      if (y < b[2]) b[2] = y; if (y > b[3]) b[3] = y;
    }
    return b;
  }

  function percentile(sorted, q) { // numpy's default 'linear' method
    const pos = q / 100 * (sorted.length - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, sorted.length - 1);
    const t = pos - lo, a = sorted[lo], d = sorted[hi] - a;
    return t >= 0.5 ? sorted[hi] - d * (1 - t) : a + d * t;
  }

  /** One handwriting style: the model primed on a sample line, writing word by word. */
  class Hand {
    /** style: {strokes: Float32Array of [dx, dy, eos] rows, chars: the text those strokes say}. */
    constructor(model, style) {
      const strokes = Float32Array.from(style.strokes), T = strokes.length / 3;
      if (!(T >= 1) || T % 1) throw new Error("style strokes must be [dx, dy, eos] rows");
      this.m = model;
      this.primeText = cleanText(style.chars).clean.replace(/\n/g, " ");
      const idx = encode(this.primeText + " ");
      const st = model.zeroState();
      for (let t = 0; t < T; t++) model.step(strokes.subarray(3 * t, 3 * t + 3), st, idx);
      this.state = st; // attention now sits at the primer/space boundary; reused for every word

      const y = new Float32Array(T); // float32 cumsum, as numpy does it on the float32 strokes
      for (let t = 0, acc = 0; t < T; t++) y[t] = acc = Math.fround(acc + strokes[3 * t + 1]);
      const sorted = Float64Array.from(y).sort(), base = percentile(sorted, 20);
      this.xh = percentile(sorted, 75) - base; // x-height in model units (~7 for IAM writers)
      this.startY = y[T - 1] - base; // word frames start where the primer ended, measured from baseline
      this.k = this.xh / CALIBRATION_XH;
      if (!(this.xh > 0)) throw new Error("style primer has no height");
    }

    /** Write one word (no spaces, cleaned text). Deterministic for (word, seed, bias).
     *  Returns strokes, each an array of [x, y] in x-height units: baseline y=0, x-height y=1, y up, x starting at 0. */
    word(word, seed, bias = 0.75) { return runWords(this.m, [this.wordSteps(word, seed, bias)])[0]; }

    /** word() as a generator that yields each model step it needs ([x, st, idx]) and takes back its result, so
     *  runWords can step several words at once. */
    *wordSteps(word, seed, bias = 0.75) {
      const n = word.length;
      if (!n) return [];
      const next = this.followOn !== false;
      const idx = encode(this.primeText + " " + word + " " + (next ? FOLLOW_ON + " " : "")), start = this.primeText.length + 1;
      const rng = makeRng(seed);
      let best = null;
      for (let a = 0; a < (next ? FOLLOW_ATTEMPTS : WORD_ATTEMPTS); a++) {
        const { traj, dwell, finished } = next ? yield* this._sampleNext(idx, start, n, rng, bias)
          : yield* this._sample(idx, start, n, rng, bias, ".,;:".includes(word[n - 1]));
        const d = Float64Array.from(dwell).sort();
        let score = d[0] / Math.max(d[n >> 1], 1e-6);
        if (traj.length) { const b = bbox(traj, 0, traj.length / 3); if (b[1] - b[0] < 0.3 * n * this.xh) score = 0; } // far too narrow: letters were dropped
        if (!finished) score = -1; // ran out of steps before the end of the word: prefer any attempt that finished
        if (!best || score > best.score) best = { score, traj };
        if (score >= MIN_REL_DWELL) break;
      }
      return this._finish(best.traj, ".:;'\"".includes(word[0]));
    }

    /** Sample a word followed by a filler word. Having somewhere to go next, the model finishes the word the way
     *  people do, crossing t's and completing x's and digits before moving on; we keep everything up to the first
     *  stroke of the filler (a pen-down that starts clearly right of the word while attention has moved past it). */
    *_sampleNext(idx, start, n, rng, bias) {
      const m = this.m, xh = this.xh, U = idx.length;
      const st = {};
      for (const key in this.state) st[key] = this.state[key].slice();
      let x = m.sample(m.mdn(st.h3), bias, rng);
      const cap = Math.min(40 * n + 160, MAX_STROKE_LEN);
      const traj = new Float64Array(3 * cap), dwell = new Float32Array(n);
      let len = 0, cx = 0, cy = this.startY, phi = null, cut = null, right = -Infinity, penUp = true;
      while (len < cap) {
        cx += x[0]; cy += x[1];
        let am = 0;
        if (phi) for (let u = 1; u < U; u++) if (phi[u] > phi[am]) am = u;
        if (penUp && len > 0 && am >= start + n && cx > right + FOLLOW_GAP * xh) { cut = len; break; } // the filler begins
        if (phi && am > start + n + 1) { cut = len; break; } // attention is well into the filler: whatever comes is the filler
        traj[3 * len] = cx; traj[3 * len + 1] = cy; traj[3 * len + 2] = x[2];
        len++;
        if (cx > right) right = cx;
        penUp = x[2] === 1;
        const r = yield [x, st, idx];
        phi = r.phi;
        x = m.sample(r.g, bias, rng);
        for (let i = 0; i < n; i++) dwell[i] += phi[start + i];
      }
      if (len) traj[3 * len - 1] = 1; // the kept part ends with the pen up
      return { traj: traj.subarray(0, 3 * len), dwell, finished: cut !== null };
    }

    *_sample(idx, start, n, rng, bias, endsWithPunct) {
      const m = this.m, k = this.k, xh = this.xh, U = idx.length;
      const st = {};
      for (const key in this.state) st[key] = this.state[key].slice();
      let x = m.sample(m.mdn(st.h3), bias, rng);
      const maxSteps = Math.min(40 * n + 40, MAX_STROKE_LEN) /* +40: short words need room to finish */, cap = maxSteps + TRAIL_MAX_STEPS;
      const traj = new Float64Array(3 * cap), dwell = new Float32Array(n);
      let len = 0, cx = 0, cy = this.startY, phi = null, cut = null, box = null, trail = 0;
      while (len < cap) {
        cx += x[0]; cy += x[1];
        traj[3 * len] = cx; traj[3 * len + 1] = cy; traj[3 * len + 2] = x[2];
        len++;
        let done = false; // attention reached the trailing space
        if (phi) { let am = 0; for (let u = 1; u < U; u++) if (phi[u] > phi[am]) am = u; done = am >= U - 2; }
        if (cut === null) {
          if (done && x[2]) { cut = len; box = bbox(traj, 0, len); }
          else if (len >= maxSteps) break;
        } else {
          trail++;
          if (!(box[0] - TRAIL_MARGIN_LEFT * k <= cx && cx <= box[1] + TRAIL_MARGIN_RIGHT * k &&
                box[2] - TRAIL_MARGIN_Y * k <= cy && cy <= box[3] + TRAIL_MARGIN_Y * k))
            break; // wandered off: the model started an imagined next word
          if (x[2]) {
            const s = bbox(traj, cut, len);
            const bar = s[1] - s[0] >= TRAIL_BAR_SPAN * k && s[0] <= box[1] - TRAIL_BAR_OVERLAP * k;
            const dot = s[0] <= box[1] - TRAIL_DOT_OVERLAP * k;
            const punct = endsWithPunct && Math.max(s[1] - s[0], s[3] - s[2]) <= TRAIL_PUNCT_SIZE * xh &&
              s[0] <= box[1] + xh && s[3] <= 0.5 * xh;
            if (punct) endsWithPunct = false; // only one
            else if (s[2] < TRAIL_MIN_Y * xh || !(bar || dot)) break;
            cut = len; // adopt the t-bar / i-dot
          }
          if (trail >= TRAIL_MAX_STEPS) break;
        }
        const r = yield [x, st, idx];
        phi = r.phi;
        x = m.sample(r.g, bias, rng);
        for (let i = 0; i < n; i++) dwell[i] += phi[start + i];
      }
      return { traj: traj.subarray(0, 3 * (cut === null ? len : cut)), dwell, finished: cut !== null };
    }

    _finish(traj, keepLead = false) {
      let s = 0;
      const n = traj.length / 3;
      while (n - s > 1 && traj[3 * s + 2]) s++; // landing points after the jump from the primer: would plot as stray dots
      if (n - s === 0) return [];
      const a = Float64Array.from(traj.subarray(3 * s)); // pen flags are exactly 0/1 from sample()
      a[a.length - 1] = 1;
      const d = denoise(a);
      const strokes = [];
      let cur = [];
      for (let i = 0; i < d.length; i += 3) {
        const x = d[i] / this.xh, y = d[i + 1] / this.xh;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("model produced a non-finite point");
        cur.push([x, y]);
        if (d[i + 2] === 1) { strokes.push(cur); cur = []; }
      }
      const span = (st, k) => Math.max(...st.map(p => p[k])) - Math.min(...st.map(p => p[k]));
      while (!keepLead && strokes.length > 1 && Math.max(span(strokes[0], 0), span(strokes[0], 1)) < 0.15) strokes.shift(); // a speck before the first letter is landing jitter
      let x0 = Infinity;
      for (const st of strokes) for (const p of st) x0 = Math.min(x0, p[0]);
      for (const st of strokes) for (const p of st) p[0] -= x0;
      return strokes;
    }
  }

  // ---- bundle decoding (weights.js / styles.js) ----

  function b64ToBytes(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /** Writes Hand.wordSteps generators together (any mix of styles on one model), up to MAX_BATCH at a time: each
   *  step() advances every running word by one model step, in one stepMany. More words can be added between steps.
   *  Each word comes out exactly as word() writes it alone. done(strokes) or fail(error) fires as each one ends. */
  function wordRunner(model) {
    const waiting = [], running = [];
    const resume = (w, value) => {
      let r;
      try { r = w.gen.next(value); } catch (err) { return w.fail(err); }
      if (r.done) w.done(r.value); else { w.req = r.value; running.push(w); }
    };
    return {
      add(gen, done, fail = err => { throw err; }) { waiting.push({ gen, done, fail, req: null }); },
      get size() { return waiting.length + running.length; },
      /** One step of every running word; false once none are left. */
      step() {
        while (running.length < MAX_BATCH && waiting.length) resume(waiting.shift());
        if (!running.length) return false;
        const batch = running.splice(0), out = model.stepMany(batch.map(w => w.req));
        batch.forEach((w, k) => resume(w, out[k]));
        return running.length + waiting.length > 0;
      },
    };
  }
  /** Runs wordSteps generators to the end (wordRunner); returns their strokes in order. */
  function runWords(model, gens, onDone = () => {}) {
    const res = [], runner = wordRunner(model);
    gens.forEach((gen, i) => runner.add(gen, ink => onDone(i, res[i] = ink)));
    while (runner.step());
    return res;
  }

  /** {name, chars, strokesB64} from HW_PRESETS -> {name, chars, strokes: Float32Array}, ready for new Hand(). */
  function decodePreset(p) {
    return { name: p.name, chars: p.chars, strokes: new Float32Array(b64ToBytes(p.strokesB64).buffer) };
  }

  return { ALPHABET, MAX_STROKE_LEN, cleanText, encode, align, denoise, coordsToOffsets,
    simdSupported, loadModel, Model, makeRng, Hand, wordRunner, runWords, MAX_BATCH, b64ToBytes, decodePreset, transformPrimer };
});
