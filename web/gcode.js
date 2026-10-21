/* Page layout, pass planning and G-code for a Bambu Lab printer with a pen holder.
 * Port of write.py (incl. the safety-audit fixes). Classic script: global HWGcode, or require() in Node.
 * Units: mm. Page coords: origin at the paper's top-left (the edge toward the BACK of the printer), y toward
 * the front. Bed coords: X right, Y toward the back, origin front-left. pen = nozzle + offset. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HWGcode = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  class WriteError extends Error {}

  // [bed_x, bed_y, max Z, nozzle keep-out [x0, y0, x1, y1] or null]. P1/X1: front-left the toolhead presses
  // the filament-cutter lever against the frame.
  const CUTTER = [0, 0, 18, 28];
  const PRINTERS = {
    "Bambu Lab A1": [256, 256, 256, null],
    "Bambu Lab A1 mini": [180, 180, 180, null],
    "Bambu Lab P1P / P1S": [256, 256, 250, CUTTER],
    "Bambu Lab P2S": [256, 256, 256, null],
    "Bambu Lab X1 Carbon / X1E": [256, 256, 250, CUTTER],
    "Custom": null,
  };
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
      paper_pause_s: 30, pen_pause_s: 30, shift_pause_s: 45, z_draw: 10, z_lift: 12,
      z_feed: 600, draw_feed: 1500, travel_feed: 6000, settle_ms: 60, sounds: true, dry_run: false },
    // ruling: mm between the printed lines of ruled paper (0 = plain); first_line: mm from the top edge to the first
    // printed line; margin_line: mm from the left edge to the printed margin line (0 = none)
    paper: { size: "A5", orientation: "portrait", x: 55, y: 10, width: 148, height: 210, margin: 15, margin_y: 15, slide: false,
      ruling: 0, first_line: 20, margin_line: 0 },
    writing: { style: "s:neat-1", bias: 1.8, wobble: 1, x_height: 2.8, line_spacing: 8, word_spacing: 1, header: "", page_numbers: false },
  };
  // Every number that reaches the G-code: [min, max]. Values must be real, finite numbers.
  const LIMITS = {
    printer: { bed_x: [50, 400], bed_y: [50, 400], bed_z: [50, 400], offset_x: [-100, 100], offset_y: [-100, 100],
      z_draw: [2, 200], z_lift: [3, 200], z_feed: [60, 1200], draw_feed: [60, 12000], travel_feed: [600, 12000],
      paper_pause_s: [5, 600], pen_pause_s: [5, 600], shift_pause_s: [5, 600], settle_ms: [0, 2000] },
    paper: { x: [-600, 600], y: [-600, 600], width: [30, 600], height: [30, 600], margin: [0, 50], margin_y: [0, 80],
      ruling: [0, 30], first_line: [0, 600], margin_line: [0, 300] },
    writing: { bias: [0, 2], wobble: [0, 2], x_height: [1, 20], line_spacing: [1, 100], word_spacing: [0.2, 5] },
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
    if ([pr.sounds, cfg.paper.slide, pr.dry_run, w.page_numbers].some(v => typeof v !== "boolean"))
      throw new WriteError("Settings sounds, slide, dry run and page numbers must be on or off.");
    if (!["portrait", "landscape"].includes(cfg.paper.orientation) || typeof w.style !== "string")
      throw new WriteError("Paper orientation must be portrait or landscape, and style a name.");
    if (typeof w.header !== "string" || w.header.length > 80) throw new WriteError("The header must be text, 80 characters at most.");
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
    pr.keepout = null;
    if (PRINTERS[pr.model]) [pr.bed_x, pr.bed_y, pr.bed_z, pr.keepout] = PRINTERS[pr.model];
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

  /** Clean text -> paragraphs of words, each word with a seed that depends only on the page seed, the word and
   *  how often it already appeared, so editing one word keeps the rest of the page's handwriting.
   *  Markup (kept by cleanText(text, "_*")): _like this_ is underlined, *like this* is written with a second pen;
   *  each runs to its closing mark or the end of the line. Words get underline: true / pen: PEN2. */
  function words(text, pageSeed) {
    const seen = new Map();
    return text.split("\n").map(para => {
      let underline = false, pen2 = false;
      const out = [];
      for (const token of para.split(" ")) {
        let word = "", u = false, p = false;
        for (const ch of token) {
          if (ch === "_") underline = !underline;
          else if (ch === "*") pen2 = !pen2;
          else { if (!word) { u = underline; p = pen2; } word += ch; } // a word takes the marks open at its first letter
        }
        if (!word) continue;
        const n = (seen.get(word) || 0) + 1;
        seen.set(word, n);
        const w = { word, seed: hash(`${pageSeed}|${word}|${n}`) };
        // ALL-CAPS words: the model learned mostly lowercase and garbles them, but writes single capitals well,
        // so they are written letter by letter (punctuation stays with its letter: "YOU," -> Y, O, U,).
        // Numbers too: the model saw few digits and half-writes them in a run, but single digits come out clean.
        // Digits go one at a time, letter runs stay whole: "4th" -> 4, th;  "7:30" -> 7:, 3, 0.
        const parts = isCaps(word) ? word.match(/[^A-Z0-9]*[A-Z0-9][^A-Z0-9]*/g)
          : /[0-9]/.test(word) && word.length > 1 ? word.match(/[^A-Za-z0-9]*[0-9][^A-Za-z0-9]*|[^0-9]+/g) : null;
        if (parts && parts.length > 1) w.parts = parts.map((ch, i) => ({ word: ch, seed: hash(`${pageSeed}|${word}|${n}|${i}`) }));
        if (u) w.underline = true;
        if (p) w.pen = PEN2;
        out.push(w);
      }
      return out;
    });
  }
  /** Words of the header line on sheet k (0-based): [left: the header text, right: "Page k+1"]. Every sheet's header
   *  is written afresh, like a person writing it again. text: cleaned like the page text. */
  function headerWords(text, pageNumbers, seed, k) {
    const s = hash(`${seed}|header|${k}`);
    return [text.trim() ? words(text.replace(/\n/g, " "), s).flat() : [], pageNumbers ? words(`Page ${k + 1}`, s).flat() : []];
  }
  const isCaps = word => (word.match(/[A-Z]/g) || []).length >= 2 && !/[a-z]/.test(word);
  const LETTER_GAP = 0.18; // x-heights between block capitals

  /** A word's ink; ALL-CAPS words are assembled from their separately written letters. */
  function wordInk(wd, inkOf, gap) {
    if (!wd.parts) return inkOf(wd);
    const out = [];
    let x = 0;
    for (const part of wd.parts) {
      const ink = inkOf(part);
      let w = 0;
      for (const st of ink) for (const p of st) w = Math.max(w, p[0]);
      for (const st of ink) out.push(st.map(([a, b]) => [a + x, b]));
      x += w + gap();
    }
    return out;
  }
  function hash(s) { // FNV-1a, 32 bit
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  const clip = (v, a, b) => Math.min(Math.max(v, a), b);

  /** A word as a hand writes it this time: a little bigger or smaller, more or less slanted, at a slight angle (all
   *  scaled by wobble k). Returns {ink, width}: strokes starting at x = 0, in x-height units. */
  function shapeWord(wd, inkOf, k, N) {
    const ws = clip(1 + N() * 0.04 * k, 0.9, 1.1), shear = clip(N() * 0.05 * k, -0.12, 0.12), rot = clip(N() * 0.012 * k, -0.03, 0.03);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    let ink = wordInk(wd, inkOf, () => Math.max(0.06, LETTER_GAP + N() * 0.04 * k)).map(st => st.map(([sx, sy]) => { const a = (sx + shear * sy) * ws, b = sy * ws; return [a * cr - b * sr, a * sr + b * cr]; }));
    let xmin = Infinity, width = 0;
    for (const st of ink) for (const pt of st) xmin = Math.min(xmin, pt[0]);
    ink = ink.map(st => st.map(([a, b]) => [a - xmin, b])); // the word still starts where it is placed
    for (const st of ink) for (const pt of st) width = Math.max(width, pt[0]);
    return { ink, width };
  }

  /** Place words on the page. paragraphs: from words(); inkOf(w) -> strokes ([[x,y],...] in x-height units,
   *  baseline 0, y up) for that word; rng: {normal()}. Returns lines, each a list of strokes in page mm.
   *  A stroke written with the second pen has .pen = PEN2. Each line also has .baseline (mm from the top edge) and
   *  .words: [{seed, box: [x0, y0, x1, y1]}], where each word landed (to click one in the preview). */
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
    // How a person writes on blank paper: the page leans a little, the left margin creeps sideways, each line
    // starts, slopes, bows and ends a little differently, gaps vary, size drifts. Scaled by wobble (0 = none).
    // On ruled paper the printed lines keep the writing level: far less up-and-down, and a line that has to move
    // goes down whole lines.
    const k = w.wobble, vk = grid.ruled ? 0.3 * k : k, N = () => rng.normal();
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
      const s0 = strokes.length;
      for (const s of it.ink) {
        const st = s.map(([sx, sy]) => { const px = x + sx * f.lxh; return [px, f.baseline(px) + drift * xh - sy * f.lxh]; });
        if (it.wd.pen) st.pen = it.wd.pen;
        strokes.push(st);
      }
      placed.push({ wd: it.wd, x0: x, x1: x + it.width, s0, s1: strokes.length, drift });
    }
    /** One hand-drawn stroke under each run of _underlined_ words, just below the lowest baseline in the run. */
    function underline(strokes, placed, f) {
      for (let a = 0; a < placed.length; a++) {
        if (!placed[a].wd.underline) continue;
        let b = a;
        while (b + 1 < placed.length && placed[b + 1].wd.underline) b++;
        const x0 = Math.max(areaLeft, placed[a].x0 - 0.15 * f.lxh), x1 = Math.min(right, placed[b].x1 + 0.15 * f.lxh);
        const drop = Math.max(...placed.slice(a, b + 1).map(p => p.drift)) * xh + 0.3 * f.lxh;
        const e0 = N() * 0.06 * f.lxh * k, e1 = N() * 0.06 * f.lxh * k, n = Math.max(2, Math.ceil((x1 - x0) / (0.5 * xh)));
        const st = Array.from({ length: n + 1 }, (_, j) => { const u = j / n, px = x0 + u * (x1 - x0); return [px, f.baseline(px) + drop + e0 + (e1 - e0) * u]; });
        if (placed[a].wd.pen) st.pen = placed[a].wd.pen;
        strokes.push(st);
        a = b;
      }
    }
    const shift = (strokes, d) => { for (const s of strokes) for (const pt of s) pt[1] += d; y += d; };
    /** Underline, keep the line in the writing area and clear of the ink above, then add it. False: it would end
     *  below the bottom of the writing area, so it belongs on the next sheet. */
    function finish(strokes, placed, f) {
      underline(strokes, placed, f);
      const rise = top - extent(strokes)[1];
      if (rise > 0) shift(strokes, snap(rise)); // a line sloping up must not climb out of the writing area
      // A line that tilts, bows or drifts into the ink above (or a tall letter under a hanging g) moves down
      // just enough to keep clear, like a person leaving room, instead of writing over it.
      let clash = 0;
      columns(strokes, (c, py) => {
        for (let d = -near; d <= near; d++) { const fl = floor.get(c + d); if (fl !== undefined) clash = Math.max(clash, fl + clear - py); }
      });
      if (clash > 0) shift(strokes, snap(clash)); // later lines follow it down, so blank lines between paragraphs stay blank
      if (extent(strokes)[3] > bottom) return false;
      columns(strokes, (c, py) => floor.set(c, Math.max(floor.get(c) ?? py, py)));
      strokes.baseline = y;
      strokes.words = placed.map(p => ({ seed: p.wd.seed, box: extent(strokes.slice(p.s0, p.s1)) }));
      lines.push(strokes);
      return true;
    }
    /** The sheet's header line: header text from the left, the page number ending at the right. */
    function header() {
      const hw = opts.header && opts.header(pages.length);
      if (!hw || !(hw[0].length + hw[1].length)) return;
      const f = lineFrame(), strokes = [], placed = [];
      const shape = ws => ws.map(wd => { const s = shapeWord(wd, inkOf, k, N); return { wd, ink: s.ink, width: s.width * f.lxh }; });
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
        const strokes = [], placed = [];
        while (i < para.length) {
          const wd = para[i];
          if (wd.word.length > MAX_WORD)
            throw new WriteError(`The word "${wd.word.slice(0, 20)}..." is too long (${MAX_WORD} letters at most).`);
          // No two words come out the same size, slant or angle by hand: small per-word changes, scaled by wobble.
          const s = shapeWord(wd, inkOf, k, N), it = { wd, ink: s.ink, width: s.width * f.lxh };
          if (it.width > f.lineRight - f.left) throw new WriteError(`The word "${wd.word}" is wider than a line: use smaller letters.`);
          if (x + it.width > f.lineRight && x > f.left) break; // wrap
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

  /** BambuPlot-style plain G-code (known to run on the A1) with timed pauses. Strokes marked .pen = PEN2 are written
   *  last, after a pen change. With printer.dry_run the pen is still clamped at the writing height, but every stroke
   *  is drawn DRY_RUN_LIFT mm higher, so the same file runs without touching the paper. */
  function toGcode(passes, cfg, header) {
    const p = cfg.paper, pr = cfg.printer, ko = pr.keepout, dz = pr.dry_run ? DRY_RUN_LIFT : 0;
    const f = v => v.toFixed(2), i = v => String(Math.round(v)); // pauses and feeds as whole numbers
    const xy = (pt, shift) => {
      const x = p.x + pt[0] - pr.offset_x, y = p.y + shift + p.height - pt[1] - pr.offset_y;
      // Final guard on the exact numbers written: inside the bed, outside any keep-out (NaN fails too).
      if (!(x >= 0 && x <= pr.bed_x && y >= 0 && y <= pr.bed_y) || (ko && x >= ko[0] && x <= ko[2] && y >= ko[1] && y <= ko[3]))
        throw new WriteError(`Refusing a move to X${f(x)} Y${f(y)}: outside this printer's safe area. Move the paper or check the pen offset.`);
      return `X${f(x)} Y${f(y)}`;
    };
    const z = (h, feed = pr.z_feed) => `G1 Z${f(h)} F${i(feed)}`;
    const up = z(pr.z_lift + dz), down = z(pr.z_draw + dz), touch = z(pr.z_draw); // touch: where a pen is clamped
    const settle = pr.settle_ms >= 1 ? [`G4 P${i(pr.settle_ms)}`] : [];
    const travel = `F${i(pr.travel_feed)}`;
    let strokeNo = 0;
    const frac = n => (Math.imul(n, 0x9e3779b1) >>> 0) / 4294967296; // deterministic 0..1 per stroke
    const oneLine = h => Array.from(String(h), c => (c.codePointAt(0) < 32 || c.codePointAt(0) === 0x2028 || c.codePointAt(0) === 0x2029 ? " " : c)).join("");
    const out = header.map(h => "; " + oneLine(h)); // a header can never add a command line
    if (dz) out.push(`; DRY RUN: the pen is clamped as usual, then every stroke is drawn ${DRY_RUN_LIFT} mm above the paper`);
    out.push("; BEFORE STARTING: take the pen out of the holder. Homing touches the nozzle to the plate.");
    const sound = pr.sounds && SOUND_PRINTERS.has(pr.model) ? name => tune(pr.model, name) : () => [];
    // pen 1's strokes first, then pen 2's (planPasses allows a second pen only in a single pass)
    const order = ps => [...ps.strokes.filter(s => s.pen !== PEN2), ...ps.strokes.filter(s => s.pen === PEN2)];
    const firstPen2 = passes.length === 1 && passes[0].strokes.some(s => s.pen !== PEN2) ? passes[0].strokes.find(s => s.pen === PEN2) : null;
    out.push("G90", "G21", ...sound("start"), "G28"); // always home: every move after this assumes a known position
    out.push("M104 S0"); // nozzle heater off: nothing here needs heat, and the pen holder sits next to the hotend
    out.push(z(pr.z_draw + CLEARANCE), `G0 ${xy(order(passes[0])[0][0], 0)} ${travel}`,
      "; place the paper: the first letter goes right under the pen holder", ...sound("pause"), `G4 S${i(pr.paper_pause_s)}`,
      ...sound("resume"), touch, "; attach the pen: slide it down until it touches the paper, then clamp it", ...sound("pause"),
      `G4 S${i(pr.pen_pause_s)}`, up, ...sound("resume")); // resume tune only once the pen is lifted off the paper
    passes.forEach((ps, k) => {
      out.push(`; PASS ${k + 1} of ${passes.length}: paper slid ${ps.shift} mm toward the back`);
      if (ps.hover) out.push(z(Math.max(pr.z_lift + dz, pr.z_draw + SLIDE_HOVER)), // clear of wet ink
        `G0 ${xy(ps.hover, ps.shift)} ${travel}`,
        `; slide the paper ${ps.shift - passes[k - 1].shift} mm toward the back until the last mark written is right under the pen`,
        ...sound("pause"), `G4 S${i(pr.shift_pause_s)}`, ...sound("resume"), up);
      for (const s of order(ps)) {
        // Pen change, like the start: head well up while pen 1 comes out, then down to the writing height for pen 2.
        // The only tune plays with the head up, never with a pen on the paper.
        if (s === firstPen2) out.push(z(Math.max(pr.z_draw + CLEARANCE, pr.z_lift + dz)), `G0 ${xy(s[0], ps.shift)} ${travel}`,
          "; PEN CHANGE: take pen 1 out of the holder", ...sound("pause"), `G4 S${i(pr.pen_pause_s)}`,
          touch, "; put pen 2 in: slide it down until it touches the paper, then clamp it", `G4 S${i(pr.pen_pause_s)}`, up, ...sound("resume"));
        out.push(`G0 ${xy(s[0], ps.shift)} ${travel}`, down, ...settle);
        const feed = Math.min(12000, pr.draw_feed * (0.85 + 0.3 * frac(++strokeNo))); // a hand's speed varies stroke to stroke
        for (let j = 1; j < s.length; j++) out.push(`G1 ${xy(s[j], ps.shift)}` + (j === 1 ? ` F${i(feed)}` : ""));
        out.push(up, ...settle);
      }
    });
    out.push(`G1 Z${f(pr.z_lift + 10)} F${i(pr.z_feed)}`, ...sound("finish"));
    return out.join("\n") + "\n";
  }

  /** What to do between passes, for the user. */
  function passNote(passes) {
    const moves = passes.slice(1).map((ps, k) => `${ps.shift - passes[k].shift} mm`).join(", then ");
    return `${passes.length} passes. Each time the pen stops over the writing, slide the paper toward the back of the printer (${moves}) until the last mark written is right under the pen tip.`;
  }

  function describe(cfg, seed) {
    const w = cfg.writing, pr = cfg.printer, p = cfg.paper;
    return [`handwrite: style=${w.style} bias=${w.bias} wobble=${w.wobble} x_height=${w.x_height} seed=${seed}`,
      `ONLY for ${pr.model} (bed ${pr.bed_x} x ${pr.bed_y} mm), pen offset ${pr.offset_x},${pr.offset_y}`,
      `paper ${p.size} ${p.orientation}, front-left corner at X${p.x} Y${p.y}`];
  }

  const OFFSET_TEST_Y = 60; // mm below the paper's top edge where the test line lands if the pen offset is 0

  /** Pen-offset test: A4 portrait pushed into the plate's back-left corner. The nozzle draws a long line
   *  OFFSET_TEST_Y mm in front of the plate's back edge and a short mark across it at the plate's middle; where the
   *  pen really draws them gives the offset (offsetFromTest). Same heights, speeds, pauses and checks as writing.
   *  shortcut: assumes the plate's back and left edges are at Y = bed_y and X = 0; re-measure if writing lands off. */
  function offsetTest(settings) {
    const pr = resolve(settings).printer, [width, height] = PAPERS.A4;
    const cfg = resolve({ ...settings, printer: { ...settings.printer, offset_x: 0, offset_y: 0, dry_run: false },
      paper: { ...settings.paper, size: "A4", orientation: "portrait", x: 0, y: pr.bed_y - height } });
    const { left: mid, top: Y } = offsetTestMarks(settings), half = Math.min(50, mid - BED_INSET);
    const marks = [[[mid - half, Y], [mid + half, Y]], [[mid, Y - 10], [mid, Y + 10]]];
    return toGcode(planPasses([marks], cfg), cfg, ["handwrite: pen offset test", ...describe(cfg, 0).slice(1),
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

  return { WriteError, SOUND_PRINTERS, TUNES, BAMBU_TUNES, tuneOf, PRINTERS, PAPERS, LIMITS, DEFAULT_SETTINGS, BED_INSET, CLEARANCE, MAX_WORD, SLIDE_HOVER,
    MIN_PEN_LIFT, validate, resolve, reach, writingArea, shifted, words, layout, extent, checkBounds, planPasses,
    toGcode, passNote, describe, capacity, layoutPages, MAX_PAGES, offsetTest, offsetFromTest, offsetTestMarks, placePaper, penRange,
    lineGrid, headerWords, rulingLetters, PEN2, DRY_RUN_LIFT, MARGIN_LINE_GAP };
});
