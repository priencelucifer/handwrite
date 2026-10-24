// Builds web/printers.js from OrcaSlicer's printer profiles (https://github.com/OrcaSlicer/OrcaSlicer, AGPL-3.0):
// for each printer model its printable area, height, firmware and bed exclusions. Facts only, read straight from
// the profiles (with `inherits` resolved). Run from the project folder: node web/tools/orca-printers.js
// Left out, with the reason printed: round (delta) beds, firmware that needs its own file format, and duplicates.
const fs = require("fs"), path = require("path");
const BASE = "https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/main/resources/profiles/";
const OUT = path.join(__dirname, "..", "printers.js");
const SKIP_VENDORS = new Set(["OrcaFilamentLibrary", "blacklist", "Custom"]);
// Bambu Lab models gcode.js already knows by hand (sounds, the P1/X1 cutter corner): not taken from here.
const BAMBU_DONE = /^Bambu Lab (A1|A1 mini|P1P|P1S|P2S|X1|X1 Carbon|X1E)$/;
const VENDOR_NAMES = { BBL: "Bambu Lab" }; // Orca's folder name -> the name people know
const FLAVORS = new Set(["marlin", "marlin2", "klipper", "reprapfirmware", "repetier"]);
// Need a file format of their own (.gx, .g3drem, Griffin headers): plain G-code isn't run as is.
const OWN_FORMAT = { Dremel: /./, Flashforge: /Guider 2s|Adventurer 3|Adventurer 4|Artemis/, UltiMaker: /S5/ };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error(String(r.status)); return await r.text(); }
    catch (e) { if (i >= tries) throw new Error(`${url}: ${e.message}`); await sleep(600 * (i + 1)); }
  }
}
async function pool(items, n, f) {
  const out = []; let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await f(items[i]); } }));
  return out;
}
const json = t => { try { return t && JSON.parse(t); } catch { return null; } };
const url = (...parts) => BASE + parts.map(p => p.split("/").map(encodeURIComponent).join("/")).join("/");

/** "0x0,220x0" or ["0x0", "220x0"] (Orca writes both) -> closed polygons [[x, y], ...]; a polygon ends where it returns to its start. */
function polygons(v) {
  const pts = (Array.isArray(v) ? v.join(",") : String(v || "")).split(",").map(s => s.trim()).filter(Boolean)
    .map(s => s.split("x").map(Number));
  if (pts.some(p => p.length !== 2 || !p.every(Number.isFinite))) return null;
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (cur.length && p[0] === cur[0][0] && p[1] === cur[0][1]) { if (cur.length >= 3) out.push(cur); cur = []; continue; }
    if (!cur.length || p[0] !== cur[cur.length - 1][0] || p[1] !== cur[cur.length - 1][1]) cur.push(p);
  }
  if (cur.length >= 3) out.push(cur);
  return out;
}
/** An axis-aligned rectangle [x0, y0, x1, y1] if the polygon is one, else null. */
function rect(poly) {
  if (!poly || poly.length !== 4) return null;
  const xs = [...new Set(poly.map(p => p[0]))], ys = [...new Set(poly.map(p => p[1]))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}
const inside = (poly, x, y) => { // even-odd rule
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Bed exclusions inside the area -> [usable area, keep-outs]. Conservative: on a 0.5 mm grid, a cell is blocked if any of
 *  its corners, edge midpoints or centre is in an exclusion. sets: one list of polygons per profile variant (taken
 *  together with the even-odd rule, so a frame works); the variants' exclusions add up.
 *  The usable area is the bounding box of the free cells; blocked cells left inside it become keep-out rectangles. */
function exclusions(area, sets) {
  const flat = p => { const xs = p.map(q => q[0]), ys = p.map(q => q[1]); return !(Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys)); };
  sets = sets.map(set => set.filter(p => !flat(p))).filter(set => set.length);
  if (!sets.length) return [area, []];
  const S = 0.5, [ax0, ay0, ax1, ay1] = area, nx = Math.round((ax1 - ax0) / S), ny = Math.round((ay1 - ay0) / S);
  // each variant's exclusions together (even-odd), then the variants together (union)
  const inExcl = (x, y) => sets.some(set => set.reduce((c, p) => c !== inside(p, x, y), false));
  const blocked = Array.from({ length: ny }, (_, j) => Array.from({ length: nx }, (_, i) => {
    const x0 = ax0 + i * S, y0 = ay0 + j * S;
    for (const fx of [0.001, 0.5, 0.999]) for (const fy of [0.001, 0.5, 0.999]) if (inExcl(x0 + fx * S, y0 + fy * S)) return true;
    return false;
  }));
  let i0 = nx, j0 = ny, i1 = -1, j1 = -1;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!blocked[j][i]) { i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
  if (i1 < 0) return null;
  const used = blocked.map(r => r.slice()), keep = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (!used[j][i]) continue;
    let w = 0; while (i + w <= i1 && used[j][i + w]) w++;
    let h = 1; while (j + h <= j1 && Array.from({ length: w }, (_, k) => used[j + h][i + k]).every(Boolean)) h++;
    for (let jj = j; jj < j + h; jj++) for (let ii = i; ii < i + w; ii++) used[jj][ii] = false;
    keep.push([ax0 + i * S, ay0 + j * S, ax0 + (i + w) * S, ay0 + (j + h) * S]);
  }
  return [[ax0 + i0 * S, ay0 + j0 * S, ax0 + (i1 + 1) * S, ay0 + (j1 + 1) * S], keep];
}
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

(async () => {
  const listing = JSON.parse(await get("https://api.github.com/repos/OrcaSlicer/OrcaSlicer/contents/resources/profiles"));
  const vendors = listing.filter(f => f.type === "file" && f.name.endsWith(".json")).map(f => f.name.slice(0, -5)).filter(v => !SKIP_VENDORS.has(v));
  const models = new Map(), left = [];
  for (const vendor of vendors) {
    const idx = json(await get(url(vendor + ".json")));
    if (!idx || !idx.machine_list) continue;
    const files = await pool(idx.machine_list, 16, async m => json(await get(url(vendor, m.sub_path))));
    const byName = new Map(files.filter(Boolean).map(j => [j.name, j]));
    const full = (j, d = 0) => (!j || d > 12 ? {} : { ...(j.inherits ? full(byName.get(j.inherits), d + 1) : {}), ...j });
    for (const j of files) {
      if (!j || j.instantiation !== "true") continue;
      const m = full(j), name = m.printer_model;
      if (!name) continue;
      (models.get(name) || models.set(name, { vendor, variants: [] }).get(name)).variants.push(m);
    }
    process.stderr.write(`${vendor}: ${files.length} profiles\n`);
  }
  const out = {};
  for (const [model, { vendor, variants }] of [...models].sort((a, b) => a[1].vendor.localeCompare(b[1].vendor) || a[0].localeCompare(b[0]))) {
    const why = reason => left.push(`${vendor} / ${model}: ${reason}`);
    if (BAMBU_DONE.test(model)) continue;
    if (/COPY MODE|MIRROR MODE/i.test(model)) { why("an IDEX duplicate mode"); continue; }
    if (/IR3|BabyBelt/i.test(model)) { why("belt printer: its bed is a conveyor and Z is tilted"); continue; }
    if (/^The Positron$/.test(model)) { why("prints upside down: a pen holder can't point at the plate"); continue; }
    if (OWN_FORMAT[vendor] && OWN_FORMAT[vendor].test(model)) { why("needs its own file format"); continue; }
    const flavors = new Set(variants.map(v => v.gcode_flavor));
    if ([...flavors].some(f => !FLAVORS.has(f))) { why(`firmware ${[...flavors].join("/")}`); continue; }
    if (variants.some(v => v.printer_structure === "delta")) { why("round (delta) bed"); continue; }
    // the area every variant (nozzle size, mode) and every nozzle of a multi-nozzle printer can reach
    let area = null, plate = null, height = Infinity, bad = null;
    const excl = new Map(); // one set of exclusion polygons per distinct variant
    for (const v of variants) {
      const polys = [v.printable_area, ...(Array.isArray(v.extruder_printable_area) ? v.extruder_printable_area : [])].map(polygons);
      polys.forEach((p, k) => {
        const r = p && p.length === 1 ? rect(p[0]) : null;
        if (!r) { bad = "printable area isn't a rectangle"; return; }
        area = area ? intersect(area, r) : r;
        if (k === 0) plate = plate ? intersect(plate, r) : r; // the plate itself: printable_area, not one nozzle's reach
      });
      for (const h of [v.printable_height, ...(Array.isArray(v.extruder_printable_height) ? v.extruder_printable_height : [])]) {
        const n = parseFloat(h); if (Number.isFinite(n)) height = Math.min(height, n);
      }
      const e = polygons(v.bed_exclude_area);
      if (e === null) { bad = "unreadable bed exclusion"; break; }
      excl.set(JSON.stringify(e), e);
      if (bad) break;
    }
    if (bad) { why(bad); continue; }
    if (!area || area[2] - area[0] < 50 || area[3] - area[1] < 50 || !(height >= 50)) { why("bed or height too small to write on"); continue; }
    const ex = exclusions(area, [...excl.values()]);
    if (!ex) { why("bed exclusions cover everything"); continue; }
    const [use, keep] = ex;
    if (keep.length > 8) { why("too many bed exclusions"); continue; }
    if (use[2] - use[0] < 50 || use[3] - use[1] < 50) { why("too little bed left after its exclusions"); continue; }
    const r = v => Math.round(v * 100) / 100;
    const shown = VENDOR_NAMES[vendor] || vendor;
    const key = model.toLowerCase().startsWith(shown.toLowerCase().split(" ")[0]) ? model : `${shown} ${model}`;
    const flavor = flavors.has("klipper") ? "klipper" : [...flavors][0];
    const entry = [...use.map(r), r(height), flavor, keep.map(k => k.map(r))];
    if (plate.some((v, k) => v !== use[k])) entry.push(plate.map(r)); // the plate reaches past where the nozzle may go
    (out[shown] ||= {})[key] = entry;
  }
  const count = Object.values(out).reduce((n, v) => n + Object.keys(v).length, 0);
  const src = `// Generated by tools/orca-printers.js from OrcaSlicer's printer profiles (github.com/OrcaSlicer/OrcaSlicer, AGPL-3.0).
// Per vendor, per printer: [x0, y0, x1, y1 (where the nozzle may go, in the printer's own coordinates, mm), max Z,
// firmware, nozzle keep-outs [[x0, y0, x1, y1], ...], and the plate [x0, y0, x1, y1] when it is bigger than where the
// nozzle may go (exclusions at its edges, or a multi-nozzle printer)]. ${count} printers. Don't edit: re-run the tool.
(function (root, data) { if (typeof module === "object" && module.exports) module.exports = data; else root.HW_PRINTERS = data; })(
  typeof self !== "undefined" ? self : this,
${JSON.stringify(out, null, 0).replace(/\],"/g, '],\n"').replace(/\},"/g, '},\n"')});
`;
  fs.writeFileSync(OUT, src);
  console.log(`wrote ${OUT}: ${count} printers from ${Object.keys(out).length} vendors`);
  console.log(`left out ${left.length}:\n  ${left.join("\n  ")}`);
})().catch(e => { console.error(e); process.exit(1); });
