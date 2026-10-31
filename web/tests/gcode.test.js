// Safety tests for gcode.js: every unsafe setting is refused, and every file that IS produced is checked by an
// independent simulator that knows only the physical facts below (not gcode.js's maths).
const test = require("node:test");
const assert = require("node:assert");
const G = require("../gcode.js");

const { simulate, levelOf } = require("./sim.js");

// Fake handwriting: plausible word ink without the neural net, so thousands of cases run quickly.
function fakeInk(rng) {
  return ({ word }) => {
    const out = [], w = 0.6 * word.length;
    for (let k = 0; k < 1 + Math.floor(rng.random() * 4); k++) {
      const s = [], n = 2 + Math.floor(rng.random() * 12);
      for (let j = 0; j < n; j++) s.push([rng.random() * w, -0.6 + rng.random() * 2.4]);
      out.push(s);
    }
    return out;
  };
}
const mulberry = seed => { let a = seed | 0; const random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { random, normal: () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()) }; };

function run(settings, text, seed, edit) {
  const cfg = G.resolve(settings);
  const rng = mulberry(seed);
  const paras = G.words(text, seed, G.resolve(settings).writing.code);
  if (edit) edit(paras.flat(), rng); // word changes made in the preview: size, move
  const lines = G.layout(paras, fakeInk(rng), cfg, rng);
  const passes = G.planPasses(lines, cfg);
  return { cfg, gcode: G.toGcode(passes, cfg, G.describe(cfg, seed)), passes };
}
const withSet = (patch) => {
  const s = structuredClone(G.DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(patch)) { const [sec, key] = k.split("."); s[sec][key] = v; }
  return s;
};

test("defaults produce a file the simulator accepts", () => {
  const { gcode, cfg } = run(G.DEFAULT_SETTINGS, "Dear friend,\n\nThis was written by my printer.", 1);
  assert.ok(simulate(gcode, cfg) > 50);
  assert.match(gcode, /take the pen out/);
});

test("every unsafe or garbled setting is refused", () => {
  const bad = {
    "printer.z_draw": [0, -5, 0.3, false, -Infinity, NaN, "10", null],
    "printer.z_lift": [10.004, 10.5],
    "printer.draw_feed": [0, -1500, Infinity], "printer.paper_pause_s": [0, -30, 1e9],
    "printer.offset_x": [Infinity, 500], "printer.settle_ms": [-1],
    "paper.orientation": ["sideways"], "paper.margin": [-5, 60], "paper.size": ["A3", "__proto__", "toString"],
    "printer.model": ["Prusa", "constructor"],
    "writing.line_spacing": [0, 2], "writing.x_height": [0, -1, 25], "writing.wobble": [-1, 3], "writing.bias": [5],
    "printer.pen_pause_s": ["30\nG28"],
  };
  for (const [key, values] of Object.entries(bad))
    for (const v of values) assert.throws(() => G.resolve(withSet({ [key]: v })), G.WriteError, `${key} = ${String(v)}`);
  // Z ceiling per printer
  assert.throws(() => G.resolve(withSet({ "printer.model": "Bambu Lab A1 mini", "printer.z_draw": 170, "printer.z_lift": 172 })), G.WriteError);
});

test("resolve never mutates the caller's settings", () => {
  const s = withSet({ "paper.size": "A4", "paper.orientation": "landscape" });
  const before = JSON.stringify(s);
  G.resolve(s);
  assert.strictEqual(JSON.stringify(s), before);
});

test("NaN in strokes fails closed", () => {
  const cfg = G.resolve(G.DEFAULT_SETTINGS);
  assert.throws(() => G.checkBounds([[[10, 10], [NaN, 5], [9999, 9999]]], cfg), G.WriteError);
  assert.throws(() => G.planPasses([[[[10, 10], [NaN, 20]]]], cfg), G.WriteError);
});

test("P1/X1 filament-cutter corner is refused", () => {
  const cfg = G.resolve(withSet({ "printer.model": "Bambu Lab P1P / P1S", "printer.offset_x": 0, "printer.offset_y": 0, "paper.size": "A6", "paper.x": 0, "paper.y": 0 }));
  const corner = [{ shift: 0, strokes: [[[5, cfg.paper.height - 5], [6, cfg.paper.height - 5]]], hover: null }];
  assert.throws(() => G.toGcode(corner, cfg, ["t"]), G.WriteError);
});

test("strokes made for the A1 are refused on the smaller A1 mini", () => {
  const { passes } = run(withSet({ "paper.x": 54, "paper.y": 23 }), "Hello there, a line of text that reaches far to the right side", 3);
  const mini = G.resolve(withSet({ "printer.model": "Bambu Lab A1 mini", "paper.x": 54, "paper.y": 23 }));
  assert.throws(() => passes.forEach(ps => G.checkBounds(ps.strokes, mini)), G.WriteError);
});

test("A4 on the A1 is split into passes with a safe slide sequence", () => {
  let out; // the fewest lines that no longer fit over the plate in one go
  for (let n = 20; n < 40 && !(out && out.passes.length === 2); n++)
    out = run(withSet({ "paper.size": "A4", "paper.x": 23, "paper.y": -40, "paper.slide": true }), Array(n).fill("line of words").join("\n"), 4);
  const { gcode, cfg, passes } = out;
  assert.strictEqual(passes.length, 2);
  simulate(gcode, cfg);
  const i = gcode.indexOf("; PASS 2");
  const after = gcode.slice(i).split("\n").slice(1, 30);
  assert.match(after[0], new RegExp(`^G1 Z${Math.max(cfg.printer.z_lift, cfg.printer.z_draw + G.SLIDE_HOVER).toFixed(2)}`));
  assert.match(after[1], /^G0 X/);
  const wait = after.indexOf("G4 S45");
  assert.ok(wait > 2 && after.slice(2, wait).includes("M1006 S1"), "pause tune, then the 45 s wait");
  assert.ok(after.slice(wait).includes("M1006 W") && after.slice(wait).some(l => /^G1 Z/.test(l)), "resume tune, then pen-up height");
});

test("printer sounds: Bambu's own start and finish tunes, ours for pauses; none elsewhere or when switched off", () => {
  const { gcode, cfg } = run(G.DEFAULT_SETTINGS, "Hello there", 1);
  assert.strictEqual(cfg.printer.model, "Bambu Lab A1");
  simulate(gcode, cfg);
  assert.strictEqual((gcode.match(/^M1006 S1$/gm) || []).length, 6); // start, (pause + resume) x 2, finish
  // lines exactly as in Bambu Studio's A1 start and end G-code
  assert.match(gcode, /^M1006 S1\nM1006 A0 B10 L100 C37 D10 M60 E37 F10 N60\nM1006 A0 B10 L100 C41 D10 M60 E41 F10 N60$/m, "Bambu's start tune");
  assert.match(gcode, /^M1006 A0 B20 L100 C0 D20 M60 E0 F20 N80\nM1006 A0 B20 L100 C37 D20 M30 E37 F20 N60\nM1006 W$/m, "Bambu's finish tune, to its last note");
  assert.match(gcode, /^M1006 A76 B14 L100 C76 D14 M100 E76 F14 N100$/m, "pause tune: every channel at full volume");
  for (const [model, tunes] of Object.entries(G.BAMBU_TUNES)) {
    assert.ok(tunes.start.length > 4 && tunes.finish.length > 4 && [...tunes.start, ...tunes.finish].every(s => s.length === 9), model);
    const r = run(withSet({ "printer.model": model }), "Hello there", 1);
    simulate(r.gcode, r.cfg);
  }
  for (const model of ["Bambu Lab X1 Carbon / X1E", "Bambu Lab P1P / P1S"])
    assert.ok(!/M1006/.test(run(withSet({ "printer.model": model }), "Hello there", 1).gcode), model);
  assert.ok(!/M1006/.test(run(withSet({ "printer.sounds": false }), "Hello there", 1).gcode));
  assert.throws(() => G.resolve(withSet({ "printer.sounds": "yes" })), G.WriteError);
  // after the pen is clamped, the resume tune plays only once the pen is lifted off the paper
  const lines = gcode.split("\n"), clamp = lines.indexOf(`G4 S${cfg.printer.pen_pause_s}`, lines.indexOf("; attach the pen: slide it down until it touches the paper, then clamp it"));
  assert.match(lines[clamp + 1], /^G1 Z12\.00/);
});

test("text edge cases", () => {
  assert.throws(() => run(G.DEFAULT_SETTINGS, "x".repeat(26), 1), G.WriteError);
  assert.throws(() => run(G.DEFAULT_SETTINGS, "", 1), G.WriteError);
  assert.throws(() => run(G.DEFAULT_SETTINGS, "\n\n  \n", 1), G.WriteError);
  assert.throws(() => run(G.DEFAULT_SETTINGS, Array(400).fill("word").join(" "), 1), /doesn't fit/);
  // header text can never add a command line
  const cfg = G.resolve(G.DEFAULT_SETTINGS);
  const g = G.toGcode([{ shift: 0, strokes: [[[20, 20], [21, 21]]], hover: null }], cfg, ["x\nG28\r\nG1 Z0"]);
  assert.ok(!/^G1 Z0/m.test(g) && g.split("\n")[0].startsWith(";"));
});

test("fuzz: thousands of random setups -> every produced file passes the independent simulator", () => {
  const rng = mulberry(12345), pick = a => a[Math.floor(rng.random() * a.length)], U = (a, b) => a + rng.random() * (b - a);
  const models = Object.keys(G.PRINTERS), papers = Object.keys(G.PAPERS);
  const vocab = "the quick brown fox jumps over a lazy dog and writes letters home to friends each day HELLO, NASA OK I _the fox_ *dog day* _*both*_ 2024 3.14 10:30 85, x x2 (12)".split(" ");
  // code: drawn symbols, ALL-CAPS names with drawn X and Z, and (in code mode) indents and names longer than a word
  const code = "#include <stdio.h> int main() { } a[i] = b * c / d; x_y && || != >= <= += -> @d $v ~a ^b \\n %d MAX_SIZE ZERO {x} [0]".split(" ");
  const tally = { ok: 0, refused: 0, edited: 0, code: 0, levelled: 0, pressed: 0 };
  for (let c = 0; c < 4000; c++) {
    const s = structuredClone(G.DEFAULT_SETTINGS);
    s.printer.model = rng.random() < 0.25 ? pick([...G.LEVEL_PRINTERS.keys()]) : pick(models); // levelling runs on these
    if (s.printer.model === "Custom") Object.assign(s.printer, { bed_x: U(80, 350), bed_y: U(80, 350), bed_z: U(60, 300) });
    s.paper.size = pick(papers);
    if (s.paper.size === "Custom") Object.assign(s.paper, { width: U(40, 400), height: U(40, 500) });
    s.paper.orientation = pick(["portrait", "landscape"]);
    Object.assign(s.paper, { x: Math.round(U(-120, 220)), y: Math.round(U(-250, 220)), margin: U(0, 40), slide: rng.random() < 0.5 });
    Object.assign(s.printer, { offset_x: U(-40, 40), offset_y: U(-40, 40), z_draw: U(2, 40), dry_run: rng.random() < 0.3 });
    if (rng.random() < 0.4) Object.assign(s.paper, { ruling: U(3, 14), first_line: U(0, 80), margin_line: rng.random() < 0.5 ? U(0, 60) : 0 });
    s.printer.z_lift = s.printer.z_draw + U(0.9, 12);
    if (rng.random() < 0.4) s.printer.press_bottom = U(0, 2); // pressing harder toward the bottom (refused if too low)
    s.printer.level = rng.random() < 0.7; // bed levelling first (where the printer's commands are known)
    Object.assign(s.writing, { x_height: U(1.5, 8), wobble: U(0, 2), word_spacing: U(0.3, 3), indent: U(0, 1.5) });
    s.writing.line_spacing = s.writing.x_height * U(1.4, 4);
    s.writing.code = rng.random() < 0.35;
    const words = s.writing.code ? [...vocab, ...code, ...code, 'System.out.println("Hello,World!");'] : rng.random() < 0.5 ? vocab : [...vocab, ...code];
    const text = Array.from({ length: 1 + Math.floor(rng.random() * 6) }, () => " ".repeat(s.writing.code || rng.random() < 0.3 ? Math.floor(rng.random() * 17) : 0) +
      Array.from({ length: Math.floor(rng.random() * 25) }, () => pick(words)).join(" ")).join("\n");
    // words edited in the preview: some bigger or smaller, some moved anywhere (on or off the page)
    const edit = rng.random() < 0.4 ? (ws, r) => { for (const w of ws) if (r.random() < 0.3) {
      if (r.random() < 0.5) w.size = 0.3 + r.random() * 3.7;
      if (r.random() < 0.5) { w.dx = (r.random() - 0.5) * 60; w.dy = (r.random() - 0.5) * 60; }
    } } : null;
    let out;
    try { out = run(s, text, c, edit); } catch (e) {
      if (!(e instanceof G.WriteError)) throw new Error(`case ${c} crashed: ${e.stack}\n${JSON.stringify(s)}`);
      tally.refused++;
      continue;
    }
    const cfg = out.cfg;
    try { simulate(out.gcode, { ...s, printer: cfg.printer, paper: cfg.paper }); }
    catch (e) { throw new Error(`case ${c} UNSAFE: ${e.message}\n${JSON.stringify(s)}\n${JSON.stringify(text)}`); }
    tally.ok++;
    if (edit) tally.edited++;
    if (s.writing.code) tally.code++;
    if (/^(G29|M420|M555|BED_MESH_)/m.test(out.gcode)) tally.levelled++;
    if (s.printer.press_bottom > 0) tally.pressed++;
  }
  test.diagnostic?.(`fuzz: ${tally.ok} files simulated safely, ${tally.refused} setups refused`);
  console.log(`fuzz: ${tally.ok} files simulated safely (${tally.edited} with edited words, ${tally.code} code, ${tally.levelled} levelled, ${tally.pressed} pressing harder), ${tally.refused} setups refused`);
  assert.ok(tally.ok > 500 && tally.edited > 100 && tally.code > 150 && tally.levelled > 30 && tally.pressed > 100, `too few accepted cases to mean anything: ${JSON.stringify(tally)}`);
});

test("page capacity estimate: plausible, grows with paper, counts paragraph lines", () => {
  const a5 = G.capacity(G.resolve(G.DEFAULT_SETTINGS), 0.75), a4 = G.capacity(G.resolve(withSet({ "paper.size": "A4" })), 0.75);
  assert.ok(a5.words > 80 && a5.words < 200, JSON.stringify(a5)); // real layouts fit ~130 words on A5 at default size
  assert.ok(a4.words > a5.words && a4.lines > a5.lines);
  const big = G.capacity(G.resolve(withSet({ "writing.x_height": 5, "writing.line_spacing": 12 })), 0.75);
  assert.ok(big.words < a5.words / 2);
  const paras = G.words("one\n\ntwo three\nfour", 1); // 4 paragraphs incl. an empty one: 4 lines
  assert.strictEqual(G.capacity(G.resolve(G.DEFAULT_SETTINGS), 0.75, paras).needed, 4);
});

test("ALL-CAPS words are written letter by letter; other words stay whole", () => {
  const [[hello, the, i, ok, num, usa]] = G.words("HELLO, The I OK 2024 U.S.A.", 3);
  assert.deepStrictEqual(hello.parts.map(p => p.word), ["H", "E", "L", "L", "O,"]);
  assert.ok(!the.parts && !i.parts);
  assert.deepStrictEqual(num.parts.map(p => p.word), ["2", "0", "2", "4"]); // digits one at a time too, drawn
  assert.ok(num.parts.every(p => p.glyph));
  const [[th, time, pi, one]] = G.words("4th 7:30 3.14 5", 1);
  assert.deepStrictEqual(th.parts.map(p => p.word), ["4", "th"]);
  assert.deepStrictEqual(time.parts.map(p => p.word), ["7", ":", "3", "0"]);
  assert.deepStrictEqual(pi.parts.map(p => p.word), ["3", ".", "1", "4"]);
  assert.ok(time.parts.every(p => p.glyph) && pi.parts.every(p => p.glyph) && !th.parts[1].glyph); // a point between digits is drawn too
  assert.ok(!one.parts && one.glyph); // a single digit is already one piece
  const [[end, hi]] = G.words("end. Hi,", 1);
  assert.ok(!end.parts && !end.glyph && !hi.parts && !hi.glyph); // a point after a letter stays with the word
  assert.deepStrictEqual(ok.parts.map(p => p.word), ["O", "K"]);
  assert.deepStrictEqual(usa.parts.map(p => p.word), ["U.", "S.", "A."]);
  assert.strictEqual(new Set(hello.parts.map(p => p.seed)).size, 5); // each letter its own variation
  // letters are placed left to right, one after another, as one word
  const ink = ({ word }) => [[[0, 0], [0.7, 1]]].concat(word.length > 1 ? [[[0.9, 0], [1, 0.2]]] : []);
  const cfg = G.resolve(withSet({ "writing.wobble": 0 }));
  const [line] = G.layout(G.words("OK", 1), ink, cfg, mulberry(1));
  const starts = line.map(s => s[0][0]);
  assert.ok(starts[1] > starts[0] + 0.7 * cfg.writing.x_height, JSON.stringify(starts));
});

test("code: symbols the model can't write are drawn pieces; long names are cut; ALL-CAPS and digits as before", () => {
  assert.deepStrictEqual(G.pieces("#include<stdio.h>", true), ["#", "include", "<", "stdio.h", ">"]);
  assert.deepStrictEqual(G.pieces("MAX_SIZE", true), ["M", "A", "X", "_", "S", "I", "Z", "E"]);
  assert.deepStrictEqual(G.pieces("x+=10;", false), ["x", "+", "=", "1", "0", ";"]);
  const long = 'System.out.println("Hello,World!");', cut = G.pieces(long, true);
  assert.ok(cut.every(p => p.length <= G.MAX_WORD) && cut.join("") === long && cut.length === 2, JSON.stringify(cut));
  assert.deepStrictEqual(G.pieces(long, false), [long]); // outside code a word that long stays a word (and is refused)
  // in code _ and * are written; outside code they still mark underline and the second pen
  const [[xy, star]] = G.words("x_y *p", 1, true);
  assert.deepStrictEqual(xy.parts.map(p => [p.word, !!p.glyph]), [["x", true], ["_", true], ["y", false]]); // an x on its own is drawn too
  assert.deepStrictEqual(star.parts.map(p => p.word), ["*", "p"]);
  assert.ok(!xy.underline && !star.pen);
  const [[fox]] = G.words("_fox_", 1);
  assert.ok(fox.underline && fox.word === "fox");
  // in plain text too, a * or _ standing alone is the symbol (a mark always touches a word): "5 * 3" needs no second pen
  const [plain] = G.words("5 * 3 = 15 a _ b ** *pen two* _under_", 1);
  assert.deepStrictEqual(plain.map(w => w.word), ["5", "*", "3", "=", "15", "a", "_", "b", "**", "pen", "two", "under"]);
  assert.deepStrictEqual(plain.filter(w => w.pen).map(w => w.word), ["pen", "two"]);
  assert.deepStrictEqual(plain.filter(w => w.underline).map(w => w.word), ["under"]);
  assert.ok(plain[1].glyph && plain[6].glyph && plain[8].parts.every(p => p.glyph));
  assert.deepStrictEqual(G.pieces("QUIT", false), ["Q", "U", "I", "T"]); // Q is drawn too, the rest letter by letter
  const [[brace, eq]] = G.words("{ ==", 1, true);
  assert.ok(brace.glyph && !brace.parts && eq.parts.every(p => p.glyph)); // nothing here for the model to write
  assert.deepStrictEqual(G.words("a\n    b\n\n  c", 1, true).map(p => p.indent), [0, 4, 0, 2]);
  assert.deepStrictEqual(G.words("a\n    b", 1).map(p => [p.indent, p.runOn]), [[undefined, undefined], [4, undefined]]); // typed text: the first line only
  assert.deepStrictEqual(G.words("\tb", 1)[0].indent, 1); // (the app makes tabs 4 spaces)
});

test("drawn symbols: pen paths in the hand's height and slant, a little different each time, exact with no wobble", () => {
  const hand = { slant: 0.1, asc: 2.1 };
  for (const ch of G.GLYPH_CHARS + ".,:;") {
    const g = G.glyph(ch, 7, hand), pts = g.flat(), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    assert.ok(g.length >= 1 && g.every(st => st.length >= 2) && pts.every(p => p.every(Number.isFinite)), ch);
    assert.ok(Math.abs(Math.min(...xs)) < 1e-9 && Math.max(...xs) < 1.8 && Math.min(...ys) > -1 && Math.max(...ys) < 2.6, `${ch}: ${[Math.max(...xs), Math.min(...ys), Math.max(...ys)]}`);
    assert.deepStrictEqual(G.glyph(ch, 7, hand), g); // the same symbol for the same seed
    assert.notDeepStrictEqual(G.glyph(ch, 8, hand), g); // but no two written alike
    assert.deepStrictEqual(G.glyph(ch, 7, hand, 0), G.glyph(ch, 8, hand, 0)); // wobble 0: as designed
  }
  const bar = h => { const [st] = G.glyph("|", 1, h, 0); return { top: st[0], bottom: st[st.length - 1] }; };
  const tall = bar({ slant: 0, asc: 2.5 }), short = bar({ slant: 0, asc: 1.8 }), lean = bar({ slant: 0.3, asc: 2.1 });
  assert.ok(Math.abs(tall.top[1] - (1 + 0.9 * 1.5)) < 1e-9 && Math.abs(short.top[1] - (1 + 0.9 * 0.8)) < 1e-9); // as tall as the hand's tall letters
  const designed = 0.02 / 2.45; // "|" itself leans a hair: 0.02 over its height
  assert.ok(Math.abs((lean.top[0] - lean.bottom[0]) / (lean.top[1] - lean.bottom[1]) - 0.3 - designed) < 0.02); // and leans like the hand
  // the hand is measured on the page's written words: their lean, and how tall their tall letters are
  const leaning = () => [[[0, 0], [0.2, 1], [0.44, 2.2]], [[0.5, 0], [0.7, 1]]];
  const h = G.handOf(G.words("hello world the tall bold", 1), leaning);
  assert.ok(Math.abs(h.slant - 0.2) < 1e-9 && Math.abs(h.asc - 2.2) < 1e-9, JSON.stringify(h));
  assert.deepStrictEqual(G.handOf([[]], leaning), { slant: 0.1, asc: 2.1 }); // nothing written: a typical hand
});

test("code keeps every line's indent, and a line too long for the paper runs on one step further in", () => {
  const cfg = G.resolve(withSet({ "writing.wobble": 0, "writing.code": true })), xh = cfg.writing.x_height;
  const ink = ({ word }) => [[[0, 0], [0.6 * word.length, 1]]];
  const left = l => Math.min(...l.flat().map(p => p[0]));
  const lines = G.layout(G.words("int main() {\n    return 0;\n}\n        " + Array(30).fill("x").join(" "), 1, true), ink, cfg, mulberry(1));
  assert.ok(Math.abs(left(lines[1]) - left(lines[0]) - 4 * 0.55 * xh) < 1e-6, `${left(lines[0])} ${left(lines[1])}`);
  assert.ok(Math.abs(left(lines[2]) - left(lines[0])) < 1e-6);
  assert.ok(lines.length >= 5 && Math.abs(left(lines[3]) - left(lines[0]) - 8 * 0.55 * xh) < 1e-6);
  assert.ok(Math.abs(left(lines[4]) - left(lines[0]) - 12 * 0.55 * xh) < 1e-6); // the run-on line
  const right = G.writingArea(cfg)[2];
  assert.ok(lines.every(l => l.every(s => s.every(p => p[0] <= right + 1e-6)))); // and nothing past the right border
  // typed text (code off) keeps a line's indent too, but its run-on lines go back to the margin
  const plain = G.resolve(withSet({ "writing.wobble": 0 }));
  const pl = G.layout(G.words("int main() {\n    " + Array(30).fill("x").join(" "), 1), ink, plain, mulberry(1));
  assert.ok(pl.length >= 3 && Math.abs(left(pl[1]) - left(pl[0]) - 4 * 0.55 * xh) < 1e-6 && Math.abs(left(pl[2]) - left(pl[0])) < 1e-6,
    pl.map(left).join(" "));
  // how far is a setting: twice as far, or not at all
  for (const indent of [1.1, 0]) {
    const l2 = G.layout(G.words("ab\n    cd", 1, true), ink, G.resolve(withSet({ "writing.wobble": 0, "writing.code": true, "writing.indent": indent })), mulberry(1));
    assert.ok(Math.abs(left(l2[1]) - left(l2[0]) - 4 * indent * xh) < 1e-6, `${indent}: ${l2.map(left).join(" ")}`);
  }
  assert.throws(() => G.resolve(withSet({ "writing.indent": 2 })), /indent/);
});

test("long text continues on further pages: nothing lost or doubled, every page safe", () => {
  const oneStroke = () => [[[0, 0], [0.5, 1], [2.4, 0.2]]]; // exactly one stroke per word
  for (const [size, wobble] of [["A5", 1], ["A6", 2], ["A4", 0]]) {
    const cfg = G.resolve(withSet({ "paper.size": size, "writing.wobble": wobble, "paper.x": size === "A4" ? 23 : 54, "paper.y": size === "A4" ? -20 : 23 }));
    const text = Array.from({ length: 12 }, (_, p) => Array.from({ length: 60 }, (_, i) => "word" + "abcdefghij"[p % 10] + "klmnopqrst"[i % 10]).join(" ") /* letters only: one piece per word */).join("\n\n");
    const paras = G.words(text, 2), total = paras.flat().length;
    const pages = G.layoutPages(paras, oneStroke, cfg, mulberry(3));
    assert.ok(pages.length > 1, `${size}: ${pages.length} page(s)`);
    assert.strictEqual(pages.reduce((n, lines) => n + lines.reduce((m, l) => m + l.length, 0), 0), total, `${size}: words placed`);
    const [l, t, r, b] = G.writingArea(cfg);
    for (const lines of pages) {
      const [x0, y0, x1, y1] = G.extent(lines.flat());
      assert.ok(x0 >= l - 1e-6 && x1 <= r + 1e-6 && y0 >= t - 1e-6 && y1 <= b + 1e-6, `${size}: page inside its area`);
      simulate(G.toGcode(G.planPasses(lines, cfg), cfg, ["t"]), cfg);
    }
  }
  // the single-page call still refuses, and the page cap holds
  const cfg = G.resolve(G.DEFAULT_SETTINGS), big = G.words(Array(3000).fill("word").join(" "), 1);
  assert.throws(() => G.layout(big, oneStroke, cfg, mulberry(1)), /doesn't fit/);
  assert.throws(() => G.layoutPages(big, oneStroke, cfg, mulberry(1), 3), /more than 3 pages/);
});

test("separate side and top/bottom borders", () => {
  const [l, t, r, b] = G.writingArea(G.resolve(withSet({ "paper.margin": 10, "paper.margin_y": 40 })));
  const p = G.resolve(G.DEFAULT_SETTINGS).paper;
  assert.ok(Math.abs(l - 10) < 1e-9 && Math.abs(r - (p.width - 10)) < 1e-9, "sides");
  assert.ok(Math.abs(t - 40) < 1e-9 && Math.abs(b - (p.height - 40)) < 1e-9, "top and bottom");
  const more = G.capacity(G.resolve(withSet({ "paper.margin_y": 50 })), 0.75), base = G.capacity(G.resolve(G.DEFAULT_SETTINGS), 0.75);
  assert.ok(more.lines < base.lines && more.perLine === base.perLine);
  assert.throws(() => G.resolve(withSet({ "paper.margin_y": 100 })), G.WriteError); // above the 80 mm limit
  assert.throws(() => G.resolve(withSet({ "paper.size": "A6", "paper.margin_y": 70 })), /too big/); // 148 mm tall A6
  // older saved settings without margin_y get the default
  const old = withSet({}); delete old.paper.margin_y;
  assert.strictEqual(G.resolve(old).paper.margin_y, 15);
});

test("lines never write into the line above, even at full wobble", () => {
  // every word has tall letters and long tails (like "lg"), the worst case for touching lines
  const tall = ({ word }) => Array.from({ length: word.length }, (_, j) => [[0.6 * j, -1.1], [0.6 * j + 0.2, 2.2]]);
  const text = Array.from({ length: 8 }, () => Array.from({ length: 40 }, (_, i) => "lgylgy".slice(0, 2 + i % 5)).join(" ")).join("\n");
  for (const [wobble, spacing, seed] of [[2, 8, 1], [2, 8, 2], [1, 8, 3], [2, 6, 4], [0, 4.2, 5]]) {
    const cfg = G.resolve(withSet({ "writing.wobble": wobble, "writing.line_spacing": spacing }));
    const pages = G.layoutPages(G.words(text, seed), tall, cfg, mulberry(seed));
    let closest = Infinity;
    for (const lines of pages)
      for (let i = 1; i < lines.length; i++) for (let j = 0; j < i; j++)
        for (const s of lines[i]) for (const [px, py] of s) for (const u of lines[j]) for (const [qx, qy] of u)
          if (Math.abs(px - qx) <= 0.5) closest = Math.min(closest, py - qy);
    assert.ok(closest >= 0.8 - 1e-9, `wobble ${wobble}, spacing ${spacing}: lines ${closest.toFixed(2)} mm apart`);
  }
});

test("defaults: the Plotter holder's offset, and the paper where placePaper puts it", () => {
  const s = G.DEFAULT_SETTINGS;
  assert.deepStrictEqual(G.offsetFromTest(s, 106, 85), { offset_x: s.printer.offset_x, offset_y: s.printer.offset_y });
  assert.deepStrictEqual(G.placePaper(G.resolve(s)), { x: s.paper.x, y: s.paper.y });
});

test("pen offset test: safe on every printer, and measuring it gives the offset back", () => {
  for (const model of Object.keys(G.PRINTERS).filter(m => G.PRINTERS[m])) {
    const s = withSet({ "printer.model": model, "printer.offset_x": 7, "printer.offset_y": -33 }); // the old offset must not matter
    // the plate may reach past where the nozzle may go (pr.plate): the paper goes into the plate's own corner
    const pr = G.resolve(s).printer, gcode = G.offsetTest(s), bedY = pr.bed_y, [gl, , , gb] = pr.plate, [X0, Y0] = pr.origin;
    const cfg = G.resolve({ ...s, printer: { ...s.printer, offset_x: 0, offset_y: 0 }, paper: { ...s.paper, size: "A4", orientation: "portrait", x: -gl, y: bedY + gb - 297 } });
    simulate(gcode, cfg); // A4 in the plate's back-left corner, nozzle = pen
    // XY moves, back in bed coordinates: the pause position, then for each mark a travel to its start and one drawn move to its end
    const xy = gcode.split("\n").filter(l => /^G[01] X/.test(l)).map(l => l.match(/X(\S+) Y(\S+)/).slice(1).map(Number)).map(([x, y]) => [x - X0, y - Y0]);
    assert.strictEqual(xy.length, 5, model);
    const [, [x0, lineY], [x1, lineY2], [tickX, t0], [tickX2, t1]] = xy;
    assert.ok(lineY === lineY2 && x1 - x0 > 50 && tickX === tickX2 && Math.abs(t0 - t1 - 20) < 1e-9, `${model}: a horizontal line and a vertical mark`);
    assert.ok(x0 > -gl && x1 < 210 - gl, `${model}: on the paper`);
    for (const [ox, oy] of [[0, 0], [-4.5, -38], [12, 25.5]]) { // a pen this far from the nozzle draws the marks here:
      const fromTop = bedY + gb - (lineY + oy), fromLeft = tickX + gl + ox;
      assert.deepStrictEqual(G.offsetFromTest(s, fromLeft, fromTop), { offset_x: ox, offset_y: oy }, model);
    }
  }
});

test("word and line spacing set the average gaps; each gap still varies with wobble", () => {
  const flat = () => [[[0, 0], [1.5, 1]]]; // one stroke per word, 1.5 letter heights wide
  const text = Array.from({ length: 6 }, () => Array(30).fill("word").join(" ")).join("\n");
  const gaps = (ws, ls, wobble) => {
    const cfg = G.resolve(withSet({ "writing.word_spacing": ws, "writing.line_spacing": ls, "writing.wobble": wobble }));
    const lines = G.layoutPages(G.words(text, 1), flat, cfg, mulberry(7))[0], words = [], rows = [];
    for (const l of lines) {
      for (let i = 1; i < l.length; i++) words.push((l[i][0][0] - l[i - 1][1][0]) / cfg.writing.x_height);
      rows.push(l[0][0][1]);
    }
    const lineGaps = rows.slice(1).map((y, i) => y - rows[i]);
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length, sd = a => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
    return { word: mean(words), wordSd: sd(words), line: mean(lineGaps), lineSd: sd(lineGaps) };
  };
  const exact = gaps(1.5, 9, 0);
  assert.ok(Math.abs(exact.word - 1.5) < 1e-6 && exact.wordSd < 1e-6 && Math.abs(exact.line - 9) < 1e-6, JSON.stringify(exact)); // no wobble: exactly as set
  for (const [ws, ls] of [[0.6, 7], [1, 8], [2.5, 12]]) {
    const g = gaps(ws, ls, 1);
    assert.ok(Math.abs(g.word / ws - 1) < 0.15 && g.wordSd > 0.02 * ws, `word spacing ${ws}: ${JSON.stringify(g)}`);
    assert.ok(Math.abs(g.line / ls - 1) < 0.1 && g.lineSd > 0.01 * ls, `line spacing ${ls}: ${JSON.stringify(g)}`);
  }
});

test("automatic paper placement: writing starts at the top border where the pen reaches, with any pen offset", () => {
  const oneStroke = () => [[[0, 0], [0.5, 1], [2.4, 0.2]]];
  const text = Array.from({ length: 30 }, () => "some words on a line here").join("\n");
  let checked = 0, refused = 0;
  for (const model of Object.keys(G.PRINTERS).filter(m => G.PRINTERS[m]))
    for (const size of ["A4", "A5", "A6", "US Letter", "Card 4x6 in"]) for (const orientation of ["portrait", "landscape"])
      for (const [ox, oy] of [[0, 0], [-4.5, -38], [12, 30], [-20, 15]]) {
        const s = withSet({ "printer.model": model, "paper.size": size, "paper.orientation": orientation, "printer.offset_x": ox, "printer.offset_y": oy });
        Object.assign(s.paper, G.placePaper(G.resolve(s)));
        const cfg = G.resolve(s), [, t] = G.writingArea(cfg), where = `${model} ${size} ${orientation} offset ${ox},${oy}`;
        const bedY = cfg.printer.bed_y, top = cfg.paper.y + cfg.paper.height;
        assert.ok(t <= cfg.paper.margin_y + 1 || top >= (bedY + cfg.paper.height) / 2 - 1, `${where}: writing starts ${t} mm down`);
        // over the back of the plate: at most the blank top border, or half the extra length of paper longer than the plate
        assert.ok(top - bedY <= Math.max(cfg.paper.margin_y, (cfg.paper.height - bedY) / 2) + 1e-9, `${where}: hangs over the back too far`);
        let pages;
        try { pages = G.layoutPages(G.words(text, 1), oneStroke, cfg, mulberry(1)); } catch (e) {
          if (/Too much text/.test(e.message)) continue; throw new Error(`${where}: ${e.message}`); }
        try { for (const lines of pages) simulate(G.toGcode(G.planPasses(lines, cfg), cfg, ["t"]), cfg); } catch (e) {
          // shortcut: layout doesn't steer around the P1/X1 cutter corner; the final guard refuses instead (never unsafe)
          if (cfg.printer.keepouts.length && /Refusing a move/.test(e.message)) { refused++; continue; } throw new Error(`${where}: ${e.message}`); }
        checked++;
      }
  assert.ok(checked > 100 && refused <= 4, `${checked} setups checked, ${refused} refused for the cutter corner`);
});

test("without sliding, the pen stops where it would leave the plate and the text goes on the next page", () => {
  const oneStroke = () => [[[0, 0], [0.5, 1], [2.4, 0.2]]];
  const text = Array.from({ length: 60 }, () => "some words on a line here").join("\n");
  for (const oy of [0, -27, -38]) {
    const s = withSet({ "paper.size": "A4", "printer.offset_y": oy, "writing.wobble": 1 });
    Object.assign(s.paper, G.placePaper(G.resolve(s)));
    const cfg = G.resolve(s), pages = G.layoutPages(G.words(text, 1), oneStroke, cfg, mulberry(2));
    for (const lines of pages) {
      const passes = G.planPasses(lines, cfg), gcode = G.toGcode(passes, cfg, ["t"]);
      assert.strictEqual(passes.length, 1, `offset ${oy}: one pass, no slide pause`);
      assert.ok(!/slide the paper/.test(gcode), "no slide instruction in the file");
      simulate(gcode, cfg);
      // every pen-down point (nozzle + offset) stays on the plate, at least the edge inset from the front edge
      let z = 99, low = Infinity;
      for (const l of gcode.split("\n")) {
        const zm = /Z(\S+)/.exec(l); if (zm) z = +zm[1];
        const ym = /^G1 X\S+ Y(\S+)/.exec(l); if (ym && z <= cfg.printer.z_draw + 1e-9) low = Math.min(low, +ym[1] + oy);
      }
      assert.ok(low >= G.BED_INSET - 1e-6, `offset ${oy}: pen goes down to Y${low.toFixed(2)}`);
    }
    // with sliding on, a sheet holds more lines
    const slid = G.layoutPages(G.words(text, 1), oneStroke, G.resolve({ ...s, paper: { ...s.paper, slide: true } }), mulberry(2));
    assert.ok(slid[0].length > pages[0].length, `offset ${oy}: ${slid[0].length} lines sliding vs ${pages[0].length} without`);
  }
  assert.throws(() => G.resolve(withSet({ "paper.slide": "yes" })), G.WriteError);
  // lines that would need a slide are refused rather than written with a pause nobody asked for
  const noSlide = G.resolve(withSet({ "printer.offset_y": 0, "paper.size": "A4", "paper.x": 23, "paper.y": -40, "writing.wobble": 0 }));
  const lines = G.layout(G.words(Array(32).fill("line of words").join("\n"), 4), oneStroke, { ...noSlide, paper: { ...noSlide.paper, slide: true } }, mulberry(4));
  assert.ok(G.planPasses(lines, { ...noSlide, paper: { ...noSlide.paper, slide: true } }).length > 1, "this text needs a slide");
  assert.throws(() => G.planPasses(lines, noSlide), /sliding the paper/);
});

test("a blank line between paragraphs stays blank when crowded lines get pushed apart", () => {
  const tall = ({ word }) => Array.from({ length: word.length }, (_, j) => [[0.6 * j, -1.1], [0.6 * j + 0.2, 2.2]]); // every line collides at 8 mm
  const para = Array(40).fill("lglg").join(" ");
  const cfg = G.resolve(withSet({ "writing.wobble": 0 }));
  const lines = G.layout(G.words(`${para}\n\n${para}`, 1), tall, cfg, mulberry(1));
  const tops = lines.map(l => G.extent(l)[1]), steps = tops.slice(1).map((t, i) => t - tops[i]);
  const blank = steps.reduce((a, b) => Math.max(a, b)), normal = Math.min(...steps);
  assert.ok(steps.length >= 3 && normal > cfg.writing.line_spacing, `lines pushed apart: ${steps.map(s => s.toFixed(1))}`);
  // the bug this guards against left only ~0.2 of a line between paragraphs
  assert.ok(blank - normal >= cfg.writing.line_spacing * 0.6, `blank line kept: ${steps.map(s => s.toFixed(1))}`);
});

const zLines = g => g.split("\n").filter(l => /^G1 Z/.test(l)).map(l => +l.match(/Z([\d.]+)/)[1]);

test("extra pressure at the bottom: the pen goes lower line by line down the page, from the clamping point to at most press_bottom", () => {
  const text = Array.from({ length: 14 }, (_, i) => `line ${"abcdefghijklmn"[i]} of the page`).join("\n");
  const downs = g => { // [bed Y, Z] of every pen-down, in order
    const out = []; let y = null;
    for (const l of g.split("\n")) { const m = /^G0 X\S+ Y(\S+)/.exec(l); if (m) y = +m[1]; const zm = /^G1 Z(\S+) F/.exec(l); if (zm && y !== null) out.push([y, +zm[1]]); }
    return out;
  };
  const flat = run(G.DEFAULT_SETTINGS, text, 5), pr0 = flat.cfg.printer;
  const d0 = downs(flat.gcode).filter(([, z]) => z < pr0.z_lift);
  assert.ok(d0.length > 20 && d0.every(([, z]) => z === pr0.z_draw), "off (the default): every stroke at the writing height, as before");
  const out = run(withSet({ "printer.press_bottom": 0.6 }), text, 5), pr = out.cfg.printer;
  simulate(out.gcode, out.cfg);
  const d = downs(out.gcode).filter(([, z]) => z < pr.z_lift), clampY = d[0][0];
  assert.strictEqual(d[0][1], pr.z_draw, "clamped and first stroke at the writing height");
  for (const [y, z] of d) {
    const want = pr.z_draw - 0.6 * Math.min(1, Math.max(0, (clampY - y) / out.cfg.paper.height));
    assert.ok(Math.abs(z - want) < 0.006, `at Y${y}: Z${z}, expected ${want.toFixed(3)}`);
  }
  const last = d[d.length - 1];
  assert.ok(pr.z_draw - last[1] > 0.25 && pr.z_draw - last[1] <= 0.6, `the last line presses harder: ${last[1]}`);
  // and the simulator catches a file that presses where it shouldn't
  const bad = out.gcode.replace(/^(G0 X\S+ Y\S+ F\d+\n)G1 Z10\.00 F600$/m, "$1G1 Z9.50 F600"); // the first stroke, at the clamping point, pressed 0.5 mm
  assert.notStrictEqual(bad, out.gcode);
  assert.throws(() => simulate(bad, out.cfg), /behind its clamping point/);
  assert.throws(() => G.resolve(withSet({ "printer.z_draw": 2.5, "printer.z_lift": 4.5, "printer.press_bottom": 1 })), /at least 2 mm/);
  assert.throws(() => G.resolve(withSet({ "printer.press_bottom": 3 })), /press bottom/);
});

test("bed levelling, each maker's own way: after homing, pen out, cold, before the paper; heaters off again; never saved", () => {
  const text = "Dear friend,\nA few lines written to check the bed levelling.\nAnd one more.";
  const bambu = cmd => ["G29.2 S1", new RegExp(`^${cmd} X`), "M104 S0", "M140 S0"], buddy = [/^M555 X/, "G29", "M104 S0", "M140 S0", "M420 S1 Z0"];
  // one printer per method: the lines right after homing and the nozzle heater going off, up to the first move
  for (const [model, want] of [["Bambu Lab A1", bambu("G29 A1")], ["Bambu Lab A1 mini", bambu("G29 A1")], ["Bambu Lab P1P / P1S", bambu("G29 A")],
    ["Bambu Lab X1 Carbon / X1E", bambu("G29 A")], ["Creality Ender-3 V2 Neo", ["G29", "M104 S0", "M140 S0", "M420 S1 Z0"]], ["Elegoo Neptune 3 Pro", ["M420 S1 Z0"]],
    ["Qidi X-Plus 3", ["BED_MESH_CALIBRATE", "M104 S0", "M140 S0"]], ["Vzbot 235 AWD", ["BED_MESH_PROFILE LOAD=default"]], ["Prusa MK4", buddy], ["Prusa MINI", buddy],
    ["Prusa MK3S", []]]) { // the MK3S levels as it homes (plain G28)
    const s = withSet({ "printer.model": model }); Object.assign(s.paper, G.placePaper(G.resolve(s)));
    const out = run(s, text, 2), g = out.gcode.split("\n").filter(l => !l.startsWith(";")), pr = out.cfg.printer;
    simulate(out.gcode, out.cfg);
    const h = g.indexOf("G28"), block = g.slice(h + 2, g.findIndex(l => /^G[01] /.test(l)));
    assert.ok(h > 0 && g[h + 1] === "M104 S0", `${model}: heater off right after homing`);
    assert.ok(block.length === want.length && block.every((l, k) => (typeof want[k] === "string" ? l === want[k] : want[k].test(l))), `${model}: ${block.join(" | ")}`);
    assert.ok(!g.some(l => /^(M500|M109|M190|M104 S[1-9]|M140 S[1-9]|SAVE_CONFIG)/.test(l)), `${model}: nothing heated or saved`);
    const rect = block.map(l => /^(?:G29 A1?|M555) X(\S+) Y(\S+) [IW](\S+) [JH](\S+)$/.exec(l)).find(Boolean);
    if (rect) { // Bambu and Prusa's Buddy: under the writing only
      const [x, y, i, j] = rect.slice(1).map(Number);
      const draws = g.filter(l => /^G1 X/.test(l)).map(l => l.match(/X(\S+) Y(\S+)/).slice(1).map(Number));
      assert.ok(draws.length > 50 && draws.every(([dx, dy]) => dx >= x && dx <= x + i && dy >= y && dy <= y + j), `${model}: every written point inside the levelled area`);
      assert.ok(i < 0.8 * pr.bed_x && j < 0.8 * pr.bed_y, `${model}: just the writing, not the whole bed (${i} x ${j})`);
    }
    const probes = !G.LEVEL_SAVED.has(G.LEVEL_PRINTERS.get(model)); // the MK3S too: its homing levels
    assert.strictEqual(/^; BEFORE STARTING.*bed levelling/m.test(out.gcode), probes, `${model}: the warning says levelling touches the plate`);
    const offS = withSet({ "printer.model": model, "printer.level": false, "paper.x": s.paper.x, "paper.y": s.paper.y }), off = run(offS, text, 2);
    simulate(off.gcode, off.cfg);
    assert.match(off.gcode, model === "Prusa MK3S" ? /^G28 W\nM104 S0\nG1 Z/m : /^G28\nM104 S0\nG1 Z/m, `${model}: off means off`);
  }
  { // writing just beside the P1's purge chute (a keep-out, x 0-18, y 0-28): the levelled area, 3 mm wider than the
    // writing, would reach into it, so it steps back past the keep-out's edge on the side that keeps the most
    const cfg = G.resolve(withSet({ "printer.model": "Bambu Lab P1P / P1S", "printer.offset_x": 0, "printer.offset_y": 0, "paper.size": "A6", "paper.x": 10, "paper.y": 20 }));
    const at = (x, y) => [x - 10, 20 + cfg.paper.height - y]; // a nozzle position on the bed, as a point on the paper
    const g = G.toGcode([{ shift: 0, strokes: [[at(20, 30), at(60, 30)], [at(20, 60), at(60, 60)]] }], cfg, ["t"]);
    simulate(g, cfg); // which refuses a levelled area over a keep-out
    const lv = g.split("\n").find(l => l.startsWith("G29 A X")), [, x, y, i, j] = /X(\S+) Y(\S+) I(\S+) J(\S+)/.exec(lv).map(Number);
    assert.ok(x === 19 && y === 27 && x + i === 63 && y + j === 63, `stepped back past the keep-out's right edge: ${lv}`);
  }
  // no levelling where the maker's start code doesn't level (no probe, or a start macro), on a nozzle-contact probe that
  // needs a hot, wiped nozzle (Lulzbot), on tool changers, or where OrcaSlicer has no Bambu start code (H2D)
  for (const model of ["Bambu Lab P2S", "Creality Ender-3 V3 SE", "Voron 2.4 350", "Lulzbot Taz 6", "Prusa XL 5T", "Bambu Lab H2D", "Custom"]) {
    const s = withSet({ "printer.model": model }); Object.assign(s.paper, G.placePaper(G.resolve(s)));
    const out = run(s, text, 2);
    simulate(out.gcode, out.cfg);
    assert.ok(!G.LEVEL_PRINTERS.has(model) && /^G28\nM104 S0\nG1 Z/m.test(out.gcode), `${model}: no levelling where the commands aren't known`);
  }
  for (const model of ["Bambu Lab A1", "Prusa MK4", "Prusa MK3S", "Qidi X-Plus 3"]) { // the reach check never levels
    const s = withSet({ "printer.model": model }); Object.assign(s.paper, G.placePaper(G.resolve(s)));
    const out = run(s, text, 2), reach = G.reachCheck(out.passes, out.cfg, ["r"]);
    simulate(reach, out.cfg, { reach: true });
    assert.match(reach, model === "Prusa MK3S" ? /^G28 W\nM104 S0\nG1 Z/m : /^G28\nM104 S0\nG1 Z/m, `${model}: the reach check doesn't level`);
  }
  // gcode.js and the simulator agree on every printer
  for (const model of Object.keys(G.PRINTERS)) assert.strictEqual((levelOf(model) || [])[0], G.LEVEL_PRINTERS.get(model), model);
  // the simulator refuses levelling after the head has moved (the paper or pen may be there), a stored calibration,
  // another printer's command, the head moving before the heaters are back off, and levelling the maker doesn't do
  const out = run(withSet({}), text, 2), g = out.gcode.split("\n");
  const late = g.filter(l => !l.startsWith("G29")); late.splice(late.findIndex(l => l.startsWith("; place the paper")), 0, "G29.2 S1", g.find(l => l.startsWith("G29 A1")));
  assert.throws(() => simulate(late.join("\n"), out.cfg), /levelling where it can't be/);
  assert.throws(() => simulate(out.gcode.replace(/^(G29 A1 .*)$/m, "$1\nM500"), out.cfg), /malformed/);
  assert.throws(() => simulate(out.gcode.replace(/^G29 A1 X/m, "G29 A X"), out.cfg), /not this printer's levelling/); // the P1's form on an A1
  const neo = run(withSet({ "printer.model": "Creality Ender-3 V2 Neo" }), text, 2), qidi = run(withSet({ "printer.model": "Qidi X-Plus 3" }), text, 2);
  assert.throws(() => simulate(neo.gcode.replace(/^G29$/m, "BED_MESH_CALIBRATE"), neo.cfg), /not this printer's levelling/); // Klipper's on Marlin
  assert.throws(() => simulate(qidi.gcode.replace(/^M140 S0\n/m, ""), qidi.cfg), /not this printer's levelling line \d+: G1 Z/); // moving with the bed heater maybe on
  assert.throws(() => simulate(qidi.gcode.replace(/^(BED_MESH_CALIBRATE)$/m, "$1\nSAVE_CONFIG"), qidi.cfg), /malformed/);
  const se = run(withSet({ "printer.model": "Creality Ender-3 V3 SE" }), text, 2);
  assert.throws(() => simulate(se.gcode.replace(/^M104 S0$/m, "M104 S0\nM420 S1 Z0"), se.cfg), /levelling where it can't be/);
  assert.throws(() => simulate(se.gcode.replace(/^G28$/m, "G28 W"), se.cfg), /G28 W on a printer/);
  assert.throws(() => G.resolve(withSet({ "printer.level": "yes" })), /on or off/);
});

test("every printer OrcaSlicer knows: a page is safe in its own coordinates, and its firmware gets G-code it reads", () => {
  const ORCA = require("../printers.js");
  // the data: sane rectangles, keep-outs inside the bed, the plate around the bed, known firmware
  for (const list of Object.values(ORCA)) for (const [name, [x0, y0, x1, y1, z, fw, keep, plate]] of Object.entries(list)) {
    assert.ok(x1 - x0 >= 50 && y1 - y0 >= 50 && x1 - x0 <= 1000 && y1 - y0 <= 1000 && z >= 50, name);
    assert.ok(["klipper", "marlin", "marlin2", "reprapfirmware", "repetier"].includes(fw), `${name}: firmware ${fw}`);
    for (const k of keep) assert.ok(k[0] >= x0 && k[1] >= y0 && k[2] <= x1 && k[3] <= y1 && k[2] > k[0] && k[3] > k[1], `${name}: keep-out`);
    if (plate) assert.ok(plate[0] <= x0 && plate[1] <= y0 && plate[2] >= x1 && plate[3] >= y1, `${name}: plate`);
  }
  let made = 0, refused = 0;
  for (const model of Object.keys(G.PRINTERS).filter(m => G.PRINTERS[m])) {
    const s = withSet({ "printer.model": model, "paper.size": "A6" });
    Object.assign(s.paper, G.placePaper(G.resolve(s)));
    let out;
    try { out = run(s, "Dear friend,\nA short note written on this printer.", 3); }
    catch (e) { if (!(e instanceof G.WriteError)) throw e; refused++; continue; }
    simulate(out.gcode, out.cfg); // own coordinates, keep-outs and dialect, from OrcaSlicer's data
    simulate(G.reachCheck(out.passes, out.cfg, ["t"]), out.cfg, { reach: true }); // and its reach check
    const bambu = out.cfg.printer.dialect === "bambu";
    assert.strictEqual(/^G21$/m.test(out.gcode), bambu, `${model}: G21 only for Bambu`);
    assert.ok(out.gcode.includes(bambu ? "\nG4 S30\n" : "\nG4 P30000\n"), `${model}: 30 s pauses as ${bambu ? "G4 S30" : "G4 P30000 (Klipper ignores S)"}`);
    made++;
  }
  assert.ok(made > 380 && refused <= 5, `pages made on ${made} printers, refused on ${refused}`);
});

test("a printer whose bed starts elsewhere gets the very same moves, shifted into its coordinates", () => {
  // Flashforge Adventurer 5M: 220 x 220 mm from X-110 Y-110; the same page on a 220 x 220 Custom bed from X0 Y0
  const text = "The same page on two printers", ff = withSet({ "printer.model": "Flashforge Adventurer 5M" });
  const custom = withSet({ "printer.model": "Custom", "printer.bed_x": 220, "printer.bed_y": 220, "printer.bed_z": 220 });
  for (const s of [ff, custom]) Object.assign(s.paper, { x: 36, y: 5 });
  const a = run(ff, text, 9).gcode.split("\n"), b = run(custom, text, 9).gcode.split("\n");
  assert.strictEqual(a.length, b.length);
  let shifted = 0;
  a.forEach((l, k) => {
    const m = /^(G[01]) X(\S+) Y(\S+)(.*)$/.exec(l), n = /^(G[01]) X(\S+) Y(\S+)(.*)$/.exec(b[k]);
    if (!m) return assert.ok(l === b[k] || (l.startsWith(";") && b[k].startsWith(";")), `line ${k}: ${l} / ${b[k]}`);
    assert.ok(m[1] === n[1] && m[4] === n[4] && Math.abs(+m[2] - (+n[2] - 110)) < 1e-9 && Math.abs(+m[3] - (+n[3] - 110)) < 1e-9, `line ${k}: ${l} / ${b[k]}`);
    shifted++;
  });
  assert.ok(shifted > 20);
  assert.ok(a.some(l => /^G0 X-\d/.test(l)), "negative X written as such");
});

test("reach check: no drawing, the written points nearest the corners at pen-up height, on every kind of printer", () => {
  const text = "Dear friend,\nA page that reaches out to the corners of its writing area.\nThird line here.";
  for (const model of ["Bambu Lab A1", "Bambu Lab P1P / P1S", "Voron 2.4 350", "Flashforge Adventurer 5M", "Elegoo Centauri Carbon", "Prusa MK4"]) {
    const s = withSet({ "printer.model": model, "printer.dry_run": true }); // a dry run setting must not leak in
    Object.assign(s.paper, G.placePaper(G.resolve(s)));
    const page = run(s, text, 4), check = G.reachCheck(page.passes, page.cfg, ["t"]);
    simulate(check, { ...s, printer: { ...page.cfg.printer, dry_run: false }, paper: page.cfg.paper }, { reach: true });
    const g = check.split("\n"), pr = page.cfg.printer, bambu = pr.dialect === "bambu";
    assert.match(check, /^G28\nM104 S0$/m, model);
    assert.ok(!g.some(l => /^G1 X/.test(l)), `${model}: nothing drawn`);
    const visits = g.filter(l => / F1500$/.test(l));
    assert.strictEqual(visits.length, 4, model);
    assert.strictEqual(g.filter(l => l === (bambu ? `G4 S${G.REACH_WAIT_S}` : `G4 P${G.REACH_WAIT_S * 1000}`)).length, 4, `${model}: a wait at each corner`);
    // each corner is a point the page really writes (same coordinates as in the page file), visited at pen-up height
    const written = new Set(page.gcode.split("\n").filter(l => /^G[01] X/.test(l)).map(l => l.match(/X\S+ Y\S+/)[0]));
    for (const v of visits) assert.ok(written.has(v.match(/X\S+ Y\S+/)[0]), `${model}: ${v} is a written point`);
    const zs = g.filter(l => /^G1 Z/.test(l)).map(l => +l.match(/Z(\S+)/)[1]);
    assert.strictEqual(zs[1], +pr.z_lift.toFixed(2), `${model}: corners at pen-up height`);
    const xs = visits.map(v => +v.match(/X(\S+)/)[1]), ys = visits.map(v => +v.match(/Y(\S+)/)[1]);
    assert.ok(xs[0] < xs[1] && ys[0] > ys[3] && xs[3] < xs[2] && ys[1] > ys[2], `${model}: back left, back right, front right, front left`);
  }
});

test("bed keep-outs from OrcaSlicer are never entered (Elegoo purge corner, Qidi corners)", () => {
  for (const [model, corner] of [["Elegoo Centauri Carbon", "front-right"], ["Qidi X-Max 4", "front-left"]]) {
    const pr = G.resolve(withSet({ "printer.model": model })).printer;
    assert.ok(pr.keepouts.length > 0, model);
    const s = withSet({ "printer.model": model, "paper.size": "A6", "printer.offset_x": 0, "printer.offset_y": 0 });
    s.paper.x = corner === "front-left" ? 0 : pr.bed_x - 105; s.paper.y = 0; // the page's first letters over the keep-out
    let refused = 0, made = 0;
    for (let seed = 1; seed <= 6; seed++) {
      try { const out = run(s, Array(12).fill("words written in the corner of the bed").join("\n"), seed); simulate(out.gcode, out.cfg); made++; }
      catch (e) { if (!(e instanceof G.WriteError)) throw e; refused++; }
    }
    assert.ok(refused > 0, `${model}: writing over the keep-out is refused`);
  }
});

test("the nozzle heater is switched off right after homing, and nothing ever heats", () => {
  for (const model of Object.keys(G.PRINTERS).filter(m => m !== "Custom")) {
    const { gcode } = run(withSet({ "printer.model": model }), "Hello there", 1);
    assert.match(gcode, /^G28\nM104 S0$/m, model);
    assert.ok(!/^M(104 S[^0]|104 S0\d|109|140 S[^0]|140 S0\d|190)/m.test(gcode), `${model}: no heating command`); // M140 S0: bed heater off
  }
  assert.match(G.offsetTest(G.DEFAULT_SETTINGS), /^G28\nM104 S0$/m);
});

test("dry run: the same moves 8 mm higher, with the pen still clamped at the writing height", () => {
  const text = "Dear friend, this is a dry run of the whole page.\nSecond line here.";
  const real = run(G.DEFAULT_SETTINGS, text, 3), dry = run(withSet({ "printer.dry_run": true }), text, 3);
  simulate(dry.gcode, dry.cfg); // the simulator also checks no move comes within 8 mm of the writing height
  const xy = g => g.split("\n").filter(l => /^G[01] X/.test(l)).map(l => l.replace(/ F\d+$/, ""));
  assert.deepEqual(xy(dry.gcode), xy(real.gcode), "same path");
  const zd = dry.cfg.printer.z_draw, zs = zLines(dry.gcode);
  assert.strictEqual(zs.filter(v => Math.abs(v - zd) < 1e-9).length, 1, "lowered to the writing height once, to clamp the pen");
  assert.ok(zs.includes(+(zd + G.DRY_RUN_LIFT).toFixed(2)), "writes 8 mm higher");
  assert.match(dry.gcode, /^; DRY RUN/m);
  assert.ok(!/DRY RUN/.test(real.gcode));
  assert.ok(!/DRY RUN/.test(G.offsetTest(withSet({ "printer.dry_run": true }))), "the offset test always draws");
  // the higher writing must still fit under the printer's ceiling (A1 mini: 180 mm)
  const tall = { "printer.model": "Bambu Lab A1 mini", "printer.z_draw": 150, "printer.z_lift": 165 };
  G.resolve(withSet(tall));
  assert.throws(() => G.resolve(withSet({ ...tall, "printer.dry_run": true })), G.WriteError);
});

test("each line records where its words landed, for clicking a word in the preview", () => {
  const cfg = G.resolve(G.DEFAULT_SETTINGS), rng = mulberry(4);
  const paras = G.words("one two three four five six seven eight nine ten eleven twelve thirteen fourteen", 4);
  const lines = G.layout(paras, fakeInk(rng), cfg, rng);
  assert.ok(lines.length > 1);
  assert.deepEqual(lines.flatMap(l => l.words.map(w => w.seed)), paras.flat().map(w => w.seed));
  for (const l of lines) {
    const all = G.extent(l);
    for (const { box } of l.words) assert.ok(box[0] >= all[0] - 1e-9 && box[2] <= all[2] + 1e-9 && box[1] >= all[1] - 1e-9 && box[3] <= all[3] + 1e-9);
    for (let j = 1; j < l.words.length; j++) assert.ok(l.words[j].box[0] > l.words[j - 1].box[2], "left to right, not overlapping");
  }
});

test("ruled paper: every line sits on a printed line, right of the margin line, even at full wobble", () => {
  const text = Array.from({ length: 7 }, (_, p) => "the quick brown fox jumps over a lazy dog ".repeat(1 + p % 3).trim()).join("\n");
  const steps = [];
  for (const [ruling, first, marginLine, wobble, seed] of [[8, 20, 25, 1, 1], [7.1, 30.5, 0, 2, 2], [10, 12, 30, 2, 3], [7, 40, 20, 0, 4]]) {
    const cfg = G.resolve(withSet({ "paper.ruling": ruling, "paper.first_line": first, "paper.margin_line": marginLine,
      "writing.wobble": wobble, "writing.x_height": 2.5, "paper.margin": 8 }));
    const rng = mulberry(seed), pages = G.layoutPages(G.words(text, seed), fakeInk(rng), cfg, rng);
    const grid = G.lineGrid(cfg);
    assert.ok(grid.ruled && grid.first >= G.writingArea(cfg)[1] + 2 * 2.5 - 1e-9 && grid.first - ruling < Math.max(first, G.writingArea(cfg)[1] + 5) + 1e-9,
      `first printed line with room above: ${grid.first}`);
    for (const lines of pages) {
      assert.ok(lines[0].baseline >= grid.first - 1e-9);
      for (const l of lines) {
        const k = (l.baseline - first) / ruling;
        assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `baseline ${l.baseline} on a printed line (${ruling} mm from ${first})`);
        if (marginLine) assert.ok(G.extent(l)[0] >= marginLine + G.MARGIN_LINE_GAP - 1e-9, "right of the margin line");
      }
      simulate(G.toGcode(G.planPasses(lines, cfg), cfg, []), cfg);
      steps.push(...lines.slice(1).map((l, j) => l.baseline - lines[j].baseline));
    }
  }
  // lines go one printed line apart: tails may touch the next line, so a line seldom has to skip one
  const one = steps.filter(d => [8, 7.1, 10, 7].some(r => Math.abs(d - r) < 1e-6)).length;
  assert.ok(one >= 0.9 * steps.length, `${one} of ${steps.length} lines one printed line below the last`);
  assert.throws(() => G.resolve(withSet({ "paper.ruling": 6, "writing.x_height": 4.5 })), /too big for lines 6 mm apart: use 1.7 mm letters/);
  assert.throws(() => G.resolve(withSet({ "paper.ruling": 8, "paper.first_line": 300 })), G.WriteError);
  // the capacity estimate counts printed lines
  const cap = G.capacity(G.resolve(withSet({ "paper.ruling": 8, "paper.first_line": 20, "writing.x_height": 2.5 })), 0.75);
  assert.ok(cap.lines >= 18 && cap.lines <= 23, `A5 with 8 mm lines: ${cap.lines}`);
});

test("_underline_ and *second pen* marks: parsed per word, underlined under the words, pen 2 after a pen change", () => {
  const ws = G.words("_Answer 1:_ the *red words* here_ and_ plain", 1)[0];
  assert.deepEqual(ws.map(w => [w.word, !!w.underline, w.pen || 1]), [["Answer", true, 1], ["1:", true, 1], ["the", false, 1],
    ["red", false, 2], ["words", false, 2], ["here", false, 1], ["and", true, 1], ["plain", false, 1]]);
  assert.strictEqual(ws[0].seed, G.words("Answer", 1)[0][0].seed, "marks don't change a word's handwriting");
  assert.deepEqual(G.words("*open to the end\nnext", 1).map(p => p.map(w => w.pen || 1)), [[2, 2, 2, 2], [1]], "marks end with the line");

  // underline: one stroke per run, under the words (wobble 0: exactly 0.3 letter heights below the baseline)
  const cfg = G.resolve(withSet({ "writing.wobble": 0 })), rng = mulberry(2), xh = cfg.writing.x_height;
  const l = G.layout(G.words("_Heading here_ then plain words", 2), fakeInk(rng), cfg, rng)[0];
  assert.strictEqual(l.words.length, 5);
  const extra = l.filter(s => s.every(p => Math.abs(p[1] - (l.baseline + 0.3 * xh)) < 1e-9));
  assert.strictEqual(extra.length, 1, "one underline");
  const [x0, , x1] = G.extent([extra[0]]);
  assert.ok(x0 <= l.words[0].box[0] && x1 >= l.words[1].box[2] && x1 < l.words[2].box[0], "under the two heading words only");

  // pen 2: all of pen 1 first, then a pen change (head up, pen 1 out; head down, pen 2 in), then pen 2
  const out = run(G.DEFAULT_SETTINGS, "Plain words first, *then the red part* and plain again.\nMore plain text.", 6);
  simulate(out.gcode, out.cfg);
  const g = out.gcode.split("\n"), change = g.indexOf("; PEN CHANGE: take pen 1 out of the holder");
  assert.ok(change > 0, "a pen change");
  const pr = out.cfg.printer, touch = `G1 Z${pr.z_draw.toFixed(2)} F${pr.z_feed}`;
  const pen2 = out.passes[0].strokes.filter(s => s.pen === G.PEN2).length, pen1 = out.passes[0].strokes.length - pen2;
  assert.ok(pen1 > 0 && pen2 > 0);
  assert.strictEqual(g.slice(0, change).filter(x => x === touch).length, 1 + pen1, "clamp + every pen-1 stroke before the change");
  assert.strictEqual(g.slice(change).filter(x => x === touch).length, 1 + pen2, "clamp pen 2 + every pen-2 stroke after");
  assert.match(g[change - 2], new RegExp(`^G1 Z${Math.max(pr.z_draw + G.CLEARANCE, pr.z_lift).toFixed(2)}`), "head up before moving to pen 2's first letter");
  assert.match(g[change - 1], /^G0 X/);
  // only pen 2 on the page: nothing to change; a second pen and a paper slide can't be combined
  assert.ok(!/PEN CHANGE/.test(run(G.DEFAULT_SETTINGS, "*all of it in red*", 6).gcode));
  const a4 = withSet({ "paper.size": "A4", "paper.x": 23, "paper.y": -40, "paper.slide": true });
  let n = 20;
  while (run(a4, Array(n).fill("line of red words").join("\n"), 4).passes.length < 2) n++; // marks don't change the layout
  assert.throws(() => run(a4, Array(n).fill("line of *red* words").join("\n"), 4), /second pen/);
});

test("editing words: a moved word lands exactly that far away and nothing else moves; size scales a word or a line", () => {
  const cfg = G.resolve(G.DEFAULT_SETTINGS), ink = ({ word }) => [[[0, 0], [0.6 * word.length, 1]], [[0.1, -0.5], [0.3, 1.6]]];
  const text = "Name Ricky Kashyap\nBranch CSE and _some more words_ to fill a line or two of the page";
  const lay = (edit = () => {}) => { const paras = G.words(text, 3); edit(paras.flat()); return G.layout(paras, ink, cfg, mulberry(5)); };
  const find = (ls, key) => { for (const l of ls) for (const w of l.words) if (w.key === key) return { l, w }; };
  const base = lay();
  assert.deepEqual(G.words("a b a", 1)[0].map(w => w.key), ["a|1", "b|1", "a|2"], "keys: the word and which time it appears");
  assert.notStrictEqual(G.words("a", 1)[0][0].seed, G.words("a", 2)[0][0].seed);
  assert.strictEqual(G.words("a", 1)[0][0].key, G.words("a", 2)[0][0].key, "a key survives New version");
  assert.ok(G.headerWords("Name", true, 1, 0).flat().every(w => w.key.startsWith("header0:")), "header words never share a key with the text");

  for (const [key, dx, dy] of [["CSE|1", 12, -3.5], ["more|1", -20, 9], ["Name|1", 30, 40]]) {
    const moved = lay(ws => { const w = ws.find(w => w.key === key); w.dx = dx; w.dy = dy; });
    assert.strictEqual(moved.length, base.length);
    const { w: bw } = find(base, key), { l: ml, w: mw } = find(moved, key);
    base.forEach((l, i) => {
      if (moved[i] !== ml) return assert.strictEqual(JSON.stringify(moved[i]), JSON.stringify(l), `${key}: other lines stay put`);
      l.words.forEach((a, wi) => { // its line: every word's strokes the same, the moved one shifted by exactly dx, dy
        const b = moved[i].words[wi], [ox, oy] = b.key === key ? [dx, dy] : [0, 0];
        assert.strictEqual(b.key, a.key);
        for (let j = 0; j < a.s1 - a.s0; j++) l[a.s0 + j].forEach(([x, y], q) => {
          const [mx, my] = moved[i][b.s0 + j][q];
          assert.ok(Math.abs(mx - x - ox) < 1e-9 && Math.abs(my - y - oy) < 1e-9, `${key} moved by exactly ${dx}, ${dy}; ${a.key} stays`);
        });
      });
    });
    assert.ok(Math.abs(mw.box[0] - bw.box[0] - dx) < 1e-9 && Math.abs(mw.box[1] - bw.box[1] - dy) < 1e-9, "its box moves with it");
  }
  // an underlined word takes its underline along; the rest of the run keeps its own
  const ul = lay(ws => { const w = ws.find(w => w.key === "more|1"); w.dx = -20; w.dy = 9; });
  assert.strictEqual(ul.flat().filter(s => s.moved).length, 2 + 1, "the word's 2 strokes and its own underline");

  // size: the word is exactly that much wider; a whole line at half size fits more words on it
  const big = lay(ws => { ws.find(w => w.key === "Branch|1").size = 2; });
  const width = (ls, key) => { const { w } = find(ls, key); return w.box[2] - w.box[0]; };
  assert.ok(Math.abs(width(big, "Branch|1") / width(base, "Branch|1") - 2) < 1e-9);
  const small = lay(ws => ws.filter(w => !/^(Name|Ricky|Kashyap)\|/.test(w.key)).forEach(w => { w.size = 0.5; }));
  assert.ok(small.length < base.length, "smaller words: fewer lines");
  assert.ok(Math.abs(width(small, "CSE|1") / width(base, "CSE|1") - 0.5) < 1e-9);
  // a big word in the middle of the page pushes the next lines down instead of writing into them
  const tall = lay(ws => { ws.find(w => w.key === "Ricky|1").size = 3; });
  const gapBelow = ls => ls[1].baseline - ls[0].baseline;
  assert.ok(gapBelow(tall) > gapBelow(base), "room for the big word");
  const lows = G.extent(tall[0])[3], tops = G.extent(tall[1])[1];
  assert.ok(tops > lows - 1e-9 || G.extent([tall[1][0]])[1] > lows - 3, "the line under it keeps clear");

  // refused: off the paper, beyond the pen's reach, nonsense from storage
  for (const e of [{ dx: -100 }, { dy: -60 }, { dx: 500 }, { dy: 1e9 }, { dx: NaN }, { dy: "5" }, { size: 5 }, { size: 0.1 }, { size: "2" }, { size: NaN }])
    assert.throws(() => lay(ws => Object.assign(ws[0], e)), G.WriteError, JSON.stringify(e));
  // and a page with edits still makes a file the simulator accepts
  const out = run(G.DEFAULT_SETTINGS, text, 3, ws => { ws[1].size = 2.5; ws[4].dx = 15; ws[4].dy = 20; ws[6].size = 0.4; });
  simulate(out.gcode, out.cfg);
});

test("header and page numbers: the first line of every sheet, header from the left, page number ending at the right", () => {
  const cfg = G.resolve(withSet({ "writing.header": "Sam Smith 21 Oct", "writing.page_numbers": true })), xh = cfg.writing.x_height;
  const rng = mulberry(9), ink = fakeInk(rng), header = k => G.headerWords("Sam Smith 21 Oct", true, 9, k);
  const text = Array.from({ length: 40 }, () => "the quick brown fox jumps over the lazy dog").join("\n");
  const pages = G.layoutPages(G.words(text, 9), ink, cfg, rng, G.MAX_PAGES, { header });
  assert.ok(pages.length >= 2);
  const [left, , right] = G.writingArea(cfg);
  pages.forEach((lines, k) => {
    const h = lines[0], [hl, hr] = header(k);
    assert.deepEqual(h.words.map(w => w.seed), [...hl, ...hr].map(w => w.seed), `sheet ${k + 1}: header words`);
    assert.ok(h.words[0].box[0] >= left - 1e-9 && h.words[0].box[0] < left + 3 * xh, "header starts at the left");
    const last = h.words[h.words.length - 1].box[2];
    assert.ok(last <= right + 1e-9 && last > right - 4 * xh, `page number ends at the right: ${last} vs ${right}`);
    assert.ok(lines[1].baseline >= h.baseline + cfg.writing.line_spacing - 1e-9, "the text starts a line below");
    simulate(G.toGcode(G.planPasses(lines, cfg), cfg, []), cfg);
  });
  assert.deepEqual(G.headerWords("", true, 9, 1).flat().map(w => w.word), ["Page", "2"]);
  assert.notStrictEqual(G.headerWords("Sam", false, 9, 0)[0][0].seed, G.headerWords("Sam", false, 9, 1)[0][0].seed, "written afresh on each sheet");
  assert.strictEqual(G.capacity(cfg, 0.75).lines, G.capacity(G.resolve(G.DEFAULT_SETTINGS), 0.75).lines - 1, "a line kept for it");
  assert.throws(() => G.layoutPages(G.words("hi", 1), ink, cfg, mulberry(1), 50, { header: k => G.headerWords("ab ".repeat(30), true, 1, k) }), /header doesn't fit/);
  assert.throws(() => G.resolve(withSet({ "writing.header": "x".repeat(81) })), G.WriteError);
});

test("starting at line N: only lines N onward, and pause 1 stops over line N's first letter", () => {
  const cfg = G.resolve(G.DEFAULT_SETTINGS), rng = mulberry(5);
  const lines = G.layout(G.words(Array(6).fill("some words on a line").join("\n"), 5), fakeInk(rng), cfg, rng);
  const from = 3, gcode = G.toGcode(G.planPasses(lines.slice(from - 1), cfg), cfg, [`resumes at line ${from}`]);
  simulate(gcode, cfg);
  const first = lines[from - 1][0][0], p = cfg.paper, pr = cfg.printer;
  const at = `X${(p.x + first[0] - pr.offset_x).toFixed(2)} Y${(p.y + p.height - first[1] - pr.offset_y).toFixed(2)}`;
  assert.ok(gcode.split("\n").find(l => l.startsWith("G0 X")).includes(at), "head waits over line 3's first letter");
  const strokes = lines.slice(from - 1).reduce((n, l) => n + l.length, 0), touch = `G1 Z${pr.z_draw.toFixed(2)} F${pr.z_feed}`;
  assert.strictEqual(gcode.split("\n").filter(x => x === touch).length, 1 + strokes, "lines 1 and 2 not written again");
});
