// node word_parity.js cases   -> writes word_cases.json
// node word_parity.js compare -> compares engine.js words with word_parity.json (from word_parity.py)
"use strict";
const fs = require("fs");
const path = require("path");
const WEB = path.join(__dirname, "..", "..");
const E = require(path.join(WEB, "engine.js"));
require(path.join(WEB, "weights.js"));
require(path.join(WEB, "styles.js"));

if (process.argv[2] === "cases") {
  const words = ["hello", "it's", "dog.", "Tuesday,", "fox!", "minimum", "the", "quiet", "a", ".", "Hi;", "jab:"];
  const cases = [];
  for (const style of ["0", "3", "6", "9", "12"])
    for (const word of words)
      for (const [seed, bias] of [[0, 0.75], [1, 0.75], [4294967295, 0.75], [7, 0], [8, 2]]) cases.push({ style, word, seed, bias });
  fs.writeFileSync(path.join(__dirname, "word_cases.json"), JSON.stringify(cases));
  console.log(cases.length, "cases");
} else {
  const model = E.loadModel(E.b64ToBytes(globalThis.HW_WEIGHTS_B64));
  const presets = Object.fromEntries(globalThis.HW_PRESETS.map(p => [p.name, E.decodePreset(p)]));
  const hands = {};
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "word_parity.json"), "utf8"));
  let same = 0, diffCount = 0;
  const bad = [];
  for (const c of ref) {
    const h = hands[c.style] ??= new E.Hand(model, presets[c.style]);
    const js = h.word(c.word, c.seed, c.bias);
    let d = js.length === c.strokes.length ? 0 : Infinity;
    if (d === 0) js.forEach((s, i) => {
      if (s.length !== c.strokes[i].length) d = Infinity;
      else s.forEach((p, j) => { d = Math.max(d, Math.abs(p[0] - c.strokes[i][j][0]), Math.abs(p[1] - c.strokes[i][j][1])); });
    });
    if (d < 1e-3) same++; else { diffCount++; bad.push(`${c.style} ${JSON.stringify(c.word)} seed ${c.seed} bias ${c.bias}: js ${js.length} strokes/${js.flat().length} pts, py ${c.strokes.length}/${c.strokes.flat().length}, maxd ${d}`); }
  }
  console.log(`identical (<1e-3): ${same}/${ref.length}; differing: ${diffCount}`);
  bad.forEach(b => console.log("  " + b));
}
