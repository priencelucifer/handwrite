// Independent G-code simulator: knows only physical facts, not gcode.js's maths. Throws on any violation.
const assert = require("node:assert");
// Independent physical facts, in the printer's own coordinates: [x0, y0, x1, y1 (where the nozzle may go), max Z,
// nozzle keep-outs, dialect]. Bambu Lab by hand; every other printer straight from OrcaSlicer's data (printers.js),
// not from gcode.js's converted table, so the shift into the printer's coordinates is checked too.
const FACTS = {
  "Bambu Lab A1": [0, 0, 256, 256, 256, [], "bambu"], "Bambu Lab A1 mini": [0, 0, 180, 180, 180, [], "bambu"],
  "Bambu Lab P1P / P1S": [0, 0, 256, 256, 250, [[0, 0, 18, 28]], "bambu"], "Bambu Lab P2S": [0, 0, 256, 256, 256, [], "bambu"],
  "Bambu Lab X1 Carbon / X1E": [0, 0, 256, 256, 250, [[0, 0, 18, 28]], "bambu"],
};
for (const list of Object.values(require("../printers.js")))
  for (const [name, [x0, y0, x1, y1, z, , keep]] of Object.entries(list)) if (!FACTS[name]) FACTS[name] = [x0, y0, x1, y1, z, keep, "generic"];
const LINE_OK = /^(;[^\n]*|G90|G21|G28|M104 S0|G4 [SP]\d+|M17|M400 S1|M1006 S1|M1006 W|M1006 A\d+ B\d+ L\d+ C\d+ D\d+ M\d+ E\d+ F\d+ N\d+|G29\.2 S1|G29 A1 X\d+\.\d\d Y\d+\.\d\d I\d+\.\d\d J\d+\.\d\d|G[01]( X-?\d+\.\d\d Y-?\d+\.\d\d)?( Z-?\d+\.\d\d)?( F\d+)?)$/;
// Bed levelling: Bambu Studio's own A1 / A1 mini commands, nowhere else (other firmware levels differently or not at all)
const LEVELS = new Set(["Bambu Lab A1", "Bambu Lab A1 mini"]);

/** Simulate a G-code file; throws on any violation. s: the settings it was made from (for z, paper, offsets).
 *  opts.reach: a reach check (no pen, no paper): nothing may be drawn and no paper or pen pause is needed. */
function simulate(gcode, s, opts = {}) {
  const model = s.printer.model;
  const [X0, Y0, X1, Y1, bz, keepouts, dialect] = FACTS[model] || (model === "Custom" ? [0, 0, s.printer.bed_x, s.printer.bed_y, s.printer.bed_z, [], "generic"] : []);
  assert.ok(dialect, `unknown printer ${model}`);
  const { offset_x: ox, offset_y: oy } = s.printer;
  // Pauses: Bambu's G4 S (seconds); everywhere else G4 P (ms), since Klipper ignores S and would not wait at all.
  const pauses = [...gcode.matchAll(/^G4 ([SP])(\d+)$/gm)].map(m => [m[1], +m[2]]);
  if (dialect === "generic") {
    assert.ok(!/^G21$/m.test(gcode) && pauses.every(([u]) => u === "P"), `${model}: G21 or a G4 S in a file for this firmware`);
    if (!opts.reach) for (const sec of [s.printer.paper_pause_s, s.printer.pen_pause_s])
      assert.ok(pauses.some(([, v]) => v === Math.round(sec) * 1000), `${model}: no ${sec} s pause (as G4 P${Math.round(sec) * 1000})`);
  } else if (!opts.reach) for (const sec of [s.printer.paper_pause_s, s.printer.pen_pause_s])
    assert.ok(pauses.some(([u, v]) => u === "S" && v === Math.round(sec)), `${model}: no ${sec} s pause`);
  const zd = +s.printer.z_draw.toFixed(2), zl = +s.printer.z_lift.toFixed(2); // as written in the file
  // extra pressure: at most this much below the writing height, and only toward the front of where the pen was clamped
  const press = s.printer.press_bottom || 0;
  let clampY = null, downY = null; // where the pen was clamped; where the current stroke's pen-down happened
  const dry = s.printer.dry_run === true ? 8 : 0; // a dry run draws 8 mm above the writing height: the pen never touches
  const pw = s.paper.width, ph = s.paper.height; // already oriented by the caller
  let levelOn = false, homed = false, heaterOff = false, x = null, y = null, z = null, shift = 0, draws = 0, firstMotionAfterHome = null;
  const lines = gcode.split("\n");
  assert.strictEqual(lines.pop(), "", "file ends with a newline");
  for (const [n, line] of lines.entries()) {
    const where = `line ${n + 1}: ${line}`;
    assert.match(line, LINE_OK, `malformed ${where}`);
    const pass = /^; PASS \d+ of \d+: paper slid (-?\d+) mm/.exec(line);
    if (pass) shift = +pass[1];
    if (line.startsWith("; attach the pen") && clampY === null) clampY = y;
    if (line.startsWith(";")) continue;
    if (line === "G28") { homed = true; continue; }
    if (line.startsWith("G29")) { // after homing with the heater off, before the head goes anywhere (no paper, no pen yet)
      assert.ok(LEVELS.has(model) && !opts.reach && homed && heaterOff && x === null, `bed levelling where it can't be ${where}`);
      if (line === "G29.2 S1") { levelOn = true; continue; }
      assert.ok(levelOn, `levelling without the correction on ${where}`);
      const [, lx, ly, li, lj] = /X(\S+) Y(\S+) I(\S+) J(\S+)/.exec(line).map(Number);
      assert.ok(li > 0 && lj > 0 && lx >= X0 && ly >= Y0 && lx + li <= X1 + 1e-9 && ly + lj <= Y1 + 1e-9, `levelling off the bed ${where}`);
      for (const ko of keepouts) assert.ok(lx > ko[2] || lx + li < ko[0] || ly > ko[3] || ly + lj < ko[1], `levelling over a keep-out ${where}`);
      continue;
    }
    if (line === "M104 S0") { heaterOff = true; continue; } // the only temperature command allowed: nozzle heater off
    if (line.startsWith("M1006 A")) { // motor music: never while the pen may be on the paper; notes in a sane range
      assert.ok(z === null || z > zd + 1e-9 || draws === 0, `sound with the pen on the paper ${where}`);
      const ch = [...line.matchAll(/[ACE](\d+) [BDF](\d+) [LMN](\d+)/g)].map(m => m.slice(1).map(Number));
      for (const [n, d, v] of ch) // each channel; Bambu's own tunes go down to MIDI 37 and use 0 durations on resting channels
        assert.ok((n === 0 || (n >= 36 && n <= 84)) && d <= 200 && v <= 100, `odd note ${where}`);
      assert.ok(ch.length === 3 && Math.max(...ch.map(c => c[1])) > 0, `tune line without a duration ${where}`);
      continue;
    }
    if (line.startsWith("M")) continue;
    const m = Object.fromEntries([...line.matchAll(/([XYZF])(-?\d+(?:\.\d+)?)/g)].map(a => [a[1], +a[2]]));
    if (line.startsWith("G4")) { assert.ok(+line.slice(4) >= 0, where); continue; }
    if (!line.startsWith("G0") && !line.startsWith("G1")) continue;
    assert.ok(homed, `motion before homing: ${where}`);
    assert.ok(heaterOff, `motion before the nozzle heater is switched off: ${where}`);
    if (firstMotionAfterHome === null) firstMotionAfterHome = m;
    if ("F" in m) assert.ok(m.F > 0 && m.F <= 12000, `feed ${where}`);
    if ("Z" in m) {
      z = m.Z;
      assert.ok(z >= zd - press - 1e-9, `nozzle below writing height ${where}`);
      if (!("X" in m)) downY = y;
      assert.ok(z >= 2 && z <= bz, `Z outside the printer ${where}`);
    }
    if ("X" in m) {
      x = m.X; y = m.Y;
      assert.ok(z !== null, `XY move before any Z move ${where}`);
      assert.ok(x >= X0 && x <= X1 && y >= Y0 && y <= Y1, `nozzle off the bed ${where}`);
      for (const ko of keepouts) assert.ok(!(x >= ko[0] && x <= ko[2] && y >= ko[1] && y <= ko[3]), `nozzle in keep-out ${where}`);
      if (dry) assert.ok(z >= zd + dry - press - 1e-9, `dry run: a move with the pen near the paper ${where}`);
      if (line.startsWith("G0")) assert.ok(z >= zl + dry - 1e-9 || draws === 0, `travel with the pen down ${where}`);
      else {
        assert.ok(z <= zd + dry + 1e-9 && z >= zd + dry - press - 1e-9, `drawing move not at writing height ${where}`);
        assert.ok(zd + dry - z <= press * Math.max(0, Math.min(1, (clampY - downY) / s.paper.height)) + 0.011, // deeper only in front of where it was clamped
          `pen pressed down behind its clamping point ${where}`);
        draws++;
      }
      if (z <= zd + 1e-9) { // pen touches: must be over the plate AND on the paper (for this pass)
        const px = x - X0 + ox, py = y - Y0 + oy; // the paper's position is measured from the bed's front-left corner
        assert.ok(px >= 0 && px <= X1 - X0 && py >= 0 && py <= Y1 - Y0, `pen off the plate ${where}`);
        const left = s.paper.x, front = s.paper.y + shift;
        assert.ok(px >= left - 1e-6 && px <= left + pw + 1e-6 && py >= front - 1e-6 && py <= front + ph + 1e-6, `pen off the paper ${where}`);
      }
    }
  }
  assert.ok(homed, "never homed");
  if (opts.reach) assert.strictEqual(draws, 0, "a reach check draws nothing");
  assert.ok("Z" in firstMotionAfterHome && firstMotionAfterHome.Z >= zd + 10, "first move after homing must lift");
  assert.ok(z >= zl, "file ends with the pen up");
  return draws;
}

module.exports = { simulate };
