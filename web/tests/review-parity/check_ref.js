// Independent parity review: web/engine.js vs model.py reference outputs in ref.json (from gen_ref.py).
// Run: node check_ref.js   Prints every comparison; exits 1 if any exceeds its tolerance.
"use strict";
const fs = require("fs");
const path = require("path");
const WEB = path.join(__dirname, "..", "..");
const E = require(path.join(WEB, "engine.js"));
require(path.join(WEB, "weights.js"));
require(path.join(WEB, "styles.js"));
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "ref.json"), "utf8"));

const blob = E.b64ToBytes(globalThis.HW_WEIGHTS_B64);
const models = { simd: E.loadModel(blob), js: E.loadModel(blob, { simd: false }) };
if (!models.simd.simd) throw new Error("SIMD path not available in this Node");
const presets = globalThis.HW_PRESETS.map(E.decodePreset);
const fails = [];
const maxDiff = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); m = Number.isNaN(d) ? Infinity : Math.max(m, d); }
  return m;
};
function check(label, value, tol) {
  const ok = value <= tol;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${typeof value === "number" ? value.toExponential(2) : value} (tol ${tol})`);
  if (!ok) fails.push(`${label}: ${value} > ${tol}`);
}
function same(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { console.log(`FAIL ${label}: js ${JSON.stringify(a)} vs py ${JSON.stringify(b)}`); fails.push(`${label}: js ${JSON.stringify(a)} py ${JSON.stringify(b)}`); }
  return ok;
}

console.log("== teacher-forced ==");
for (const [kname, m] of Object.entries(models)) {
  for (const run of R.teacher) {
    const idx = E.encode(run.text);
    const st = run.label.startsWith("continuation") ? Object.fromEntries(Object.entries(new E.Hand(m, presets[3]).state).map(([k, v]) => [k, v.slice()])) : m.zeroState();
    let dg = 0, dphi = 0, worstStep = -1;
    for (let t = 0; t < run.g.length; t++) {
      const r = m.step(run.inputs.slice(3 * t, 3 * t + 3), st, idx);
      const d = maxDiff(r.g, run.g[t]);
      if (d > dg) { dg = d; worstStep = t; }
      dphi = Math.max(dphi, maxDiff(r.phi, run.phi[t]));
    }
    let dst = 0;
    for (const k of Object.keys(run.final)) dst = Math.max(dst, maxDiff(st[k], run.final[k]));
    check(`[${kname}] ${run.label} (${run.g.length} steps): max|dg| (worst step ${worstStep})`, dg, 1e-3);
    check(`[${kname}] ${run.label}: max|dphi|`, dphi, 1e-3);
    check(`[${kname}] ${run.label}: max|dstate| at end`, dst, 1e-3);
  }
}

console.log("== priming on every preset ==");
for (const p of R.primed) {
  const preset = presets.find(q => q.name === p.name);
  for (const [kname, m] of Object.entries(models)) {
    if (kname === "js" && !["1", "6", "12"].includes(p.name)) continue; // the slow kernel on a subset
    const h = new E.Hand(m, preset);
    same(`[${kname}] preset ${p.name} prime_text`, h.primeText, p.prime_text);
    check(`[${kname}] preset ${p.name} |dxh|`, Math.abs(h.xh - p.xh), 1e-5);
    check(`[${kname}] preset ${p.name} |dstart_y|`, Math.abs(h.startY - p.start_y), 1e-4);
    const g = Float32Array.from(m.mdn(h.state.h3));
    const tol = Math.max(1e-4, 10 * p.g_f32_vs_f64);
    check(`[${kname}] preset ${p.name} (${p.steps} steps) max|dg| (py f32 vs f64 ${p.g_f32_vs_f64.toExponential(1)})`, maxDiff(g, p.g), tol);
    let dst = 0, worst = "";
    for (const k of Object.keys(p.state)) { const d = maxDiff(h.state[k], p.state[k]); if (d > dst) { dst = d; worst = k; } }
    check(`[${kname}] preset ${p.name} max|dstate| (${worst}; py h3 f32 vs f64 ${p.h3_f32_vs_f64.toExponential(1)}, kappa ${p.kappa_f32_vs_f64.toExponential(1)})`, dst, Math.max(1e-3, 10 * p.kappa_f32_vs_f64));
  }
}

console.log("== sampling math (scripted RNG) ==");
{
  const m = models.simd;
  let dout = 0, kMismatch = 0, penMismatch = 0, pMismatch = 0, dp = 0;
  for (const c of R.sampling) {
    let seenP = null, k = null, penUsed = false, zi = 0;
    const stub = {
      choice(p) {
        seenP = Float64Array.from(p);
        let total = 0, acc = 0;
        for (const v of p) total += v;
        const target = c.u * total;
        for (let i = 0; i < p.length; i++) { acc += p[i]; if (target < acc) return (k = i); }
        for (let i = p.length - 1; i >= 0; i--) if (p[i] > 0) return (k = i);
        throw new Error("no positive weight");
      },
      normal: () => c.z[zi++],
      random: () => { penUsed = true; return c.upen; },
    };
    const out = m.sample(Float32Array.from(c.g), c.bias, stub);
    const tot = seenP.reduce((a, b) => a + b, 0), pn = Array.from(seenP, v => v / tot);
    const zeroJs = pn.map(v => v === 0), zeroPy = c.p.map(v => v === 0);
    if (JSON.stringify(zeroJs) !== JSON.stringify(zeroPy)) { pMismatch++; console.log(`  cut-off pattern differs: ${c.label}`); }
    dp = Math.max(dp, maxDiff(pn, c.p));
    if (k !== c.k) { kMismatch++; console.log(`  component differs: ${c.label} js ${k} py ${c.k}`); continue; }
    if (penUsed !== c.pen_used || out[2] !== c.out[2]) { penMismatch++; console.log(`  pen differs: ${c.label} js ${out[2]}/${penUsed} py ${c.out[2]}/${c.pen_used}`); }
    const d = Math.max(Math.abs(out[0] - c.out[0]), Math.abs(out[1] - c.out[1]));
    if (d > 1e-5) console.log(`  dx/dy differ by ${d.toExponential(2)}: ${c.label} js [${out[0]}, ${out[1]}] py [${c.out[0]}, ${c.out[1]}]`);
    dout = Math.max(dout, d);
  }
  console.log(`  ${R.sampling.length} cases`);
  check("sampling: cases with a different cut-off pattern", pMismatch, 0);
  check("sampling: max |dp| (normalised mixture weights)", dp, 1e-6);
  check("sampling: cases choosing a different component", kMismatch, 0);
  check("sampling: cases with a different pen bit", penMismatch, 0);
  check("sampling: max |d(dx,dy)|", dout, 1e-5);
}

console.log("== preprocessing ==");
{
  let da = 0, dd = 0, dc = 0;
  for (const c of R.pre.align) {
    const d = maxDiff(E.align(Float64Array.from(c.in)), c.out);
    if (d > 1e-9 * Math.max(1, ...c.in.map(Math.abs))) console.log(`  align ${c.label}: max diff ${d.toExponential(2)}`);
    da = Math.max(da, d / Math.max(1, ...c.in.map(Math.abs)));
  }
  check("align: max diff relative to coordinate scale", da, 1e-9);
  for (const c of R.pre.denoise) dd = Math.max(dd, maxDiff(E.denoise(Float64Array.from(c.in)), c.out));
  check(`denoise on ${R.pre.denoise.length} arrays of length 1..10: max diff`, dd, 1e-12);
  for (const c of R.pre.c2o) dc = Math.max(dc, maxDiff(E.coordsToOffsets(Float64Array.from(c.in)), c.out));
  check("coordsToOffsets: max diff", dc, 1e-12);
  for (const c of R.pre.primer) {
    let o;
    try { o = E.preparePrimer(c.strokes, c.text); } catch (e) { check(`preparePrimer ${c.label}: threw ${e.message}`, Infinity, 0); continue; }
    same(`preparePrimer ${c.label}: rows`, o.length / 3, c.rows);
    const eosJs = [], eosPy = [];
    for (let i = 2; i < o.length; i += 3) eosJs.push(o[i]);
    for (let i = 2; i < c.out.length; i += 3) eosPy.push(c.out[i]);
    same(`preparePrimer ${c.label}: eos pattern`, eosJs, eosPy);
    check(`preparePrimer ${c.label}: max diff`, maxDiff(o, c.out), 1e-5);
  }
  const ch = R.captured_hand;
  const h = new E.Hand(models.simd, { strokes: E.preparePrimer(ch.strokes, ch.text), chars: ch.text });
  check("captured primer -> Hand: |dxh|", Math.abs(h.xh - ch.xh), 1e-4);
  check("captured primer -> Hand: |dstart_y|", Math.abs(h.startY - ch.start_y), 1e-3);
  check("captured primer -> Hand: max|dg|", maxDiff(Float32Array.from(models.simd.mdn(h.state.h3)), ch.g), 1e-3);
}

console.log("== cleanText ==");
{
  let bad = 0;
  const sortJs = a => [...a].sort();
  for (const [cp, clean, dropped] of R.clean.single) {
    const r = E.cleanText(String.fromCodePoint(cp));
    if (r.clean !== clean || JSON.stringify(sortJs(r.dropped)) !== JSON.stringify(sortJs(dropped))) {
      if (bad++ < 20) console.log(`  U+${cp.toString(16).toUpperCase()}: js ${JSON.stringify([r.clean, sortJs(r.dropped)])} py ${JSON.stringify([clean, dropped])}`);
    }
  }
  for (const [s, clean, dropped] of R.clean.multi) {
    const r = E.cleanText(s);
    if (r.clean !== clean || JSON.stringify(sortJs(r.dropped)) !== JSON.stringify(sortJs(dropped))) {
      bad++;
      console.log(`  ${JSON.stringify(s)}: js ${JSON.stringify([r.clean, sortJs(r.dropped)])} py ${JSON.stringify([clean, dropped])}`);
    }
  }
  check(`cleanText: mismatches over ${R.clean.single.length} single code points + ${R.clean.multi.length} strings`, bad, 0);
}

console.log("== Hand._finish ==");
{
  const hands = { 9: new E.Hand(models.simd, presets[9]), 4: new E.Hand(models.simd, presets[4]) };
  for (const c of R.finish) {
    const res = hands[c.style]._finish(Float64Array.from(c.traj));
    if (!same(`_finish style ${c.style} ${c.label}: stroke lengths`, res.map(s => s.length), c.lens)) continue;
    let d = 0;
    res.forEach((s, i) => { d = Math.max(d, maxDiff(s.flat(), c.out[i])); });
    check(`_finish style ${c.style} ${c.label}: max diff`, d, 1e-9);
  }
}

console.log(fails.length ? `\n${fails.length} FAILURES:\n${fails.join("\n")}` : "\nall reference checks passed");
process.exitCode = fails.length ? 1 : 0;
