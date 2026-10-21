// Writes the real handwriting shown on the guide page (index.html) into its STROKES block, using the same engine and
// styles as the app. Run after changing the engine or styles: node web/tools/guide-strokes.js
const fs = require("fs"), path = require("path");
const WEB = path.join(__dirname, "..");
const E = require(path.join(WEB, "engine.js")); require(path.join(WEB, "weights.js")); require(path.join(WEB, "styles.js"));
const model = E.loadModel(E.b64ToBytes(globalThis.HW_WEIGHTS_B64)), base = globalThis.HW_PRESETS.map(E.decodePreset);
// [preset, slant, width, neatness] as in app.js CATALOG
const style = (b, slant, width) => new E.Hand(model, { chars: base[b].chars, strokes: E.transformPrimer(base[b].strokes, slant, width) });
const NEAT1 = style(0, 0, 1);
const r1 = v => Math.round(v * 10) / 10;

/** Lines of text -> {w, h, paths: ["M x y L ...", ...]} in px, x-height = xh px. */
function write(hand, lines, bias, xh, seed) {
  const strokes = [];
  let w = 0;
  lines.forEach((line, li) => {
    let x = 0;
    for (const [k, word] of line.split(" ").entries()) {
      const ink = hand.word(E.cleanText(word).clean, seed + 31 * li + k, bias), y0 = (li * 3.4 + 2.2) * xh;
      for (const s of ink) strokes.push(s.map(([px, py]) => [x + px * xh, y0 - py * xh]));
      x += (Math.max(0, ...ink.flat().map(p => p[0])) + 0.9 + 0.25 * Math.sin(seed + k)) * xh;
    }
    w = Math.max(w, x);
  });
  const ys = strokes.flat().map(p => p[1]), top = Math.min(...ys) - 4;
  return { w: Math.ceil(w), h: Math.ceil(Math.max(...ys) - top + 4),
    paths: strokes.map(s => "M" + s.map(([x, y]) => `${r1(x + 4)} ${r1(y - top)}`).join("L")) };
}

const data = {
  hero: write(NEAT1, ["Dear friend,", "this letter was written", "by my 3D printer."], 1.8, 13, 11),
  neat: [0.3, 1.0, 1.8].map(b => ({ label: b.toFixed(1), ...write(NEAT1, ["handwriting"], b, 12, 5) })),
  styles: [["Neat 1", style(0, 0, 1), 1.8], ["Italic 1", style(0, 15, 1), 1.7], ["Rounded 1", style(0, 5, 1.25), 1.4], ["Casual 1", style(2, 0, 1), 0.8]]
    .map(([label, hand, b]) => ({ label, ...write(hand, ["Handwriting"], b, 12, 7) })),
};
const file = path.join(WEB, "index.html"), html = fs.readFileSync(file, "utf8");
const re = /(\/\*STROKES\*\/).*?(\/\*END\*\/)/s;
if (!re.test(html)) throw new Error("index.html has no /*STROKES*/ ... /*END*/ block");
fs.writeFileSync(file, html.replace(re, (_, a, b) => `${a}${JSON.stringify(data)}${b}`));
console.log(`wrote ${JSON.stringify(data).length} bytes of strokes into index.html`);
