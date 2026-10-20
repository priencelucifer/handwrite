// Independent G-code simulator: knows only physical facts, not gcode.js's maths. Throws on any violation.
const assert = require("node:assert");
// Independent physical facts: [bed_x, bed_y, max Z, keep-out or null]
const FACTS = {
  "Bambu Lab A1": [256, 256, 256, null], "Bambu Lab A1 mini": [180, 180, 180, null],
  "Bambu Lab P1P / P1S": [256, 256, 250, [0, 0, 18, 28]], "Bambu Lab P2S": [256, 256, 256, null],
  "Bambu Lab X1 Carbon / X1E": [256, 256, 250, [0, 0, 18, 28]],
};
const LINE_OK = /^(;[^\n]*|G90|G21|G28|G4 [SP]\d+|M17|M400 S1|M1006 S1|M1006 W|M1006 A\d+ B\d+ L\d+ C0 D\d+ M0 E0 F\d+ N0|G[01]( X-?\d+\.\d\d Y-?\d+\.\d\d)?( Z-?\d+\.\d\d)?( F\d+)?)$/;

/** Simulate a G-code file; throws on any violation. s: the settings it was made from (for z, paper, offsets). */
function simulate(gcode, s) {
  const model = s.printer.model;
  const [bx, by, bz, ko] = FACTS[model] || [s.printer.bed_x, s.printer.bed_y, s.printer.bed_z, null];
  const { offset_x: ox, offset_y: oy } = s.printer;
  const zd = +s.printer.z_draw.toFixed(2), zl = +s.printer.z_lift.toFixed(2); // as written in the file
  const pw = s.paper.width, ph = s.paper.height; // already oriented by the caller
  let homed = false, x = null, y = null, z = null, shift = 0, draws = 0, firstMotionAfterHome = null;
  const lines = gcode.split("\n");
  assert.strictEqual(lines.pop(), "", "file ends with a newline");
  for (const [n, line] of lines.entries()) {
    const where = `line ${n + 1}: ${line}`;
    assert.match(line, LINE_OK, `malformed ${where}`);
    const pass = /^; PASS \d+ of \d+: paper slid (-?\d+) mm/.exec(line);
    if (pass) shift = +pass[1];
    if (line.startsWith(";")) continue;
    if (line === "G28") { homed = true; continue; }
    if (line.startsWith("M1006 A")) { // motor music: never while the pen may be on the paper; notes in a sane range
      assert.ok(z === null || z > zd + 1e-9 || draws === 0, `sound with the pen on the paper ${where}`);
      const [, n, d] = /A(\d+) B(\d+)/.exec(line).map(Number);
      assert.ok((n === 0 || (n >= 50 && n <= 84)) && d > 0 && d <= 200, `odd note ${where}`);
      continue;
    }
    if (line.startsWith("M")) continue;
    const m = Object.fromEntries([...line.matchAll(/([XYZF])(-?\d+(?:\.\d+)?)/g)].map(a => [a[1], +a[2]]));
    if (line.startsWith("G4")) { assert.ok(+line.slice(4) >= 0, where); continue; }
    if (!line.startsWith("G0") && !line.startsWith("G1")) continue;
    assert.ok(homed, `motion before homing: ${where}`);
    if (firstMotionAfterHome === null) firstMotionAfterHome = m;
    if ("F" in m) assert.ok(m.F > 0 && m.F <= 12000, `feed ${where}`);
    if ("Z" in m) {
      z = m.Z;
      assert.ok(z >= zd - 1e-9, `nozzle below writing height ${where}`);
      assert.ok(z >= 2 && z <= bz, `Z outside the printer ${where}`);
    }
    if ("X" in m) {
      x = m.X; y = m.Y;
      assert.ok(z !== null, `XY move before any Z move ${where}`);
      assert.ok(x >= 0 && x <= bx && y >= 0 && y <= by, `nozzle off the bed ${where}`);
      if (ko) assert.ok(!(x >= ko[0] && x <= ko[2] && y >= ko[1] && y <= ko[3]), `nozzle in keep-out ${where}`);
      if (line.startsWith("G0")) assert.ok(z >= zl - 1e-9 || draws === 0, `travel with the pen down ${where}`);
      else {
        assert.ok(Math.abs(z - zd) < 1e-9, `drawing move not at writing height ${where}`);
        draws++;
      }
      if (z <= zd + 1e-9) { // pen touches: must be over the plate AND on the paper (for this pass)
        const px = x + ox, py = y + oy;
        assert.ok(px >= 0 && px <= bx && py >= 0 && py <= by, `pen off the plate ${where}`);
        const left = s.paper.x, front = s.paper.y + shift;
        assert.ok(px >= left - 1e-6 && px <= left + pw + 1e-6 && py >= front - 1e-6 && py <= front + ph + 1e-6, `pen off the paper ${where}`);
      }
    }
  }
  assert.ok(homed, "never homed");
  assert.ok("Z" in firstMotionAfterHome && firstMotionAfterHome.Z >= zd + 10, "first move after homing must lift");
  assert.ok(z >= zl, "file ends with the pen up");
  return draws;
}

module.exports = { simulate };
