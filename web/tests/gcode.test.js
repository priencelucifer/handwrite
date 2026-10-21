// Safety tests for gcode.js: every unsafe setting is refused, and every file that IS produced is checked by an
// independent simulator that knows only the physical facts below (not gcode.js's maths).
const test = require("node:test");
const assert = require("node:assert");
const G = require("../gcode.js");

const { simulate } = require("./sim.js");

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

function run(settings, text, seed) {
  const cfg = G.resolve(settings);
  const rng = mulberry(seed);
  const lines = G.layout(G.words(text, seed), fakeInk(rng), cfg, rng);
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
  const cfg = G.resolve(withSet({ "printer.model": "Bambu Lab P1P / P1S", "paper.size": "A6", "paper.x": 0, "paper.y": 0 }));
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
  const vocab = "the quick brown fox jumps over a lazy dog and writes letters home to friends each day HELLO, NASA OK I".split(" ");
  const tally = { ok: 0, refused: 0 };
  for (let c = 0; c < 4000; c++) {
    const s = structuredClone(G.DEFAULT_SETTINGS);
    s.printer.model = pick(models);
    if (s.printer.model === "Custom") Object.assign(s.printer, { bed_x: U(80, 350), bed_y: U(80, 350), bed_z: U(60, 300) });
    s.paper.size = pick(papers);
    if (s.paper.size === "Custom") Object.assign(s.paper, { width: U(40, 400), height: U(40, 500) });
    s.paper.orientation = pick(["portrait", "landscape"]);
    Object.assign(s.paper, { x: Math.round(U(-120, 220)), y: Math.round(U(-250, 220)), margin: U(0, 40), slide: rng.random() < 0.5 });
    Object.assign(s.printer, { offset_x: U(-40, 40), offset_y: U(-40, 40), z_draw: U(2, 40) });
    s.printer.z_lift = s.printer.z_draw + U(0.9, 12);
    Object.assign(s.writing, { x_height: U(1.5, 8), wobble: U(0, 2), word_spacing: U(0.3, 3) });
    s.writing.line_spacing = s.writing.x_height * U(1.4, 4);
    const text = Array.from({ length: 1 + Math.floor(rng.random() * 6) }, () =>
      Array.from({ length: Math.floor(rng.random() * 25) }, () => pick(vocab)).join(" ")).join("\n");
    let out;
    try { out = run(s, text, c); } catch (e) {
      if (!(e instanceof G.WriteError)) throw new Error(`case ${c} crashed: ${e.stack}\n${JSON.stringify(s)}`);
      tally.refused++;
      continue;
    }
    const cfg = out.cfg;
    try { simulate(out.gcode, { ...s, printer: cfg.printer, paper: cfg.paper }); }
    catch (e) { throw new Error(`case ${c} UNSAFE: ${e.message}\n${JSON.stringify(s)}\n${JSON.stringify(text)}`); }
    tally.ok++;
  }
  test.diagnostic?.(`fuzz: ${tally.ok} files simulated safely, ${tally.refused} setups refused`);
  console.log(`fuzz: ${tally.ok} files simulated safely, ${tally.refused} setups refused`);
  assert.ok(tally.ok > 500, `too few accepted cases to mean anything: ${JSON.stringify(tally)}`);
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
  assert.deepStrictEqual(num.parts.map(p => p.word), ["2", "0", "2", "4"]); // digits one at a time too
  const [[th, time, pi, one]] = G.words("4th 7:30 3.14 5", 1);
  assert.deepStrictEqual(th.parts.map(p => p.word), ["4", "th"]);
  assert.deepStrictEqual(time.parts.map(p => p.word), ["7:", "3", "0"]);
  assert.deepStrictEqual(pi.parts.map(p => p.word), ["3.", "1", "4"]);
  assert.ok(!one.parts); // a single digit is already one piece
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

test("pen offset test: safe on every printer, and measuring it gives the offset back", () => {
  for (const model of Object.keys(G.PRINTERS).filter(m => G.PRINTERS[m])) {
    const s = withSet({ "printer.model": model, "printer.offset_x": 7, "printer.offset_y": -33 }); // the old offset must not matter
    const gcode = G.offsetTest(s), bedY = G.resolve(s).printer.bed_y;
    const cfg = G.resolve({ ...s, printer: { ...s.printer, offset_x: 0, offset_y: 0 }, paper: { ...s.paper, size: "A4", orientation: "portrait", x: 0, y: bedY - 297 } });
    simulate(gcode, cfg); // A4 in the back-left corner, nozzle = pen
    // XY moves: the pause position, then for each mark a travel to its start and one drawn move to its end
    const xy = gcode.split("\n").filter(l => /^G[01] X/.test(l)).map(l => l.match(/X(\S+) Y(\S+)/).slice(1).map(Number));
    assert.strictEqual(xy.length, 5, model);
    const [, [x0, lineY], [x1, lineY2], [tickX, t0], [tickX2, t1]] = xy;
    assert.ok(lineY === lineY2 && x1 - x0 > 50 && tickX === tickX2 && t0 - t1 === 20, `${model}: a horizontal line and a vertical mark`);
    assert.ok(x0 > 0 && x1 < 210, `${model}: on the paper`);
    for (const [ox, oy] of [[0, 0], [-4.5, -38], [12, 25.5]]) { // a pen this far from the nozzle draws the marks here:
      const fromTop = bedY - (lineY + oy), fromLeft = tickX + ox;
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
          if (cfg.printer.keepout && /Refusing a move/.test(e.message)) { refused++; continue; } throw new Error(`${where}: ${e.message}`); }
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
  const noSlide = G.resolve(withSet({ "paper.size": "A4", "paper.x": 23, "paper.y": -40, "writing.wobble": 0 }));
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
