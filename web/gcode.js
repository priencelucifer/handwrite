/* Page layout, pass planning and G-code for a 3D printer with a pen holder (Bambu Lab, and the printers OrcaSlicer knows).
 * Printer facts from OrcaSlicer: printers.js (HW_PRINTERS), loaded before this file.
 * Port of write.py (incl. the safety-audit fixes). Classic script: global HWGcode, or require() in Node.
 * Units: mm. Page coords: origin at the paper's top-left (the edge toward the BACK of the printer), y toward
 * the front. Bed coords: X right, Y toward the back, origin front-left. pen = nozzle + offset. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HWGcode = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  class WriteError extends Error {}

  // [bed_x, bed_y, max Z, nozzle keep-outs [[x0, y0, x1, y1], ...], origin [x, y], dialect, plate]. Layout works in bed
  // coordinates from 0 to bed_x / bed_y; origin is where that 0 is in the printer's own coordinates (added only when
  // a coordinate is written). P1/X1: front-left the toolhead presses the filament-cutter lever against the frame.
  // dialect "bambu": the plain G-code BambuPlot proved on the A1 (G4 S pauses, Bambu's tunes). "generic": G4 P
  // pauses in ms (Klipper ignores G4 S) and no G21 (Klipper doesn't know it; every firmware here defaults to mm).
  // plate: how far the plate reaches past where the nozzle may go [left, front, right, back] (exclusions at its edges,
  // a second nozzle): the offset test's paper goes into the plate's own corner.
  const CUTTER = [0, 0, 18, 28];
  const PRINTERS = {
    "Bambu Lab A1": [256, 256, 256, [], [0, 0], "bambu", [0, 0, 0, 0]],
    "Bambu Lab A1 mini": [180, 180, 180, [], [0, 0], "bambu", [0, 0, 0, 0]],
    "Bambu Lab P1P / P1S": [256, 256, 250, [CUTTER], [0, 0], "bambu", [0, 0, 0, 0]],
    "Bambu Lab P2S": [256, 256, 256, [], [0, 0], "bambu", [0, 0, 0, 0]],
    "Bambu Lab X1 Carbon / X1E": [256, 256, 250, [CUTTER], [0, 0], "bambu", [0, 0, 0, 0]],
  };
  const PRINTER_GROUPS = [["Bambu Lab", Object.keys(PRINTERS)]]; // vendor -> printer names, for the printer list
  { // every other printer OrcaSlicer knows: [x0, y0, x1, y1, max Z, firmware, keep-outs], in its own coordinates
    const orca = typeof HW_PRINTERS !== "undefined" ? HW_PRINTERS : typeof require === "function" ? require("./printers.js") : {};
    for (const [vendor, list] of Object.entries(orca)) {
      const names = [];
      for (const [name, [x0, y0, x1, y1, z, , keep, plate = [x0, y0, x1, y1]]] of Object.entries(list)) {
        if (Object.hasOwn(PRINTERS, name)) continue;
        PRINTERS[name] = [x1 - x0, y1 - y0, Math.min(z, 1000) /* our moves stay low anyway */, keep.map(([a, b, c, d]) => [a - x0, b - y0, c - x0, d - y0]),
          [x0, y0], "generic", [x0 - plate[0], y0 - plate[1], plate[2] - x1, plate[3] - y1]];
        names.push(name);
      }
      const group = PRINTER_GROUPS.find(g => g[0] === vendor);
      if (group) group[1].push(...names); else if (names.length) PRINTER_GROUPS.push([vendor, names]);
    }
    PRINTERS.Custom = null;
    PRINTER_GROUPS.push(["Other", ["Custom"]]);
  }
  const PAPERS = { "A4": [210, 297], "A5": [148, 210], "A6": [105, 148], "US Letter": [215.9, 279.4],
    "Card 4x6 in": [101.6, 152.4], "Custom": null };
  const BED_INSET = 3;    // text stays this far inside the plate edges
  const CLEARANCE = 15;   // above z_draw while placing the paper
  const MAX_WORD = 25;    // letters; keeps every word well inside the model's 1200-step limit
  const MAX_PAGES = 50;
  const MIN_PEN_LIFT = 1; // between writing height and pen-up height
  const SLIDE_HOVER = 5;  // above z_draw while the user slides the paper under the pen
  const DRY_RUN_LIFT = 8; // a dry run writes this far above the writing height, so the pen never reaches the paper
  const MARGIN_LINE_GAP = 2; // ruled paper: writing starts this far right of the printed margin line
  const PEN2 = 2;         // stroke.pen for text marked *like this*: written after a pen change
  const REACH_FEED = 1500, REACH_WAIT_S = 3; // reach check: slow enough to watch and stop, a pause at each corner
  const WORD_SIZE = [0.3, 4]; // a word's own size (wd.size), times the letter size

  // Motor "music" (Bambu M1006): each line plays three channels at once, A/B/L, C/D/M and E/F/N = MIDI note (0 = rest),
  // duration in 10 ms, volume 0-100. Only printers known to play it: officially the A1 and A1 mini; confirmed by users
  // on the P2S. Not the X1 series.
  // start and finish are Bambu's own tunes, copied line for line from each printer's start and end G-code in Bambu Studio
  // (resources/profiles/BBL/machine/<printer> 0.4 nozzle template machine_start_gcode / machine_end_gcode).
  // Bambu's G-code has no pause tune, so pause and resume are ours.
  const notes = s => s.trim().split("\n").map(l => l.match(/\d+/g).map(Number)); // "A0 B10 L100 ..." -> [0, 10, 100, ...]
  const BAMBU_TUNES = {
    "Bambu Lab A1": {
      start: notes(`
        A0 B10 L100 C37 D10 M60 E37 F10 N60
        A0 B10 L100 C41 D10 M60 E41 F10 N60
        A0 B10 L100 C44 D10 M60 E44 F10 N60
        A0 B10 L100 C0 D10 M60 E0 F10 N60
        A43 B10 L100 C46 D10 M70 E39 F10 N80
        A0 B10 L100 C0 D10 M60 E0 F10 N80
        A0 B10 L100 C43 D10 M60 E39 F10 N80
        A0 B10 L100 C0 D10 M60 E0 F10 N80
        A0 B10 L100 C41 D10 M80 E41 F10 N80
        A0 B10 L100 C44 D10 M80 E44 F10 N80
        A0 B10 L100 C49 D10 M80 E49 F10 N80
        A0 B10 L100 C0 D10 M80 E0 F10 N80
        A44 B10 L100 C48 D10 M60 E39 F10 N80
        A0 B10 L100 C0 D10 M60 E0 F10 N80
        A0 B10 L100 C44 D10 M80 E39 F10 N80
        A0 B10 L100 C0 D10 M60 E0 F10 N80
        A43 B10 L100 C46 D10 M60 E39 F10 N80`),
      finish: notes(`
        A0 B20 L100 C37 D20 M40 E42 F20 N60
        A0 B10 L100 C44 D10 M60 E44 F10 N60
        A0 B10 L100 C46 D10 M80 E46 F10 N80
        A44 B20 L100 C39 D20 M60 E48 F20 N60
        A0 B10 L100 C44 D10 M60 E44 F10 N60
        A0 B10 L100 C0 D10 M60 E0 F10 N60
        A0 B10 L100 C39 D10 M60 E39 F10 N60
        A0 B10 L100 C0 D10 M60 E0 F10 N60
        A0 B10 L100 C44 D10 M60 E44 F10 N60
        A0 B10 L100 C0 D10 M60 E0 F10 N60
        A0 B10 L100 C39 D10 M60 E39 F10 N60
        A0 B10 L100 C0 D10 M60 E0 F10 N60
        A0 B10 L100 C48 D10 M60 E44 F10 N80
        A0 B10 L100 C0 D10 M60 E0 F10 N80
        A44 B20 L100 C49 D20 M80 E41 F20 N80
        A0 B20 L100 C0 D20 M60 E0 F20 N80
        A0 B20 L100 C37 D20 M30 E37 F20 N60`),
    },
    "Bambu Lab A1 mini": {
      start: notes(`
        A0 B0 L100 C37 D10 M100 E37 F10 N100
        A0 B0 L100 C41 D10 M100 E41 F10 N100
        A0 B0 L100 C44 D10 M100 E44 F10 N100
        A0 B10 L100 C0 D10 M100 E0 F10 N100
        A43 B10 L100 C39 D10 M100 E46 F10 N100
        A0 B0 L100 C0 D10 M100 E0 F10 N100
        A0 B0 L100 C39 D10 M100 E43 F10 N100
        A0 B0 L100 C0 D10 M100 E0 F10 N100
        A0 B0 L100 C41 D10 M100 E41 F10 N100
        A0 B0 L100 C44 D10 M100 E44 F10 N100
        A0 B0 L100 C49 D10 M100 E49 F10 N100
        A0 B0 L100 C0 D10 M100 E0 F10 N100
        A44 B10 L100 C39 D10 M100 E48 F10 N100
        A0 B0 L100 C0 D10 M100 E0 F10 N100
        A0 B0 L100 C39 D10 M100 E44 F10 N100
        A0 B0 L100 C0 D10 M100 E0 F10 N100
        A43 B10 L100 C39 D10 M100 E46 F10 N100`),
      finish: notes(`
        A0 B20 L100 C37 D20 M100 E42 F20 N100
        A0 B10 L100 C44 D10 M100 E44 F10 N100
        A0 B10 L100 C46 D10 M100 E46 F10 N100
        A44 B20 L100 C39 D20 M100 E48 F20 N100
        A0 B10 L100 C44 D10 M100 E44 F10 N100
        A0 B10 L100 C0 D10 M100 E0 F10 N100
        A0 B10 L100 C39 D10 M100 E39 F10 N100
        A0 B10 L100 C0 D10 M100 E0 F10 N100
        A0 B10 L100 C44 D10 M100 E44 F10 N100
        A0 B10 L100 C0 D10 M100 E0 F10 N100
        A0 B10 L100 C39 D10 M100 E39 F10 N100
        A0 B10 L100 C0 D10 M100 E0 F10 N100
        A44 B10 L100 C0 D10 M100 E48 F10 N100
        A0 B10 L100 C0 D10 M100 E0 F10 N100
        A44 B20 L100 C41 D20 M100 E49 F20 N100
        A0 B20 L100 C0 D20 M100 E0 F20 N100
        A0 B20 L100 C37 D20 M100 E37 F20 N100`),
    },
    "Bambu Lab P2S": {
      start: notes(`
        A53 B9 L50 C53 D9 M50 E53 F9 N50
        A56 B9 L50 C56 D9 M50 E56 F9 N50
        A61 B9 L50 C61 D9 M50 E61 F9 N50
        A53 B9 L50 C53 D9 M50 E53 F9 N50
        A56 B9 L50 C56 D9 M50 E56 F9 N50
        A61 B18 L50 C61 D18 M50 E61 F18 N50`),
      finish: notes(`
        A53 B10 L50 C53 D10 M50 E53 F10 N50
        A57 B10 L50 C57 D10 M50 E57 F10 N50
        A0 B15 L0 C0 D15 M0 E0 F15 N0
        A53 B10 L50 C53 D10 M50 E53 F10 N50
        A57 B10 L50 C57 D10 M50 E57 F10 N50
        A0 B15 L0 C0 D15 M0 E0 F15 N0
        A48 B10 L50 C48 D10 M50 E48 F10 N50
        A0 B15 L0 C0 D15 M0 E0 F15 N0
        A60 B10 L50 C60 D10 M50 E60 F10 N50`),
    },
  };
  const SOUND_PRINTERS = new Set(Object.keys(BAMBU_TUNES));
  // Bed levelling: only on printers whose maker levels the bed in its own start G-code (Bambu Studio's; OrcaSlicer's
  // profiles for the rest, read in October 2026), with that same command, but right after homing with the pen out, the
  // nozzle cold (the pen holder sits beside it; Bambu cools it to 140 C just so the plate takes no harm) and the paper not
  // yet in, and never saved (no M500 or SAVE_CONFIG): the printer's own calibration stays as it was. Method -> printers:
  //   "G29 A1", "G29 A": Bambu's G29.2 S1, then G29 over the writing.  "G29": Marlin probes the bed.
  //   "M420 S1": Marlin turns on the levelling saved in the printer.  "BED_MESH_CALIBRATE": Klipper probes the bed (also
  //   for makers whose own G29 macro does that).  "BED_MESH_PROFILE LOAD=default": Klipper's saved mesh.  "M555": Prusa's
  //   Buddy firmware, the writing's area, then G29.  "G28": the Prusa MK3S levels as it homes (G28 W homes without).
  // Marlin and Buddy then get M420 Z0: the correction at every height, as the pen writes ~10 mm up, where their usual
  // fade has ended it (it lasts until the printer restarts). After probing, both heaters go off again in case the
  // firmware warmed them for it. Left out: Lulzbot (probes through the nozzle touching metal washers, which needs a hot,
  // wiped nozzle), tool changers, Bambu's other printers (OrcaSlicer has no Bambu start code for them), Wanhao France's M2
  // boards (Marlin by OrcaSlicer, Klipper by their start code), and printers whose maker's start code doesn't level (no
  // probe, or levelling inside a start macro Handplot can't see).
  const LEVEL_METHODS = [
    ["G29 A1", /^Bambu Lab A1( mini)?$/],
    ["G29 A", /^Bambu Lab (P1P \/ P1S|X1 Carbon \/ X1E)$/],
    ["G29", /^(Anycubic Kobra Neo|Artillery (Genius Pro|Hornet|Sidewinder X2)|BIQU BX|Creality Ender-3 V2 Neo|Eryone ER20|Wanhao D12-300|WEMAKE3D (PhoenixProV1|TinyBotV1))$/],
    ["M420 S1", /^(Anycubic Kobra 2 Neo|Creality Ender-3 S1 Plus|Elegoo Neptune( 2| 2D| 2S| 3| 3 Max| 3 Plus| 3 Pro| X)?|Sovol SV06( Plus)?|Wanhao D9-[345]00 MK[123]( BLTouch kit)?)$/],
    ["BED_MESH_CALIBRATE", /^(Creality Ender-3 V3 KE|Elegoo Centauri( Carbon)? 2|Eryone Thinker X400|Goofoo GP1|Qidi (X-Max 3|X-Max 4|X-Plus 3|X-Plus 5|X-Smart 3)|TwoTrees SK1|Wanhao France D12 (230|300|500) PRO SMARTPAD .+)$/],
    ["BED_MESH_PROFILE LOAD=default", /^(FlyingBear S1|InfiMech TX( Hardened Steel Nozzle)?|Vzbot (235|330) AWD)$/],
    ["M555", /^Prusa (MINI( IS)?|MK3\.5|MK4S?( HF| MMU3( HF)?)?|XL|CORE One( HF| L| L HF| MMU3)?)$/],
    ["G28", /^Prusa MK3S$/],
  ];
  const LEVEL_PRINTERS = new Map(Object.keys(PRINTERS).flatMap(name => LEVEL_METHODS.filter(([, re]) => re.test(name)).map(([m]) => [name, m])));
  const LEVEL_SAVED = new Set(["M420 S1", "BED_MESH_PROFILE LOAD=default"]); // these only switch on what the printer measured before
  const LEVEL_PAD = 3; // mm around the writing
  // [MIDI note or 0 for a rest, duration in 10 ms] -> the same note on all three channels at full volume: as loud as the motors go
  const loud = steps => steps.map(([n, d]) => { const v = n ? 100 : 0; return [n, d, v, n, d, v, n, d, v]; });
  const TUNES = { pause: loud([[76, 14], [0, 8], [76, 14], [0, 8], [76, 22]]), resume: loud([[67, 10], [72, 20]]) };
  const tuneOf = (model, name) => (BAMBU_TUNES[model] || {})[name] || TUNES[name];
  const tune = (model, name) => ["M17", "M400 S1", "M1006 S1",
    ...tuneOf(model, name).map(s => "M1006 " + s.map((v, i) => "ABLCDMEFN"[i] + v).join(" ")), "M1006 W"];

  // Pen offset: the "Plotter" pen holder by Elli (MakerWorld 1247876) on an A1, from the offset test (short mark 106, long line 85).
  // paper x/y: placePaper() of these defaults, so the first page sits where the pen reaches.
  const DEFAULT_SETTINGS = {
    printer: { model: "Bambu Lab A1", bed_x: 256, bed_y: 256, bed_z: 150, offset_x: 1, offset_y: -25,
      paper_pause_s: 30, pen_pause_s: 30, shift_pause_s: 45, z_draw: 10, z_lift: 12, press_bottom: 0, level: true,
      z_feed: 600, draw_feed: 1500, travel_feed: 6000, settle_ms: 60, sounds: true, dry_run: false },
    // press_bottom: mm the pen goes lower by the bottom of the page than where it was clamped (no bed levelling with a
    // pen fitted, so a bed a little lower toward the front leaves the last lines faint). level: on LEVEL_PRINTERS, level
    // the bed the printer's own way after homing, while the pen is still out, and write with the printer's correction on
    // ruling: mm between the printed lines of ruled paper (0 = plain); first_line: mm from the top edge to the first
    // printed line; margin_line: mm from the left edge to the printed margin line (0 = none)
    paper: { size: "A5", orientation: "portrait", x: 55, y: 10, width: 148, height: 210, margin: 15, margin_y: 15, slide: false,
      ruling: 0, first_line: 20, margin_line: 0 },
    writing: { style: "s:neat-1", bias: 1.8, wobble: 1, x_height: 2.8, line_spacing: 8, word_spacing: 1, header: "", page_numbers: false,
      code: false, indent: 0.55 }, // code: the text is a program (words(): _ and * written); indent: x-heights per space a line starts with
  };
  // Every number that reaches the G-code: [min, max]. Values must be real, finite numbers.
  const LIMITS = {
    printer: { bed_x: [50, 1000], bed_y: [50, 1000], bed_z: [50, 1000], offset_x: [-100, 100], offset_y: [-100, 100],
      z_draw: [2, 200], z_lift: [3, 200], z_feed: [60, 1200], draw_feed: [60, 12000], travel_feed: [600, 12000],
      paper_pause_s: [5, 600], pen_pause_s: [5, 600], shift_pause_s: [5, 600], settle_ms: [0, 2000], press_bottom: [0, 2] },
    paper: { x: [-1000, 1000], y: [-1000, 1000], width: [30, 600], height: [30, 600], margin: [0, 50], margin_y: [0, 80],
      ruling: [0, 30], first_line: [0, 600], margin_line: [0, 300] },
    writing: { bias: [0, 2], wobble: [0, 2], x_height: [1, 20], line_spacing: [1, 100], word_spacing: [0.2, 5], indent: [0, 1.5] },
  };

  /** Refuse any setting that could put an unsafe or garbled command into the G-code. */
  function validate(cfg) {
    for (const [section, keys] of Object.entries(LIMITS))
      for (const [key, [lo, hi]] of Object.entries(keys)) {
        const v = cfg[section][key];
        if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi)
          throw new WriteError(`Setting ${key.replace(/_/g, " ")} = ${JSON.stringify(v)} must be a number from ${lo} to ${hi}.`);
      }
    const pr = cfg.printer, w = cfg.writing;
    if ([pr.sounds, cfg.paper.slide, pr.dry_run, pr.level, w.page_numbers, w.code].some(v => typeof v !== "boolean"))
      throw new WriteError("Settings sounds, slide, dry run, bed levelling, page numbers and code must be on or off.");
    if (!["portrait", "landscape"].includes(cfg.paper.orientation) || typeof w.style !== "string")
      throw new WriteError("Paper orientation must be portrait or landscape, and style a name.");
    if (typeof w.header !== "string" || w.header.length > 80) throw new WriteError("The header must be text, 80 characters at most.");
    if (round2(pr.z_draw) - round2(pr.press_bottom) < 2)
      throw new WriteError("Writing height less the extra pressure at the bottom must stay at least 2 mm.");
    if (round2(pr.z_lift) - round2(pr.z_draw) < MIN_PEN_LIFT)
      throw new WriteError(`Pen-up height must be at least ${MIN_PEN_LIFT} mm above the writing height.`);
    if (Math.max(pr.z_draw + CLEARANCE, pr.z_lift + 10 + (pr.dry_run ? DRY_RUN_LIFT : 0)) > pr.bed_z)
      throw new WriteError(`Writing height is too high for this printer (max Z ${pr.bed_z} mm).`);
    const p = cfg.paper;
    if (2 * p.margin > p.width - 20 || 2 * p.margin_y > p.height - 20)
      throw new WriteError("The borders are too big for this paper: leave at least 20 mm to write on.");
    if (w.line_spacing < 1.5 * w.x_height)
      throw new WriteError("Line spacing is too small for the letter size: lines would write over each other.");
    if (p.ruling > 0 && p.ruling < 1.5 * w.x_height)
      throw new WriteError(`The letters are too big for lines ${p.ruling} mm apart: use ${rulingLetters(p.ruling)} mm letters or smaller.`);
    if (p.ruling > 0 && p.first_line >= p.height) throw new WriteError("The first printed line must be on the paper: measure it from the top edge.");
  }
  const round2 = v => Math.round(v * 100) / 100;

  /** User settings -> working config: preset bed and paper sizes filled in, orientation applied, validated.
   *  Never mutates the input. */
  function resolve(settings) {
    const cfg = {};
    for (const s of ["printer", "paper", "writing"]) cfg[s] = { ...DEFAULT_SETTINGS[s], ...(settings && settings[s]) };
    const pr = cfg.printer, p = cfg.paper;
    if (!Object.hasOwn(PRINTERS, pr.model) || !Object.hasOwn(PAPERS, p.size))
      throw new WriteError(`Unknown printer ${JSON.stringify(pr.model)} or paper ${JSON.stringify(p.size)}`);
    pr.keepouts = []; pr.origin = [0, 0]; pr.dialect = "generic"; pr.plate = [0, 0, 0, 0];
    if (PRINTERS[pr.model]) [pr.bed_x, pr.bed_y, pr.bed_z, pr.keepouts, pr.origin, pr.dialect, pr.plate] = PRINTERS[pr.model];
    if (PAPERS[p.size]) [p.width, p.height] = PAPERS[p.size];
    const [short, long] = [p.width, p.height].sort((a, b) => a - b);
    [p.width, p.height] = p.orientation === "landscape" ? [long, short] : [short, long];
    validate(cfg);
    return cfg;
  }

  /** Page rectangle [left, top, right, bottom] where the pen tip is over the plate and the nozzle inside
   *  its travel limits. */
  function reach(cfg, inset = 0) {
    const p = cfg.paper, [x0, y0, x1, y1] = penRange(cfg, inset);
    const top = p.y + p.height; // paper's back edge in bed Y
    return [x0 - p.x, top - y1, x1 - p.x, top - y0];
  }
  /** Bed rectangle [x0, y0, x1, y1] the pen tip can reach over the plate: a pen in front of the nozzle can't
   *  reach the back of the plate, one to the left can't reach the right side. */
  function penRange(cfg, inset = 0) {
    const pr = cfg.printer;
    return [Math.max(0, pr.offset_x) + inset, Math.max(0, pr.offset_y) + inset,
      Math.min(pr.bed_x, pr.bed_x + pr.offset_x) - inset, Math.min(pr.bed_y, pr.bed_y + pr.offset_y) - inset];
  }
  /** Default paper position {x, y}: centred on the part of the plate the pen reaches. Paper taller than that goes
   *  just far enough back for writing to start at the top border (the rest is written in later passes), but
   *  hangs over the back of the plate no more than centring it on the plate would. Paper that fits hangs over by at
   *  most its (blank) top border. */
  function placePaper(cfg) {
    const p = cfg.paper, [x0, y0, x1, y1] = penRange(cfg, BED_INSET);
    const top = p.height - 2 * p.margin_y <= y1 - y0 ? (y0 + y1 + p.height) / 2
      : Math.min(y1 + p.margin_y, (cfg.printer.bed_y + p.height) / 2);
    return { x: Math.round((x0 + x1 - p.width) / 2), y: Math.floor(top - p.height) };
  }

  /** Where text goes: inside the borders (margin: left/right, margin_y: top/bottom) and the part the pen reaches.
   *  The bottom stops where the pen would leave the plate; with paper.slide, lines further down are written in
   *  later passes after the paper is slid back (planPasses). */
  function writingArea(cfg) {
    const p = cfg.paper, m = p.margin, my = p.margin_y, [l, t, r, b] = reach(cfg, BED_INSET);
    const marginLine = p.ruling > 0 && p.margin_line > 0 ? p.margin_line + MARGIN_LINE_GAP : 0; // ruled paper: right of its margin line
    return [Math.max(l, m, marginLine), Math.max(t, my), Math.min(r, p.width - m), p.slide ? p.height - my : Math.min(b, p.height - my)];
  }

  /** Where lines go: {first: baseline of a sheet's first line, step: line to line, ruled}. On ruled paper every line
   *  sits on a printed line: the first one with room for tall letters below the top of the writing area. */
  function lineGrid(cfg) {
    const p = cfg.paper, want = writingArea(cfg)[1] + 2 * cfg.writing.x_height; // room above for capitals and ascenders
    if (!(p.ruling > 0)) return { first: want, step: cfg.writing.line_spacing, ruled: false };
    return { first: p.first_line + Math.max(0, Math.ceil((want - p.first_line) / p.ruling - 1e-9)) * p.ruling, step: p.ruling, ruled: true };
  }
  /** Letter size (x-height, mm) that suits lines this far apart: about 1/3.4 of the spacing, as people write. */
  const rulingLetters = ruling => Math.floor(ruling / 3.4 * 10) / 10;
  const hasHeader = cfg => cfg.writing.header.trim() !== "" || cfg.writing.page_numbers;

  /** Rough page capacity before any handwriting is generated. charWidth: the style's average letter width in
   *  x-heights; paragraphs: from words() (optional) to say how many lines this text needs.
   *  Returns {lines, perLine, words, needed}. An estimate: real words vary in width. */
  function capacity(cfg, charWidth, paragraphs = []) {
    const w = cfg.writing, xh = w.x_height;
    const [l, , r, b] = writingArea(cfg), grid = lineGrid(cfg), y0 = grid.first + (hasHeader(cfg) ? grid.step : 0);
    // Lines closer than ~3.1 letter heights (tall letters over long tails, plus the gap) get pushed apart in layout;
    // on ruled paper they keep to the printed lines.
    const lines = Math.max(0, Math.floor((b - 1.3 * xh - y0) / (grid.ruled ? grid.step : Math.max(grid.step, 3.1 * xh))) + 1); // descenders below the last
    const all = paragraphs.flat(), letters = all.reduce((n, x) => n + x.word.length * (x.parts ? 1.45 : 1), 0) /* block capitals are wider */;
    const avgLetters = all.length >= 5 ? letters / all.length : 4.7; // typical English word length
    const usable = Math.max(0, r - l - 1.2 * xh * w.wobble); // wobble: ragged starts and early line breaks
    const wordMm = avgLetters * charWidth * xh, gapMm = w.word_spacing * xh;
    const perLine = Math.max(1, Math.floor((usable + gapMm) / (wordMm + gapMm)));
    const needed = paragraphs.reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
    return { lines, perLine, words: lines * perLine, needed };
  }

  const shifted = (cfg, shift) => ({ ...cfg, paper: { ...cfg.paper, y: cfg.paper.y + shift } });

  // ---- Symbols the model never learned (it writes "#" as random letters and has no < > { } = + * / and the like) are
  // drawn from hand-made strokes instead: each time a little differently, in the page's own slant and letter height.
  // Design units: x in x-heights; y in bands: 0 baseline, 1 x-height, 2 the top of the hand's tall letters, -1 one
  // x-height below the baseline. A point [x, y, 1] is a corner (the pen turns sharply); others are passed smoothly.
  const ring = (cx, cy, rx, ry, from = 90, turn = 380) => Array.from({ length: 10 }, (_, i) => {
    const a = (from + turn * i / 9) * Math.PI / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
  const mirror = (strokes, w) => strokes.map(st => st.map(([x, y, c]) => [w - x, y, c]));
  const BRACE = [[[0.66, 1.9], [0.42, 1.8], [0.33, 1.5], [0.33, 1.05], [0.26, 0.82], [0.04, 0.72, 1], [0.26, 0.62], [0.33, 0.4], [0.33, -0.05], [0.42, -0.36], [0.66, -0.45]]];
  const BRACKET = [[[0.56, 1.9], [0.16, 1.9, 1], [0.16, -0.45, 1], [0.58, -0.45]]];
  const GLYPHS = {
    "#": [[[0.42, 1.7], [0.24, 0.02]], [[0.86, 1.7], [0.68, 0.02]], [[0.02, 1.15], [1.05, 1.2]], [[-0.04, 0.55], [0.98, 0.6]]],
    "<": [[[0.72, 1.0], [0.04, 0.5, 1], [0.74, 0.02]]],
    ">": [[[0.04, 1.0], [0.72, 0.5, 1], [0.02, 0.02]]],
    "=": [[[0.02, 0.68], [0.82, 0.72]], [[0.04, 0.28], [0.86, 0.31]]],
    "+": [[[0.0, 0.5], [0.86, 0.54]], [[0.44, 0.94], [0.42, 0.08]]],
    "*": [[[0.36, 0.98], [0.34, 0.24]], [[0.04, 0.8], [0.66, 0.42]], [[0.04, 0.42], [0.66, 0.8]]],
    "/": [[[0.74, 1.85], [0.0, -0.3]]],
    "\\": [[[0.0, 1.85], [1.1, -0.3]]], // leaning well back: even a hand slanted far forward can't stand it upright
    "|": [[[0.12, 1.9], [0.1, -0.55]]],
    "_": [[[0.0, -0.12], [0.95, -0.1]]],
    "{": BRACE, "}": mirror(BRACE, 0.7), "[": BRACKET, "]": mirror(BRACKET, 0.74),
    "%": [[[0.08, 0.0], [0.86, 1.7]], ring(0.22, 1.38, 0.2, 0.26), ring(0.72, 0.32, 0.2, 0.26)],
    "&": [[[0.9, 0.0], [0.55, 0.35], [0.25, 0.8], [0.18, 1.2], [0.25, 1.55], [0.42, 1.68], [0.58, 1.55], [0.56, 1.3], [0.4, 1.05],
      [0.15, 0.75], [0.04, 0.42], [0.1, 0.12], [0.32, 0.0], [0.58, 0.08], [0.78, 0.32], [0.9, 0.62]]],
    "^": [[[0.04, 1.2], [0.32, 1.75, 1], [0.6, 1.2]]],
    "~": [[[0.0, 0.48], [0.2, 0.66], [0.45, 0.55], [0.66, 0.42], [0.88, 0.58]]],
    "@": [[[0.82, 0.78], [0.62, 0.92], [0.42, 0.82], [0.34, 0.55], [0.45, 0.3], [0.66, 0.28], [0.8, 0.45], [0.84, 0.8]],
      [[0.84, 0.86], [0.82, 0.38], [0.98, 0.26], [1.12, 0.42], [1.16, 0.75], [1.02, 1.08], [0.68, 1.22], [0.3, 1.1], [0.06, 0.78],
        [0.04, 0.38], [0.26, 0.04], [0.62, -0.06], [0.92, 0.0]]],
    "$": [[[0.78, 1.4], [0.55, 1.55], [0.25, 1.48], [0.12, 1.2], [0.3, 0.95], [0.62, 0.75], [0.8, 0.45], [0.68, 0.12], [0.38, 0.02], [0.06, 0.15]],
      [[0.47, 1.78], [0.43, -0.3]]],
    "Q": [ring(0.55, 0.95, 0.52, 0.95, 100, 370), [[0.62, 0.4], [1.1, -0.12]]], // an O begun at the top, and its tail
    "X": [[[0.04, 1.92], [0.96, 0.0]], [[0.94, 1.92], [0.0, 0.02]]],
    "Z": [[[0.06, 1.9], [0.98, 1.93, 1], [0.04, 0.02, 1], [1.02, 0.0]]],
    // digits: the model saw few and garbles them (85 -> &5). Their y is a share of the digit's height (FIGURE_HEIGHT).
    "0": [ring(0.42, 0.5, 0.4, 0.5, 100, 362)], // begun at the top and just closed: no hook where it meets
    "1": [[[0.12, 0.84], [0.34, 1.0, 1], [0.3, 0.0]]],
    "2": [[[0.04, 0.75], [0.2, 0.95], [0.45, 1.0], [0.66, 0.88], [0.68, 0.68], [0.5, 0.45], [0.02, 0.02, 1], [0.8, 0.03]]],
    "3": [[[0.04, 0.85], [0.3, 1.0], [0.58, 0.95], [0.66, 0.78], [0.52, 0.6], [0.26, 0.53, 1], [0.58, 0.47], [0.72, 0.28], [0.6, 0.06], [0.32, 0.0], [0.02, 0.1]]],
    "4": [[[0.5, 1.0], [0.04, 0.34, 1], [0.86, 0.34]], [[0.66, 0.7], [0.62, 0.0]]],
    "5": [[[0.14, 0.98], [0.09, 0.56, 1], [0.38, 0.62], [0.66, 0.52], [0.74, 0.28], [0.58, 0.05], [0.3, 0.0], [0.04, 0.1]], [[0.15, 0.99], [0.7, 1.01]]],
    "6": [[[0.6, 1.0], [0.3, 0.8], [0.1, 0.45], [0.12, 0.13], [0.38, 0.0], [0.64, 0.1], [0.68, 0.32], [0.46, 0.48], [0.18, 0.4], [0.1, 0.28]]],
    "7": [[[0.02, 0.98], [0.76, 1.0, 1], [0.48, 0.5], [0.3, 0.0]]],
    "8": [[[0.62, 0.86], [0.4, 1.0], [0.14, 0.92], [0.16, 0.66], [0.42, 0.52], [0.68, 0.36], [0.64, 0.08], [0.38, 0.0], [0.08, 0.1], [0.12, 0.34],
      [0.4, 0.52], [0.62, 0.68], [0.64, 0.86]]],
    "9": [[[0.64, 0.82], [0.44, 1.0], [0.16, 0.94], [0.08, 0.74], [0.26, 0.58], [0.56, 0.62], [0.68, 0.84, 1], [0.64, 0.4], [0.56, 0.0]]],
  };
  const GLYPH_CHARS = Object.keys(GLYPHS).join("");
  const GLYPH_SPLIT = new RegExp(`([${GLYPH_CHARS.replace(/[\\\]\[^-]/g, "\\$&")}])`);
  const FIGURE_HEIGHT = 0.82, FIGURE_WIDTH = 1.35; // digits: a little lower than the hand's tall letters, and as drawn, wider
  // drawn too where they stand on their own: points beside a drawn digit (3.14, 7:30, 85,), and x (x = 12, x[i]), which
  // the model writes alone as a stray tick
  Object.assign(GLYPHS, { "x": [[[0.04, 1.0], [0.74, 0.0]], [[0.72, 1.0], [0.02, 0.02]]],
    ".": [[[0.02, 0.04], [0.1, 0.13], [0.17, 0.04], [0.07, -0.01]]], ",": [[[0.1, 0.14], [0.15, 0.04], [0.11, -0.12], [0.0, -0.32]]],
    ":": [[[0.02, 0.68], [0.1, 0.77], [0.17, 0.68], [0.07, 0.63]], [[0.02, 0.04], [0.1, 0.13], [0.17, 0.04], [0.07, -0.01]]], ";": [[[0.06, 0.68], [0.14, 0.77], [0.21, 0.68], [0.11, 0.63]], [[0.12, 0.12], [0.12, 0.0], [0.02, -0.28]]] });
  const HAND = { slant: 0.1, asc: 2.1 }; // a typical hand, when the page has no written words to measure
  const size = st => st.reduce((n, p, i) => n + (i && Math.hypot(p[0] - st[i - 1][0], p[1] - st[i - 1][1])), 0); // a stroke's length

  /** Seeded standard-normal numbers (mulberry32, Box-Muller): a drawn symbol looks the same each time for its seed. */
  function normals(seed) {
    let a = seed | 0;
    const u = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  }
  /** A smooth line through pts (centripetal Catmull-Rom: no loops or overshoot), a point about every `step`. */
  function spline(pts, step) {
    const n = pts.length, d = (a, b) => Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
    const L = (a, b, ta, tb, t) => [a[0] + (b[0] - a[0]) * (t - ta) / (tb - ta), a[1] + (b[1] - a[1]) * (t - ta) / (tb - ta)];
    const P = [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]], ...pts, [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]]];
    const out = [[pts[0][0], pts[0][1]]];
    for (let i = 1; i < n; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]], t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
      const m = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (let s = 1; s <= m; s++) {
        const t = t1 + (t2 - t1) * s / m, A1 = L(p0, p1, 0, t1, t), A2 = L(p1, p2, t1, t2, t), A3 = L(p2, p3, t2, t3, t);
        out.push(L(L(A1, A2, 0, t2, t), L(A2, A3, t1, t3, t), t1, t2, t));
      }
    }
    return out;
  }
  /** A drawn symbol's strokes, like a written word's: x-height units, baseline 0, y up, starting at x = 0.
   *  hand: {slant, asc} of the page's writing (handOf); k: wobble (0 = drawn exactly as designed). */
  function glyph(ch, seed, hand = HAND, k = 1) {
    const fig = /[0-9]/.test(ch), wide = fig ? FIGURE_WIDTH : 1, N = normals(seed);
    const band = fig ? y => y * FIGURE_HEIGHT * hand.asc : y => y <= 1 ? y : 1 + (y - 1) * (hand.asc - 1);
    const all = GLYPHS[ch].flat(), y0 = Math.min(...all.map(p => p[1])), h = Math.max(...all.map(p => p[1])) - y0 || 1;
    const scale = (a, b) => k * clip(Math.hypot((Math.max(...a) - Math.min(...a)) * wide, band(Math.max(...b)) - band(Math.min(...b))) / 1.7, 0.3, 1.2);
    const z = scale(all.map(p => p[0]), all.map(p => p[1])); // a small symbol (=, x, a point) wavers less than a tall digit
    // no two written alike: width and height, lean, angle and place on the line; where the middle falls (the waist of
    // an 8, the bar of a 4), whether the top comes out wider than the bottom, and how the middle bows sideways
    // (one writer's figures differ only a little: much more and a row of them looks shaky and uneven)
    const sx = clip(1 + N() * 0.04 * k, 0.92, 1.08), sy = clip(1 + N() * 0.03 * k, 0.94, 1.06), sh = hand.slant + clip(N() * 0.03 * k, -0.06, 0.06);
    const rot = clip(N() * 0.015 * k, -0.035, 0.035), lift = clip(N() * 0.02 * k, -0.05, 0.05), cr = Math.cos(rot), sr = Math.sin(rot);
    const waist = clip(N() * 0.035 * k, -0.07, 0.07), flare = clip(N() * 0.06 * k, -0.12, 0.12), bow = clip(N() * 0.025 * z, -0.05, 0.05);
    const mid = (Math.min(...all.map(p => p[0])) + Math.max(...all.map(p => p[0]))) / 2;
    const warp = ([x, y, c]) => { const t = (y - y0) / h; return [x + flare * (x - mid) * (t - 0.5) + bow * h * Math.sin(Math.PI * t), y + waist * h * 4 * t * (1 - t), c]; };
    const out = GLYPHS[ch].map((st, si) => {
      // a straight line by hand is never quite straight: a midpoint in each long one lets it bend a little
      const end = i => i === 0 || i === st.length - 1 || st[i][2], pts = [];
      st.forEach((p, i) => {
        if (i && end(i - 1) && end(i) && Math.hypot(p[0] - st[i - 1][0], p[1] - st[i - 1][1]) > 0.5) pts.push([(p[0] + st[i - 1][0]) / 2, (p[1] + st[i - 1][1]) / 2]);
        pts.push(p);
      });
      const ox = si ? N() * 0.03 * z : 0, oy = si ? N() * 0.03 * z : 0; // the pen put down again never lands quite where it should
      const zs = scale(st.map(p => p[0]), st.map(p => p[1])), j = 0.018 * zs; // and a small stroke (the rings of a %) wavers less
      const moved = pts.map(warp).map(([x, y, c]) => [x * wide + N() * j + ox, band(y) + N() * j + oy, c]), line = [];
      for (const [i, n] of size(st) > 0.5 ? [[0, 1], [moved.length - 1, moved.length - 2]] : []) { // and stops a little early, or runs on (a dot or a comma stays one)
        const p = moved[i], q = moved[n], len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1, e = clip(N() * 0.03 * zs, -0.2 * len, Math.min(0.05, 0.2 * len));
        moved[i] = [p[0] + (p[0] - q[0]) / len * e, p[1] + (p[1] - q[1]) / len * e, p[2]];
      }
      for (let a = 0, b = 1; b < moved.length; b++) // smooth from corner to corner
        if (moved[b][2] || b === moved.length - 1) { line.push(...spline(moved.slice(a, b + 1), 0.04).slice(line.length ? 1 : 0)); a = b; }
      return line.map(([x, y]) => { const u = (x + sh * y) * sx, v = y * sy + lift; return [u * cr - v * sr, u * sr + v * cr]; });
    });
    let x0 = Infinity;
    for (const st of out) for (const p of st) x0 = Math.min(x0, p[0]);
    return out.map(st => st.map(([x, y]) => [x - x0, y]));
  }
  /** How the page's hand writes, measured on its written words so drawn symbols match it: {slant: sideways lean per
   *  unit of height of its upright strokes, asc: how tall its tall letters are, in x-heights}. */
  function handOf(paragraphs, inkOf) {
    let n = 0, lean = 0, len = 0;
    const tops = [];
    for (const para of paragraphs) for (const wd of para) for (const part of wd.parts || [wd]) {
      const ink = !part.glyph && n < 60 && inkOf(part);
      if (!ink || !ink.length) continue;
      n++;
      let top = -Infinity;
      for (const st of ink) for (let i = 0; i < st.length; i++) {
        top = Math.max(top, st[i][1]);
        const dx = i && st[i][0] - st[i - 1][0], dy = i && st[i][1] - st[i - 1][1], l = Math.hypot(dx, dy);
        if (Math.abs(dy) > 2 * Math.abs(dx)) { lean += dx / dy * l; len += l; }
      }
      if (/[bdfhklABDEFHKLMNPRT]/.test(part.word)) tops.push(top); // has a tall letter: shows how tall they are
    }
    tops.sort((a, b) => a - b);
    return { slant: len ? clip(lean / len, -0.3, 0.45) : HAND.slant, asc: tops.length ? clip(tops[tops.length >> 1], 1.6, 2.6) : HAND.asc };
  }
  /** How a word is written: [the word] or pieces of it, each written on its own and set side by side. Drawn symbols
   *  go one by one. ALL-CAPS runs go letter by letter: the model learned mostly lowercase and garbles them, but writes
   *  single capitals well (punctuation stays with its letter: "YOU," -> Y, O, U,). Digits are drawn symbols, and so is
   *  a point standing on its own between them ("7:30" -> 7, :, 3, 0). In code a long name is cut after its last
   *  punctuation that fits (else at the limit), as the model writes MAX_WORD letters at most. */
  function pieces(word, code) {
    const out = [];
    for (const run of word.split(GLYPH_SPLIT).filter(Boolean)) {
      if (GLYPHS[run] || /^[.,:;]+$/.test(run)) { out.push(...run); continue; } // (x alone is drawn too)
      const parts = isCaps(run) ? run.match(/[^A-Z]*[A-Z][^A-Z]*/g) : [run];
      for (let part of parts) {
        while (code && part.length > MAX_WORD) {
          const cut = Math.max(...Array.from(part.slice(0, MAX_WORD), (c, i) => /[A-Za-z0-9]/.test(c) ? 0 : i + 1)) || MAX_WORD;
          out.push(part.slice(0, cut));
          part = part.slice(cut);
        }
        out.push(part);
      }
    }
    return out;
  }

  /** Clean text -> paragraphs of words, each word with a seed that depends only on the page seed, the word and
   *  how often it already appeared, so editing one word keeps the rest of the page's handwriting.
   *  Markup (kept by cleanText(text, "_*")): _like this_ is underlined, *like this* is written with a second pen;
   *  each runs to its closing mark or the end of the line. Words get underline: true / pen: PEN2.
   *  A line that starts with spaces is indented by them (para.indent). code: the text is a program: no markup (_ and *
   *  are written), and a line's run-on lines are indented 4 spaces more (para.runOn). */
  function words(text, pageSeed, code = false) {
    const seen = new Map();
    return text.split("\n").map(para => {
      let underline = false, pen2 = false;
      const out = [];
      for (const token of para.split(" ")) {
        let word = "", u = false, p = false;
        const literal = code || /^[_*]+$/.test(token); // a mark always touches a word: "5 * 3" or "a _ b" means the symbol
        for (const ch of token) {
          if (ch === "_" && !literal) underline = !underline;
          else if (ch === "*" && !literal) pen2 = !pen2;
          else { if (!word) { u = underline; p = pen2; } word += ch; } // a word takes the marks open at its first letter
        }
        if (!word) continue;
        const n = (seen.get(word) || 0) + 1;
        seen.set(word, n);
        const w = { word, key: `${word}|${n}`, seed: hash(`${pageSeed}|${word}|${n}`) }; // key: the same whatever the page seed
        const parts = pieces(word, code);
        if (parts.length > 1) w.parts = parts.map((ch, i) => ({ word: ch, seed: hash(`${pageSeed}|${word}|${n}|${i}`), ...(GLYPHS[ch] && { glyph: true }) }));
        else if (GLYPHS[word]) w.glyph = true;
        if (u) w.underline = true;
        if (p) w.pen = PEN2;
        out.push(w);
      }
      const indent = para.length - para.trimStart().length;
      if (code) Object.assign(out, { indent, runOn: indent + 4 });
      else if (indent) out.indent = indent; // typed text: the line starts further in, the lines it runs on to don't
      return out;
    });
  }
  /** Words of the header line on sheet k (0-based): [left: the header text, right: "Page k+1"]. Every sheet's header
   *  is written afresh, like a person writing it again. text: cleaned like the page text. */
  function headerWords(text, pageNumbers, seed, k) {
    const s = hash(`${seed}|header|${k}`);
    const mark = ws => ws.map(w => ({ ...w, key: `header${k}:${w.key}` })); // never the same key as a word of the text
    return [text.trim() ? mark(words(text.replace(/\n/g, " "), s).flat()) : [], pageNumbers ? mark(words(`Page ${k + 1}`, s).flat()) : []];
  }
  const isCaps = word => (word.match(/[A-Z]/g) || []).length >= 2 && !/[a-z]/.test(word);
  const LETTER_GAP = 0.18; // x-heights between block capitals
  const FIGURE_GAP = 0.3;  // x-heights where a drawn figure comes closest to its neighbour

  /** A word's ink, assembled from its separately written pieces (pieces()); drawn symbols in this hand (handOf).
   *  gap(figures): a random gap, between drawn symbols (figures) or between block capitals. */
  function wordInk(wd, inkOf, gap, hand, k) {
    const inkFor = part => part.glyph ? glyph(part.word, part.seed, hand, k) : inkOf(part);
    if (!wd.parts) return inkFor(wd);
    const out = [];
    let x = 0, prev = null;
    for (const part of wd.parts) {
      const ink = inkFor(part), figures = !!prev && (part.glyph || prev.glyph), g = gap(figures);
      // beside a drawn symbol, spaced by the shapes as a hand does it, not by their boxes, so a row of figures looks
      // evenly spaced (a 7's bar may reach over a point's head, a 1 stands close to the 0 before it)
      if (figures) x = besideAt(out, ink, g) ?? x;
      let w = 0;
      for (const st of ink) for (const p of st) w = Math.max(w, p[0]);
      for (const st of ink) out.push(st.map(([a, b]) => [a + x, b]));
      x += w + g; // where the next piece goes box to box (block capitals), or if it shares no height with these
      prev = part;
    }
    return out;
  }
  /** How far right ink b (from x = 0) must go so it comes no closer than gap to ink a at any height they share (give or
   *  take a little), or undefined if they share none. */
  function besideAt(a, b, gap) {
    const BIN = 0.08, right = new Map();
    for (const st of a) for (const [x, y] of st) { const r = Math.round(y / BIN); if (!(right.get(r) >= x)) right.set(r, x); }
    let at;
    for (const st of b) for (const [x, y] of st) for (let r = Math.round(y / BIN) - 1; r <= Math.round(y / BIN) + 1; r++)
      if (right.has(r)) at = Math.max(at ?? -Infinity, right.get(r) - x + gap);
    return at;
  }
  function hash(s) { // FNV-1a, 32 bit
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  const clip = (v, a, b) => Math.min(Math.max(v, a), b);

  /** A word as a hand writes it this time: a little bigger or smaller, more or less slanted, at a slight angle (all
   *  scaled by wobble k). Returns {ink, width}: strokes starting at x = 0, in x-height units. */
  function shapeWord(wd, inkOf, k, N, hand) {
    const ws = clip(1 + N() * 0.04 * k, 0.9, 1.1), shear = clip(N() * 0.05 * k, -0.12, 0.12), rot = clip(N() * 0.012 * k, -0.03, 0.03);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const gap = figures => (figures ? clip(FIGURE_GAP + N() * 0.04 * k, 0.2, 0.4) : Math.max(0.06, LETTER_GAP + N() * 0.06 * k));
    let ink = wordInk(wd, inkOf, gap, hand, k).map(st => st.map(([sx, sy]) => { const a = (sx + shear * sy) * ws, b = sy * ws; return [a * cr - b * sr, a * sr + b * cr]; }));
    let xmin = Infinity, width = 0;
    for (const st of ink) for (const pt of st) xmin = Math.min(xmin, pt[0]);
    ink = ink.map(st => st.map(([a, b]) => [a - xmin, b])); // the word still starts where it is placed
    for (const st of ink) for (const pt of st) width = Math.max(width, pt[0]);
    return { ink, width };
  }

  /** Place words on the page. paragraphs: from words(); inkOf(w) -> strokes ([[x,y],...] in x-height units,
   *  baseline 0, y up) for that word; rng: {normal()}. Returns lines, each a list of strokes in page mm.
   *  A stroke written with the second pen has .pen = PEN2. Each line also has .baseline (mm from the top edge) and
   *  .words: [{seed, key, box: [x0, y0, x1, y1], s0, s1}], where each word landed and its strokes (to click one in the preview).
   *  A word can carry its own changes: wd.size (times the letter size; wrapping and spacing follow) and wd.dx, wd.dy
   *  (mm right/down from where it would land; the rest of the page stays where it was). */
  /** Single page: throws if the text doesn't fit. */
  function layout(paragraphs, inkOf, cfg, rng) { return layoutPages(paragraphs, inkOf, cfg, rng, 1)[0] || []; }

  /** Like layout, but text that doesn't fit continues on the next sheet, up to maxPages. Returns pages of lines.
   *  opts.header(k) -> [left words, right words] for sheet k (headerWords): written as the sheet's first line. */
  function layoutPages(paragraphs, inkOf, cfg, rng, maxPages = MAX_PAGES, opts = {}) {
    const w = cfg.writing, xh = w.x_height;
    const [areaLeft, top, right, bottom] = writingArea(cfg);
    if (right - areaLeft < 8 * xh || Math.min(bottom, reach(cfg, BED_INSET)[3]) - top < 4 * xh)
      throw new WriteError("Too little of the paper is on the build plate: drag the paper onto the plate.");
    const grid = lineGrid(cfg);
    const [rl, rt, rr] = reach(cfg), moveArea = [Math.max(0, rl), Math.max(0, rt), Math.min(cfg.paper.width, rr), cfg.paper.height];
    // How a person writes on blank paper: the page leans a little, the left margin creeps sideways, each line
    // starts, slopes, bows and ends a little differently, gaps vary, size drifts. Scaled by wobble (0 = none).
    // On ruled paper the printed lines keep the writing level: far less up-and-down, and a line that has to move
    // goes down whole lines.
    const k = w.wobble, vk = grid.ruled ? 0.3 * k : k, N = () => rng.normal(), hand = handOf(paragraphs, inkOf);
    const snap = d => grid.ruled ? Math.ceil(d / grid.step - 1e-9) * grid.step : d;
    const room = xh * k;
    let pageTilt = N() * 0.008 * vk, marginCreep = N() * 0.008 * k; // each sheet leans its own way
    let walk = 0, scale = 1, y = grid.first; // first baseline, leaving room for capitals and ascenders
    // Lowest ink so far on this sheet per COL-wide column; new lines keep `gap` mm (pen centre to centre) below it.
    let floor = new Map();
    const gap = Math.max(0.8, 0.3 * xh), near = Math.ceil(gap / COL);
    // Ruled paper: a person writes on the next printed line even if a tail meets a tall letter there, so tips may cross
    // a little (a third of a letter height); only more than that skips a printed line.
    const clear = grid.ruled ? -xh / 3 : gap;
    const pages = [];
    let lines = [], onSheet = 0; // body lines on this sheet (the header doesn't count)
    const tooMuch = () => new WriteError(maxPages > 1
      ? `Too much text: it needs more than ${maxPages} pages. Use smaller letters or bigger paper.`
      : "Text doesn't fit on the page: use smaller letters or less text.");
    const wordGap = lxh => Math.max(0.4, w.word_spacing * (1 + N() * 0.15 * k)) * lxh;

    /** The next line at y: where it starts and may end, its size, and its baseline (it slopes and bows). */
    function lineFrame() {
      walk = 0.7 * walk + N() * 0.3 * xh * k; // mean-reverting: lines drift either side and get pulled back
      const stray = clip(marginCreep * (y - top) + walk + N() * 0.15 * xh * k, -room, room);
      const left = areaLeft + room + stray;
      const lineRight = right - Math.abs(N() * 1.2 * xh) * k; // sometimes a word goes to the next line early
      const tilt = clip(pageTilt + N() * 0.006 * vk, -0.025, 0.025);
      const bow = N() * 0.12 * xh * vk; // the line sags (+) or arches (-) mid-way
      scale = clip(scale + N() * 0.02 * k, 0.92, 1.08);
      const lxh = xh * scale, span = Math.max(lineRight - left, 1);
      const baseline = px => { const u = clip((px - left) / span, 0, 1); return y + tilt * (px - left) + bow * 4 * u * (1 - u); };
      return { left, lineRight, lxh, baseline, low: y + 1.3 * lxh + Math.abs(tilt) * span + Math.abs(bow) };
    }
    /** A shaped word's strokes at x on this line, recorded in placed for underlines and word boxes. */
    function put(it, x, f, strokes, placed, drift) {
      const s0 = strokes.length, u = f.lxh * it.size, { dx, dy } = it;
      for (const s of it.ink) {
        const st = s.map(([sx, sy]) => { const px = x + sx * u; return [px + dx, f.baseline(px) + drift * xh - sy * u + dy]; });
        if (it.wd.pen) st.pen = it.wd.pen;
        if (dx || dy) st.moved = true; // drawn where it was moved to, but the line is laid out as if it hadn't
        strokes.push(st);
      }
      placed.push({ wd: it.wd, x0: x, x1: x + it.width, s0, s1: strokes.length, drift, size: it.size, dx, dy });
    }
    /** A word ready to place: its shape this time, its own size and move (checked: they may come from saved edits). */
    function shaped(wd, lxh) {
      const size = wd.size ?? 1, dx = wd.dx ?? 0, dy = wd.dy ?? 0, lim = cfg.paper.width + cfg.paper.height;
      if (!(typeof size === "number" && size >= WORD_SIZE[0] && size <= WORD_SIZE[1]))
        throw new WriteError(`"${wd.word}": a word's size must be ${WORD_SIZE[0] * 100}% to ${WORD_SIZE[1] * 100}%.`);
      if (!(typeof dx === "number" && typeof dy === "number" && Math.abs(dx) <= lim && Math.abs(dy) <= lim))
        throw new WriteError(`"${wd.word}" was moved off the paper: reset it.`);
      const s = shapeWord(wd, inkOf, k, N, hand);
      return { wd, ink: s.ink, width: s.width * lxh * size, size, dx, dy };
    }
    /** One hand-drawn stroke under each run of _underlined_ words, just below the lowest baseline in the run. */
    function underline(strokes, placed, f) {
      for (let a = 0; a < placed.length; a++) {
        if (!placed[a].wd.underline) continue;
        let b = a;
        while (b + 1 < placed.length && placed[b + 1].wd.underline) b++;
        const run = placed.slice(a, b + 1), u = f.lxh * Math.max(...run.map(p => p.size));
        const x0 = Math.max(areaLeft, placed[a].x0 - 0.15 * u), x1 = Math.min(right, placed[b].x1 + 0.15 * u);
        const drop = Math.max(...run.map(p => p.drift)) * xh + 0.3 * u;
        const e0 = N() * 0.06 * u * k, e1 = N() * 0.06 * u * k;
        // A moved word takes its piece of the line along (split halfway between words); the same random draws either
        // way, so moving a word never changes the rest of the page.
        for (let i = 0; i < run.length;) {
          let j = i;
          while (j + 1 < run.length && run[j + 1].dx === run[i].dx && run[j + 1].dy === run[i].dy) j++;
          const sx0 = i ? (run[i - 1].x1 + run[i].x0) / 2 : x0, sx1 = j + 1 < run.length ? (run[j].x1 + run[j + 1].x0) / 2 : x1;
          const n = Math.max(2, Math.ceil((sx1 - sx0) / (0.5 * xh))), { dx, dy } = run[i];
          const st = Array.from({ length: n + 1 }, (_, q) => {
            const px = sx0 + q / n * (sx1 - sx0), t = (px - x0) / (x1 - x0 || 1);
            return [px + dx, f.baseline(px) + drop + e0 + (e1 - e0) * t + dy];
          });
          if (placed[a].wd.pen) st.pen = placed[a].wd.pen;
          if (dx || dy) st.moved = true;
          strokes.push(st);
          i = j + 1;
        }
        a = b;
      }
    }
    const shift = (strokes, d) => { for (const s of strokes) for (const pt of s) pt[1] += d; y += d; };
    /** Underline, keep the line in the writing area and clear of the ink above, then add it. False: it would end
     *  below the bottom of the writing area, so it belongs on the next sheet. */
    function finish(strokes, placed, f) {
      underline(strokes, placed, f);
      // Moved words are drawn where the user put them; the line itself is laid out from the others.
      const fixed = strokes.filter(s => !s.moved), moved = strokes.filter(s => s.moved);
      if (fixed.length) {
        const rise = top - extent(fixed)[1];
        if (rise > 0) shift(strokes, snap(rise)); // a line sloping up must not climb out of the writing area
        // A line that tilts, bows or drifts into the ink above (or a tall letter under a hanging g) moves down
        // just enough to keep clear, like a person leaving room, instead of writing over it.
        let clash = 0;
        columns(fixed, (c, py) => {
          for (let d = -near; d <= near; d++) { const fl = floor.get(c + d); if (fl !== undefined) clash = Math.max(clash, fl + clear - py); }
        });
        if (clash > 0) shift(strokes, snap(clash)); // later lines follow it down, so blank lines between paragraphs stay blank
        if (extent(fixed)[3] > bottom) return false;
        columns(fixed, (c, py) => floor.set(c, Math.max(floor.get(c) ?? py, py)));
      }
      if (moved.length) {
        const [a, b, c, d] = extent(moved);
        if (!(a >= moveArea[0] && c <= moveArea[2] && b >= moveArea[1] && d <= moveArea[3]))
          throw new WriteError("A moved word would land off the paper or where the pen can't reach: move it back onto the page.");
      }
      strokes.baseline = y;
      strokes.words = placed.map(p => ({ seed: p.wd.seed, key: p.wd.key, box: extent(strokes.slice(p.s0, p.s1)), s0: p.s0, s1: p.s1 }));
      lines.push(strokes);
      return true;
    }
    /** The sheet's header line: header text from the left, the page number ending at the right. */
    function header() {
      const hw = opts.header && opts.header(pages.length);
      if (!hw || !(hw[0].length + hw[1].length)) return;
      const f = lineFrame(), strokes = [], placed = [];
      const shape = ws => ws.map(wd => shaped(wd, f.lxh));
      const L = shape(hw[0]), R = shape(hw[1]);
      let x = f.left, xr = f.lineRight - R.reduce((sum, it) => sum + it.width, 0) - Math.max(0, R.length - 1) * w.word_spacing * f.lxh;
      L.forEach((it, j) => { if (j) x += wordGap(f.lxh); put(it, x, f, strokes, placed, 0); x += it.width; });
      if (x > (R.length ? xr - xh : f.lineRight))
        throw new WriteError("The header doesn't fit on one line" + (R.length ? " with the page number" : "") + ": shorten it or use smaller letters.");
      for (const it of R) { put(it, xr, f, strokes, placed, 0); xr += it.width + w.word_spacing * f.lxh; }
      if (!finish(strokes, placed, f)) throw new WriteError("The header doesn't fit on the page: use smaller letters or a smaller top border.");
      y += grid.step;
    }
    const nextPage = () => { // the current line goes on a fresh sheet
      if (!onSheet) throw new WriteError("A line doesn't fit even on an empty page: use smaller letters or a bigger border-free area.");
      if (pages.length + 1 >= maxPages) throw tooMuch();
      pages.push(lines);
      lines = []; onSheet = 0;
      y = grid.first; walk = 0; floor = new Map();
      pageTilt = N() * 0.008 * vk; marginCreep = N() * 0.008 * k;
      header();
    };
    header();
    for (const para of paragraphs) {
      let i = 0;
      while (true) {
        const lineStart = i, f = lineFrame();
        if (f.low > bottom && i < para.length) {
          if (maxPages === 1) throw tooMuch();
          nextPage();
          continue;
        }
        let x = f.left, drift = 0;
        // indents (at most half a line); in code a line too long for the paper runs on one step further in
        const indent = lineStart ? para.runOn : para.indent;
        if (indent) x += Math.min(indent * w.indent * f.lxh, 0.5 * (f.lineRight - f.left));
        const x0 = x, strokes = [], placed = [];
        while (i < para.length) {
          const wd = para[i];
          if ((wd.parts || [wd]).some(p => !p.glyph && p.word.length > MAX_WORD))
            throw new WriteError(`The word "${wd.word.slice(0, 20)}..." is too long (${MAX_WORD} letters at most).`);
          // No two words come out the same size, slant or angle by hand: small per-word changes, scaled by wobble.
          const it = shaped(wd, f.lxh);
          if (it.width > f.lineRight - f.left) throw new WriteError(`The word "${wd.word}" is wider than a line: use smaller letters.`);
          if (x + it.width > f.lineRight && x > x0) break; // wrap
          if (x + it.width > f.lineRight) x = Math.max(f.left, f.lineRight - it.width); // the indent gives way to a long word
          i++;
          drift = clip(drift + N() * 0.04 * vk, -0.25, 0.25);
          put(it, x, f, strokes, placed, drift);
          x += it.width + wordGap(f.lxh);
        }
        if (strokes.length) {
          if (!finish(strokes, placed, f)) {
            if (maxPages === 1) throw tooMuch();
            i = lineStart; // write this line again at the top of the next sheet
            nextPage();
            continue;
          }
          onSheet++;
        }
        y += grid.ruled ? grid.step : grid.step * clip(1 + N() * 0.06 * k, 0.85, 1.2);
        if (i >= para.length) break;
      }
    }
    if (lines.length) pages.push(lines);
    return pages;
  }

  const COL = 0.5; // mm
  /** Call f(column, y) for points along every stroke, at most COL/2 apart, so long segments are covered too. */
  function columns(strokes, f) {
    for (const s of strokes) for (let j = 0; j < s.length; j++) {
      const [x1, y1] = s[j], [x0, y0] = s[j && j - 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (COL / 2)));
      for (let t = 1; t <= n; t++) f(Math.floor((x0 + (x1 - x0) * t / n) / COL), y0 + (y1 - y0) * t / n);
    }
  }

  /** [xmin, ymin, xmax, ymax] over strokes; NaN if any coordinate is not finite. */
  function extent(strokes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) for (const [x, y] of s) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [NaN, NaN, NaN, NaN];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  /** Every pen-down point is on the paper and inside this printer's bed. Written so NaN fails it. */
  function checkBounds(strokes, cfg) {
    const p = cfg.paper;
    let [l, t, r, b] = reach(cfg);
    l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, p.width); b = Math.min(b, p.height);
    const [x0, y0, x1, y1] = extent(strokes);
    if (!(l <= x0 && x1 <= r && t <= y0 && y1 <= b))
      throw new WriteError("Some writing would land off the paper or outside this printer's bed. Check the printer, paper position and pen offset.");
  }

  /** Split lines into passes for paper longer than the plate. Pass k is written with the paper slid shift_k mm
   *  toward the back; before it the pen hovers over where the previous pass's last mark lands after the slide.
   *  Returns [{shift, strokes, hover}]. */
  function planPasses(lines, cfg) {
    if (!lines.length) throw new WriteError("Nothing to write.");
    const [, t0, , b0] = reach(cfg, BED_INSET), xh = cfg.writing.x_height;
    const lastBottom = Math.max(...lines.map(l => extent(l)[3]));
    const passes = [{ shift: 0, strokes: [], hover: null }];
    for (const line of lines) {
      const [, top, , bottom] = extent(line);
      let cur = passes[passes.length - 1];
      if (!(bottom <= b0 + cur.shift)) {
        if (!cur.strokes.length)
          throw new WriteError("The writing starts below the front edge of the plate, or a line is taller than the plate: drag the paper toward the back or use smaller letters.");
        if (!cfg.paper.slide) // never a slide pause the user didn't ask for
          throw new WriteError("The writing goes past where the pen can reach: turn on sliding the paper, or use less text.");
        const last = cur.strokes[cur.strokes.length - 1], hover = last[last.length - 1];
        // Slide only as far as the rest needs, but never so far that this line or the hover mark leaves reach.
        const shift = Math.min(Math.ceil(lastBottom - b0), Math.floor(Math.min(hover[1] - xh, top) - t0));
        if (!(shift > cur.shift) || !(bottom <= b0 + shift))
          throw new WriteError("The paper can't be split into passes here: use smaller letters or drag the paper so more of it is over the plate.");
        cur = { shift, strokes: [], hover };
        passes.push(cur);
      }
      cur.strokes.push(...line);
    }
    for (const ps of passes) checkBounds(ps.hover ? [...ps.strokes, [ps.hover]] : ps.strokes, shifted(cfg, ps.shift));
    if (passes.length > 1 && passes.some(ps => ps.strokes.some(s => s.pen === PEN2)))
      throw new WriteError("A second pen can't be combined with sliding the paper: turn off Long pages, or remove the *second pen* marks.");
    return passes;
  }

  /** BambuPlot-style plain G-code (known to run on the A1) with timed pauses, in the printer's dialect. Strokes marked .pen = PEN2 are written
   *  last, after a pen change. With printer.dry_run the pen is still clamped at the writing height, but every stroke
   *  is drawn DRY_RUN_LIFT mm higher, so the same file runs without touching the paper. */
  function toGcode(passes, cfg, header, opts = {}) {
    const p = cfg.paper, pr = cfg.printer, dz = pr.dry_run ? DRY_RUN_LIFT : 0, [ox, oy] = pr.origin;
    const f = v => v.toFixed(2), i = v => String(Math.round(v)); // pauses and feeds as whole numbers
    const xy = (pt, shift) => {
      const x = p.x + pt[0] - pr.offset_x, y = p.y + shift + p.height - pt[1] - pr.offset_y;
      // Final guard on every move: inside the bed, outside every keep-out (NaN fails too). Then the printer's own coordinates.
      if (!(x >= 0 && x <= pr.bed_x && y >= 0 && y <= pr.bed_y) || pr.keepouts.some(k => x >= k[0] && x <= k[2] && y >= k[1] && y <= k[3]))
        throw new WriteError(`Refusing a move to X${f(x + ox)} Y${f(y + oy)}: outside this printer's safe area. Move the paper or check the pen offset.`);
      return `X${f(x + ox)} Y${f(y + oy)}`;
    };
    const wait = s => (pr.dialect === "bambu" ? `G4 S${i(s)}` : `G4 P${i(s * 1000)}`); // Klipper reads only P (ms)
    const z = (h, feed = pr.z_feed) => `G1 Z${f(h)} F${i(feed)}`;
    const up = z(pr.z_lift + dz), touch = z(pr.z_draw); // touch: where a pen is clamped
    const settle = pr.settle_ms >= 1 ? [`G4 P${i(pr.settle_ms)}`] : [];
    const travel = `F${i(pr.travel_feed)}`;
    let strokeNo = 0;
    const frac = n => (Math.imul(n, 0x9e3779b1) >>> 0) / 4294967296; // deterministic 0..1 per stroke
    const oneLine = h => Array.from(String(h), c => (c.codePointAt(0) < 32 || c.codePointAt(0) === 0x2028 || c.codePointAt(0) === 0x2029 ? " " : c)).join("");
    const out = header.map(h => "; " + oneLine(h)); // a header can never add a command line
    if (dz) out.push(`; DRY RUN: the pen is clamped as usual, then every stroke is drawn ${DRY_RUN_LIFT} mm above the paper`);
    const how = !opts.reach && pr.level ? LEVEL_PRINTERS.get(pr.model) : undefined, probes = how && !LEVEL_SAVED.has(how);
    const home = LEVEL_PRINTERS.get(pr.model) === "G28" && !how ? "G28 W" : "G28"; // the MK3S levels as it homes, unless told not to
    out.push(`; BEFORE STARTING: take the pen out of the holder. Homing${probes ? " and bed levelling touch" : " touches"} the nozzle to the plate.`);
    if (opts.reach) { // see reachCheck: the written points nearest the four corners, at pen-up height, nothing drawn
      const pts = passes.flatMap(ps => ps.strokes.flatMap(s => s.map(pt => ({ pt, shift: ps.shift,
        x: p.x + pt[0] - pr.offset_x, y: p.y + ps.shift + p.height - pt[1] - pr.offset_y }))));
      if (!pts.length) throw new WriteError("Nothing to write.");
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y), [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const near = (cx, cy) => pts.reduce((b, q) => (Math.hypot(q.x - cx, q.y - cy) < Math.hypot(b.x - cx, b.y - cy) ? q : b));
      const corners = [[x0, y1, "back left"], [x1, y1, "back right"], [x1, y0, "front right"], [x0, y0, "front left"]].map(([cx, cy, name]) => [near(cx, cy), name]);
      out.push("; REACH CHECK, no paper: after homing the head visits the written points nearest the four corners of this page's",
        `; writing, at pen-up height, slowly, and waits ${REACH_WAIT_S} s at each. Watch that the pen holder clears the bed clips, wiper and frame.`,
        "G90", ...(pr.dialect === "bambu" ? ["G21"] : []), home, "M104 S0", z(pr.z_draw + CLEARANCE),
        `G0 ${xy(corners[0][0].pt, corners[0][0].shift)} ${travel}`, z(pr.z_lift)); // every point through the same guard
      for (const [q, name] of corners) out.push(`; ${name}`, `G0 ${xy(q.pt, q.shift)} F${REACH_FEED}`, wait(REACH_WAIT_S));
      out.push(`G1 Z${f(pr.z_lift + 10)} F${i(pr.z_feed)}`);
      return out.join("\n") + "\n";
    }
    const sound = pr.sounds && SOUND_PRINTERS.has(pr.model) ? name => tune(pr.model, name) : () => [];
    // pen 1's strokes first, then pen 2's (planPasses allows a second pen only in a single pass)
    const order = ps => [...ps.strokes.filter(s => s.pen !== PEN2), ...ps.strokes.filter(s => s.pen === PEN2)];
    // The pen goes lower toward the front, in step with how far below the clamping point it is (press_bottom by a page's
    // height), never higher: a bed a little lower toward the front would otherwise leave the last lines faint.
    const bedY = (pt, shift) => p.y + shift + p.height - pt[1] - pr.offset_y, firstPt = order(passes[0])[0][0];
    const clampY = bedY(firstPt, 0), press = (pt, shift) => pr.press_bottom * clip((clampY - bedY(pt, shift)) / p.height, 0, 1);
    const down = (pt, shift) => z(pr.z_draw + dz - press(pt, shift));
    const firstPen2 = passes.length === 1 && passes[0].strokes.some(s => s.pen !== PEN2) ? passes[0].strokes.find(s => s.pen === PEN2) : null;
    out.push("G90", ...(pr.dialect === "bambu" ? ["G21"] : []), ...sound("start"), home); // always home: every move after this assumes a known position
    out.push("M104 S0"); // nozzle heater off: nothing here needs heat, and the pen holder sits next to the hotend
    const area = (w, h) => { // the nozzle positions of everything written, a little wider, on the bed
      const pts = passes.flatMap(ps => ps.strokes.flatMap(s => s.map(pt => [p.x + pt[0] - pr.offset_x, bedY(pt, ps.shift)])));
      const x0 = Math.max(0, Math.min(...pts.map(q => q[0])) - LEVEL_PAD), x1 = Math.min(pr.bed_x, Math.max(...pts.map(q => q[0])) + LEVEL_PAD);
      const y0 = Math.max(0, Math.min(...pts.map(q => q[1])) - LEVEL_PAD), y1 = Math.min(pr.bed_y, Math.max(...pts.map(q => q[1])) + LEVEL_PAD);
      let r = [x0, y0, x1, y1];
      for (const k of pr.keepouts) if (r[0] <= k[2] && r[2] >= k[0] && r[1] <= k[3] && r[3] >= k[1]) {
        // a part of the plate the nozzle must never touch (a purge chute): step back from it on the side that keeps the most
        const sides = [[k[2] + 1, r[1], r[2], r[3]], [r[0], r[1], k[0] - 1, r[3]], [r[0], k[3] + 1, r[2], r[3]], [r[0], r[1], r[2], k[1] - 1]]
          .filter(q => q[2] - q[0] >= 10 && q[3] - q[1] >= 10), size = q => (q[2] - q[0]) * (q[3] - q[1]);
        if (!sides.length) throw new WriteError("The bed can't be levelled under this page: it reaches a part of the plate the nozzle must avoid. Turn off bed levelling or move the paper.");
        r = sides.reduce((a, q) => (size(q) > size(a) ? q : a));
      }
      return `X${f(r[0] + ox)} Y${f(r[1] + oy)} ${w}${f(r[2] - r[0])} ${h}${f(r[3] - r[1])}`;
    };
    const off = ["M104 S0", "M140 S0"]; // after probing: heaters off again, in case the firmware warmed them for it
    const steps = how === "M420 S1" ? ["M420 S1 Z0"] : how === "BED_MESH_PROFILE LOAD=default" ? [how]
      : how === "G29" ? ["G29", ...off, "M420 S1 Z0"] : how === "BED_MESH_CALIBRATE" ? [how, ...off]
      : how === "M555" ? [`M555 ${area("W", "H")}`, "G29", ...off, "M420 S1 Z0"]
      : how === "G29 A1" || how === "G29 A" ? ["G29.2 S1", `${how} ${area("I", "J")}`, ...off] : []; // "G28": done while homing
    if (steps.length) out.push(probes
      ? "; LEVEL THE BED, the pen still out: the cold nozzle (or the printer's probe) touches the plate here and there, and the head follows the bed from now on"
      : "; BED LEVELLING: the levelling saved in the printer, on at every height, so the head follows the bed", ...steps);
    out.push(z(pr.z_draw + CLEARANCE), `G0 ${xy(order(passes[0])[0][0], 0)} ${travel}`,
      "; place the paper: the first letter goes right under the pen holder", ...sound("pause"), wait(pr.paper_pause_s),
      ...sound("resume"), touch, "; attach the pen: slide it down until it touches the paper, then clamp it", ...sound("pause"),
      wait(pr.pen_pause_s), up, ...sound("resume")); // resume tune only once the pen is lifted off the paper
    passes.forEach((ps, k) => {
      out.push(`; PASS ${k + 1} of ${passes.length}: paper slid ${ps.shift} mm toward the back`);
      if (ps.hover) out.push(z(Math.max(pr.z_lift + dz, pr.z_draw + SLIDE_HOVER)), // clear of wet ink
        `G0 ${xy(ps.hover, ps.shift)} ${travel}`,
        `; slide the paper ${ps.shift - passes[k - 1].shift} mm toward the back until the last mark written is right under the pen`,
        ...sound("pause"), wait(pr.shift_pause_s), ...sound("resume"), up);
      for (const s of order(ps)) {
        // Pen change, like the start: head well up while pen 1 comes out, then down to the writing height for pen 2.
        // The only tune plays with the head up, never with a pen on the paper.
        if (s === firstPen2) out.push(z(Math.max(pr.z_draw + CLEARANCE, pr.z_lift + dz)), `G0 ${xy(s[0], ps.shift)} ${travel}`,
          "; PEN CHANGE: take pen 1 out of the holder", ...sound("pause"), wait(pr.pen_pause_s),
          z(pr.z_draw - press(s[0], ps.shift)), "; put pen 2 in: slide it down until it touches the paper, then clamp it", wait(pr.pen_pause_s), up, ...sound("resume"));
        out.push(`G0 ${xy(s[0], ps.shift)} ${travel}`, down(s[0], ps.shift), ...settle);
        const feed = Math.min(12000, pr.draw_feed * (0.85 + 0.3 * frac(++strokeNo))); // a hand's speed varies stroke to stroke
        for (let j = 1; j < s.length; j++) out.push(`G1 ${xy(s[j], ps.shift)}` + (j === 1 ? ` F${i(feed)}` : ""));
        out.push(up, ...settle);
      }
    });
    out.push(`G1 Z${f(pr.z_lift + 10)} F${i(pr.z_feed)}`, ...sound("finish"));
    return out.join("\n") + "\n";
  }

  /** "Check the reach" for a page about to be written: with no pen and no paper, the head visits the written points
   *  nearest the four corners of the page's writing at pen-up height (where it travels during the real run), slowly,
   *  waiting at each, so the pen holder's clearance from bed clips, wipers and the frame can be seen first. Real written
   *  points, not the box around them, so a corner never lands in a keep-out. Same homing, heater-off and guard. */
  const reachCheck = (passes, cfg, header) => toGcode(passes, { ...cfg, printer: { ...cfg.printer, dry_run: false } }, header, { reach: true });

  /** What to do between passes, for the user. */
  function passNote(passes) {
    const moves = passes.slice(1).map((ps, k) => `${ps.shift - passes[k].shift} mm`).join(", then ");
    return `${passes.length} passes. Each time the pen stops over the writing, slide the paper toward the back of the printer (${moves}) until the last mark written is right under the pen tip.`;
  }

  function describe(cfg, seed) {
    const w = cfg.writing, pr = cfg.printer, p = cfg.paper;
    return [`handplot: style=${w.style} bias=${w.bias} wobble=${w.wobble} x_height=${w.x_height} seed=${seed}`,
      `ONLY for ${pr.model} (bed ${pr.bed_x} x ${pr.bed_y} mm${pr.origin[0] || pr.origin[1] ? ` from X${pr.origin[0]} Y${pr.origin[1]}` : ""}), pen offset ${pr.offset_x},${pr.offset_y}`,
      `paper ${p.size} ${p.orientation}, front-left corner at X${p.x} Y${p.y}`];
  }

  const OFFSET_TEST_Y = 60; // mm below the paper's top edge where the test line lands if the pen offset is 0

  /** Pen-offset test: A4 portrait pushed into the plate's back-left corner. The nozzle draws a long line
   *  OFFSET_TEST_Y mm in front of the plate's back edge and a short mark across it at the plate's middle; where the
   *  pen really draws them gives the offset (offsetFromTest). Same heights, speeds, pauses and checks as writing.
   *  The paper goes into the plate's own corner (pr.plate: the plate may reach past where the nozzle may go).
   *  shortcut: assumes the printer's profile matches its plate edges; re-measure if writing lands off. */
  function offsetTest(settings) {
    const pr = resolve(settings).printer, [width, height] = PAPERS.A4;
    const cfg = resolve({ ...settings, printer: { ...settings.printer, offset_x: 0, offset_y: 0, dry_run: false },
      paper: { ...settings.paper, size: "A4", orientation: "portrait", x: -pr.plate[0], y: pr.bed_y + pr.plate[3] - height } });
    const { left: mid, top: Y } = offsetTestMarks(settings), half = Math.min(50, mid - BED_INSET);
    const marks = [[[mid - half, Y], [mid + half, Y]], [[mid, Y - 10], [mid, Y + 10]]];
    return toGcode(planPasses([marks], cfg), cfg, ["handplot: pen offset test", ...describe(cfg, 0).slice(1),
      "push A4 paper into the top-left (far-left) corner of the plate, top and left edges against the plate's edges"]);
  }
  /** Where the test marks land if the pen offset is 0: mm from the paper's left edge (short mark) and top edge (long line). */
  function offsetTestMarks(settings) {
    return { left: Math.min(resolve(settings).printer.bed_x, PAPERS.A4[0]) / 2, top: OFFSET_TEST_Y };
  }
  /** Offset from the test: mm from the paper's left edge to the short mark, and from its top edge to the long line. */
  function offsetFromTest(settings, fromLeft, fromTop) {
    const m = offsetTestMarks(settings);
    return { offset_x: round2(fromLeft - m.left), offset_y: round2(m.top - fromTop) };
  }

  return { WriteError, SOUND_PRINTERS, LEVEL_PRINTERS, LEVEL_SAVED, TUNES, BAMBU_TUNES, tuneOf, PRINTERS, PRINTER_GROUPS, PAPERS, LIMITS, DEFAULT_SETTINGS, BED_INSET, CLEARANCE, MAX_WORD, SLIDE_HOVER,
    MIN_PEN_LIFT, validate, resolve, reach, writingArea, shifted, words, layout, extent, checkBounds, planPasses,
    toGcode, reachCheck, REACH_WAIT_S, passNote, describe, capacity, layoutPages, MAX_PAGES, offsetTest, offsetFromTest, offsetTestMarks, placePaper, penRange,
    lineGrid, headerWords, rulingLetters, PEN2, DRY_RUN_LIFT, MARGIN_LINE_GAP, WORD_SIZE, GLYPH_CHARS, glyph, pieces, handOf };
});
