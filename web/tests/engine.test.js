// Engine tests: parity with ../model.py (fixtures.json from tools/make-fixtures.py), kernels, determinism, sanity, speed.
// Run from the project folder: node --test web/tests
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..");
const E = require(path.join(WEB, "engine.js"));
require(path.join(WEB, "weights.js"));
require(path.join(WEB, "styles.js"));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));

const blob = E.b64ToBytes(globalThis.HW_WEIGHTS_B64);
const model = E.loadModel(blob); // SIMD wherever WebAssembly SIMD validates
const plain = E.loadModel(blob, { simd: false });
const presets = globalThis.HW_PRESETS.map(E.decodePreset);
const hands = new Map();
const hand = i => { if (!hands.has(i)) hands.set(i, new E.Hand(model, presets[i])); return hands.get(i); };

function maxDiff(a, b) {
  assert.equal(a.length, b.length, "length mismatch");
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function teacherForced(m, run) {
  const idx = E.encode(run.text), st = m.zeroState(), g = [], phi = [];
  for (let t = 0; t < run.g.length; t++) {
    const r = m.step(run.inputs.slice(3 * t, 3 * t + 3), st, idx);
    g.push(Float32Array.from(r.g));
    phi.push(r.phi);
  }
  return { g, phi };
}

const extent = s => {
  const xs = s.map(p => p[0]), ys = s.map(p => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

test("engine.js and styles.js load as classic scripts in a worker-like global", () => {
  const ctx = vm.createContext({ WebAssembly, atob });
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(WEB, "engine.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(WEB, "styles.js"), "utf8"), ctx);
  assert.equal(ctx.HWEngine.ALPHABET, E.ALPHABET);
  assert.equal(ctx.HW_PRESETS.length, 13);
});

test("cleanText matches clean_text", () => {
  for (const c of FIX.clean) {
    const r = E.cleanText(c.text);
    assert.equal(r.clean, c.clean, JSON.stringify(c.text));
    assert.deepEqual([...r.dropped].sort(), c.dropped, JSON.stringify(c.text));
  }
});

test("align and denoise match model.py", () => {
  const a = FIX.arrays; // fixtures keep 8 significant digits
  assert.ok(maxDiff(E.align(Float64Array.from(a.align_in)), a.align_out) < 1e-6);
  assert.ok(maxDiff(E.denoise(Float64Array.from(a.denoise_in)), a.denoise_out) < 1e-6);
});

test("preparePrimer matches prepare_primer, and a captured style writes", () => {
  for (const p of FIX.primers) {
    const d = maxDiff(E.preparePrimer(p.strokes, p.text), p.offsets);
    assert.ok(d < 1e-5, `max diff ${d}`);
  }
  // Like selfcheck.py: preset 9 replayed as dense screen-space pointer samples becomes a usable style.
  const s9 = presets[9], strokes = [];
  let x = 0, y = 0, cur = [];
  for (let t = 0; t < s9.strokes.length / 3; t++) {
    x += s9.strokes[3 * t] * 4; y -= s9.strokes[3 * t + 1] * 4;
    cur.push([x, y], [x, y], [x, y]);
    if (s9.strokes[3 * t + 2] === 1) { strokes.push(cur); cur = []; }
  }
  if (cur.length) strokes.push(cur);
  const primer = E.preparePrimer(strokes, s9.chars);
  assert.ok(primer.length / 3 <= E.MAX_STROKE_LEN);
  const ink = new E.Hand(model, { strokes: primer, chars: s9.chars }).word("hello", 0);
  assert.ok(Math.max(...ink.flat().map(p => p[0])) > 1.5, "captured style should write a full word");
});

test("teacher-forced MDN params and attention match model.py (both kernels)", t => {
  for (const m of [model, plain]) {
    for (const run of FIX.teacher) {
      const r = teacherForced(m, run);
      let dg = 0, dphi = 0;
      for (let s = 0; s < run.g.length; s++) {
        dg = Math.max(dg, maxDiff(r.g[s], run.g[s]));
        dphi = Math.max(dphi, maxDiff(r.phi[s], run.phi[s]));
      }
      t.diagnostic(`${m.simd ? "simd" : "js"} "${run.text.trim()}": max |dg| ${dg.toExponential(1)}, max |dphi| ${dphi.toExponential(1)}`);
      assert.ok(dg < 1e-3 && dphi < 1e-3);
    }
  }
});

test("state after priming on styles 9 and 0 matches model.py", t => {
  for (const p of FIX.primed) {
    const h = hand(+p.style), g = Float32Array.from(model.mdn(h.state.h3));
    const dg = maxDiff(g, p.g), dh = maxDiff(h.state.h3, p.h3), dk = maxDiff(h.state.kappa, p.kappa);
    t.diagnostic(`style ${p.style} after ${p.steps} steps: max |dg| ${dg.toExponential(1)} (reference f32 vs f64: ${p.g_f32_vs_f64.toExponential(1)}), ` +
      `|dh3| ${dh.toExponential(1)}, |dkappa| ${dk.toExponential(1)}`);
    // Teacher-forced priming is not chaotic: float32 rounding alone moves the reference's own g by g_f32_vs_f64
    // (~1e-5) over the whole primer. Different f32 summation order (BLAS vs our kernel) is noise of the same
    // kind, so 10x that spread, floored at 1e-4, separates rounding from a real porting bug (those show up at >1e-2).
    assert.ok(dg < Math.max(1e-4, 10 * p.g_f32_vs_f64), `g ${dg}`);
    assert.ok(dh < Math.max(1e-4, 10 * p.h3_f32_vs_f64), `h3 ${dh}`);
    assert.ok(dk < 1e-3, `kappa ${dk}`); // kappa sums ~775 increments and reaches ~30, so it carries absolute f32 error
    assert.ok(Math.abs(h.xh - p.xh) < 1e-4 && Math.abs(h.startY - p.start_y) < 1e-4);
  }
});

test("x-height and start of every preset match model.py", () => {
  presets.forEach((p, i) => {
    const ref = FIX.styles[p.name];
    assert.ok(Math.abs(hand(i).xh - ref.xh) < 1e-4 && Math.abs(hand(i).startY - ref.start_y) < 1e-4, `preset ${p.name}`);
  });
});

test("SIMD and pure-JS kernels give identical results", { skip: !model.simd && "WebAssembly SIMD unavailable" }, () => {
  const run = FIX.teacher[0], a = teacherForced(model, run), b = teacherForced(plain, run);
  assert.deepEqual(a.g, b.g);
  assert.deepEqual(a.phi, b.phi);
  const slow = new E.Hand(plain, presets[9]);
  assert.deepEqual(slow.word("quick", 3), hand(9).word("quick", 3));
});

test("word() is deterministic per (word, seed, bias)", () => {
  const h = hand(9);
  assert.deepEqual(h.word("hello", 42), h.word("hello", 42));
  assert.deepEqual(h.word("hello", 42, 0.5), h.word("hello", 42, 0.5));
  assert.notDeepEqual(h.word("hello", 42), h.word("hello", 43));
  assert.notDeepEqual(h.word("hello", 42), h.word("hello", 42, 0.5));
});

test("word() output is sane for all 13 presets and as wide as model.py writes", t => {
  const js = [], py = FIX.words.flatMap(w => w.py_width_per_char).sort((a, b) => a - b);
  FIX.words.forEach(({ style, word }, seed) => {
    const ink = hand(presets.findIndex(p => p.name === style)).word(word, seed), where = `preset ${style} "${word}" seed ${seed}`;
    assert.ok(Array.isArray(ink) && ink.length > 0, `${where}: no strokes`);
    const pts = ink.flat();
    assert.ok(ink.every(s => s.length > 0) && pts.every(q => Number.isFinite(q[0]) && Number.isFinite(q[1])), `${where}: bad points`);
    assert.equal(Math.min(...pts.map(q => q[0])), 0, `${where}: x must start at 0`);
    assert.ok(pts.every(q => q[1] > -4 && q[1] < 5), `${where}: y out of range`);
    assert.ok(ink.length === 1 || extent(ink[0]) >= 0.15, `${where}: leading speck`);
    // Units are Hand's percentile x-height, so letters run wider than a nominal 0.3..1.2: model.py itself writes
    // 0.5..2.8 x-heights per char on these presets (median ~1.3). 0.3 is word()'s own "letters were dropped" floor.
    const w = Math.max(...pts.map(q => q[0])) / word.length;
    js.push(w);
    assert.ok(w >= 0.3 && w <= 3, `${where}: ${w.toFixed(2)} x-heights per char`);
  });
  js.sort((a, b) => a - b);
  const med = a => a[a.length >> 1], q = a => `min ${a[0].toFixed(2)} median ${med(a).toFixed(2)} max ${a.at(-1).toFixed(2)}`;
  t.diagnostic(`width per char over ${js.length} words: js ${q(js)}; model.py ${q(py)}`);
  assert.ok(Math.abs(med(js) / med(py) - 1) < 0.15, "median width drifted from model.py");
});

test("benchmark", t => {
  const stepMs = m => {
    const idx = E.encode("hello world "), st = m.zeroState(), x = new Float32Array([0.5, -0.2, 0]), n = 300;
    for (let i = 0; i < 50; i++) m.step(x, st, idx);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) m.step(x, st, idx);
    return (performance.now() - t0) / n;
  };
  t.diagnostic(`ms per model step: ${model.simd ? `SIMD ${stepMs(model).toFixed(2)}, ` : ""}pure JS ${stepMs(plain).toFixed(2)}`);
  const h = hand(9), words = ["hello", "quick", "minimum", "Tuesday,", "the", "plotter"], t0 = performance.now();
  words.forEach((w, i) => h.word(w, i));
  t.diagnostic(`seconds per word (${model.simd ? "SIMD" : "pure JS"}, ${words.length} words): ${((performance.now() - t0) / 1000 / words.length).toFixed(2)}`);
});
