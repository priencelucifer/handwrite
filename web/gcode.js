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

  const DEFAULT_SETTINGS = {
    printer: { model: "Bambu Lab A1", bed_x: 256, bed_y: 256, bed_z: 150, offset_x: 0, offset_y: 0,
      paper_pause_s: 30, pen_pause_s: 30, shift_pause_s: 45, z_draw: 10, z_lift: 12,
      z_feed: 600, draw_feed: 1500, travel_feed: 6000, settle_ms: 60, sounds: true },
    paper: { size: "A5", orientation: "portrait", x: 54, y: 23, width: 148, height: 210, margin: 15, margin_y: 15, slide: false },
    writing: { style: "s:neat-1", bias: 1.8, wobble: 1, x_height: 2.8, line_spacing: 8, word_spacing: 1 },
  };
  // Every number that reaches the G-code: [min, max]. Values must be real, finite numbers.
  const LIMITS = {
    printer: { bed_x: [50, 400], bed_y: [50, 400], bed_z: [50, 400], offset_x: [-100, 100], offset_y: [-100, 100],
      z_draw: [2, 200], z_lift: [3, 200], z_feed: [60, 1200], draw_feed: [60, 12000], travel_feed: [600, 12000],
      paper_pause_s: [5, 600], pen_pause_s: [5, 600], shift_pause_s: [5, 600], settle_ms: [0, 2000] },
    paper: { x: [-600, 600], y: [-600, 600], width: [30, 600], height: [30, 600], margin: [0, 50], margin_y: [0, 80] },
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
    if (typeof pr.sounds !== "boolean" || typeof cfg.paper.slide !== "boolean") throw new WriteError("Settings sounds and slide must be on or off.");
    if (!["portrait", "landscape"].includes(cfg.paper.orientation) || typeof w.style !== "string")
      throw new WriteError("Paper orientation must be portrait or landscape, and style a name.");
    if (round2(pr.z_lift) - round2(pr.z_draw) < MIN_PEN_LIFT)
      throw new WriteError(`Pen-up height must be at least ${MIN_PEN_LIFT} mm above the writing height.`);
    if (Math.max(pr.z_draw + CLEARANCE, pr.z_lift + 10) > pr.bed_z)
      throw new WriteError(`Writing height is too high for this printer (max Z ${pr.bed_z} mm).`);
    const p = cfg.paper;
    if (2 * p.margin > p.width - 20 || 2 * p.margin_y > p.height - 20)
      throw new WriteError("The borders are too big for this paper: leave at least 20 mm to write on.");
    if (w.line_spacing < 1.5 * w.x_height)
      throw new WriteError("Line spacing is too small for the letter size: lines would write over each other.");
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
    return [Math.max(l, m), Math.max(t, my), Math.min(r, p.width - m), p.slide ? p.height - my : Math.min(b, p.height - my)];
  }

  /** Rough page capacity before any handwriting is generated. charWidth: the style's average letter width in
   *  x-heights; paragraphs: from words() (optional) to say how many lines this text needs.
   *  Returns {lines, perLine, words, needed}. An estimate: real words vary in width. */
  function capacity(cfg, charWidth, paragraphs = []) {
    const w = cfg.writing, xh = w.x_height, ls = w.line_spacing;
    const [l, t, r, b] = writingArea(cfg);
    // Lines closer than ~3.1 letter heights (tall letters over long tails, plus the gap) get pushed apart in layout.
    const lines = Math.max(0, Math.floor((b - t - 3.3 * xh) / Math.max(ls, 3.1 * xh)) + 1); // first baseline 2 xh down, descenders below the last
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
   *  how often it already appeared, so editing one word keeps the rest of the page's handwriting. */
  function words(text, pageSeed) {
    const seen = new Map();
    return text.split("\n").map(para => para.split(" ").filter(Boolean).map(word => {
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
      return w;
    }));
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

  /** Place words on the page. paragraphs: from words(); inkOf(w) -> strokes ([[x,y],...] in x-height units,
   *  baseline 0, y up) for that word; rng: {normal()}. Returns lines, each a list of strokes in page mm. */
  /** Single page: throws if the text doesn't fit. */
  function layout(paragraphs, inkOf, cfg, rng) { return layoutPages(paragraphs, inkOf, cfg, rng, 1)[0] || []; }

  /** Like layout, but text that doesn't fit continues on the next sheet, up to maxPages. Returns pages of lines. */
  function layoutPages(paragraphs, inkOf, cfg, rng, maxPages = MAX_PAGES) {
    const w = cfg.writing, xh = w.x_height, ls = w.line_spacing;
    const [areaLeft, top, right, bottom] = writingArea(cfg);
    if (right - areaLeft < 8 * xh || Math.min(bottom, reach(cfg, BED_INSET)[3]) - top < 4 * xh)
      throw new WriteError("Too little of the paper is on the build plate: drag the paper onto the plate.");
    // How a person writes on blank paper: the page leans a little, the left margin creeps sideways, each line
    // starts, slopes, bows and ends a little differently, gaps vary, size drifts. Scaled by wobble (0 = none).
    const k = w.wobble, N = () => rng.normal();
    const clip = (v, a, b) => Math.min(Math.max(v, a), b);
    const room = xh * k;
    let pageTilt = N() * 0.008 * k, marginCreep = N() * 0.008 * k; // each sheet leans its own way
    let walk = 0, scale = 1, y = top + 2 * xh; // first baseline, leaving room for capitals and ascenders
    // Lowest ink so far on this sheet per COL-wide column; new lines keep `gap` mm (pen centre to centre) below it.
    let floor = new Map();
    const gap = Math.max(0.8, 0.3 * xh), near = Math.ceil(gap / COL);
    const pages = [];
    let lines = [];
    const tooMuch = () => new WriteError(maxPages > 1
      ? `Too much text: it needs more than ${maxPages} pages. Use smaller letters or bigger paper.`
      : "Text doesn't fit on the page: use smaller letters or less text.");
    const nextPage = () => { // the current line goes on a fresh sheet
      if (!lines.length) throw new WriteError("A line doesn't fit even on an empty page: use smaller letters or a bigger border-free area.");
      if (pages.length + 1 >= maxPages) throw tooMuch();
      pages.push(lines);
      lines = [];
      y = top + 2 * xh; walk = 0; floor = new Map();
      pageTilt = N() * 0.008 * k; marginCreep = N() * 0.008 * k;
    };
    for (const para of paragraphs) {
      let i = 0;
      while (true) {
        const lineStart = i;
        walk = 0.7 * walk + N() * 0.3 * xh * k; // mean-reverting: lines drift either side and get pulled back
        const stray = clip(marginCreep * (y - top) + walk + N() * 0.15 * xh * k, -room, room);
        const left = areaLeft + room + stray;
        const lineRight = right - Math.abs(N() * 1.2 * xh) * k; // sometimes a word goes to the next line early
        const tilt = clip(pageTilt + N() * 0.006 * k, -0.025, 0.025);
        const bow = N() * 0.12 * xh * k; // the line sags (+) or arches (-) mid-way
        scale = clip(scale + N() * 0.02 * k, 0.92, 1.08);
        const lxh = xh * scale, span = Math.max(lineRight - left, 1);
        if (y + 1.3 * lxh + Math.abs(tilt) * span + Math.abs(bow) > bottom && i < para.length) {
          if (maxPages === 1) throw tooMuch();
          nextPage();
          continue;
        }
        const baseline = px => { const u = clip((px - left) / span, 0, 1); return y + tilt * (px - left) + bow * 4 * u * (1 - u); };
        let x = left, drift = 0, strokes = [];
        while (i < para.length) {
          const wd = para[i];
          if (wd.word.length > MAX_WORD)
            throw new WriteError(`The word "${wd.word.slice(0, 20)}..." is too long (${MAX_WORD} letters at most).`);
          // No two words come out the same size, slant or angle by hand: small per-word changes, scaled by wobble.
          const ws = clip(1 + N() * 0.04 * k, 0.9, 1.1), shear = clip(N() * 0.05 * k, -0.12, 0.12), rot = clip(N() * 0.012 * k, -0.03, 0.03);
          const cr = Math.cos(rot), sr = Math.sin(rot);
          let ink = wordInk(wd, inkOf, () => Math.max(0.06, LETTER_GAP + N() * 0.04 * k)).map(st => st.map(([sx, sy]) => { const a = (sx + shear * sy) * ws, b = sy * ws; return [a * cr - b * sr, a * sr + b * cr]; }));
          let xmin = Infinity, width = 0;
          for (const st of ink) for (const pt of st) xmin = Math.min(xmin, pt[0]);
          ink = ink.map(st => st.map(([a, b]) => [a - xmin, b])); // the word still starts where it is placed
          for (const st of ink) for (const pt of st) width = Math.max(width, pt[0]);
          width *= lxh;
          if (width > lineRight - left) throw new WriteError(`The word "${wd.word}" is wider than a line: use smaller letters.`);
          if (x + width > lineRight && x > left) break; // wrap
          i++;
          drift = clip(drift + N() * 0.04 * k, -0.25, 0.25);
          for (const s of ink) strokes.push(s.map(([sx, sy]) => { const px = x + sx * lxh; return [px, baseline(px) + drift * xh - sy * lxh]; }));
          x += width + Math.max(0.4, w.word_spacing * (1 + N() * 0.15 * k)) * lxh;
        }
        if (strokes.length) {
          const rise = top - extent(strokes)[1];
          if (rise > 0) { // a line sloping up must not climb out of the writing area
            strokes = strokes.map(s => s.map(([a, b]) => [a, b + rise]));
            y += rise;
          }
          // A line that tilts, bows or drifts into the ink above (or a tall letter under a hanging g) moves down
          // just enough to keep clear, like a person leaving room, instead of writing over it.
          let clash = 0;
          columns(strokes, (c, py) => {
            for (let d = -near; d <= near; d++) { const f = floor.get(c + d); if (f !== undefined) clash = Math.max(clash, f + gap - py); }
          });
          if (clash > 0) { // later lines follow it down, so blank lines between paragraphs stay blank
            strokes = strokes.map(s => s.map(([a, b]) => [a, b + clash]));
            y += clash;
          }
          if (extent(strokes)[3] > bottom) {
            if (maxPages === 1) throw tooMuch();
            i = lineStart; // write this line again at the top of the next sheet
            nextPage();
            continue;
          }
          columns(strokes, (c, py) => floor.set(c, Math.max(floor.get(c) ?? py, py)));
          lines.push(strokes);
        }
        y += ls * clip(1 + N() * 0.06 * k, 0.85, 1.2);
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
    return passes;
  }

  /** BambuPlot-style plain G-code (known to run on the A1) with timed pauses. */
  function toGcode(passes, cfg, header) {
    const p = cfg.paper, pr = cfg.printer, ko = pr.keepout;
    const f = v => v.toFixed(2), i = v => String(Math.round(v)); // pauses and feeds as whole numbers
    const xy = (pt, shift) => {
      const x = p.x + pt[0] - pr.offset_x, y = p.y + shift + p.height - pt[1] - pr.offset_y;
      // Final guard on the exact numbers written: inside the bed, outside any keep-out (NaN fails too).
      if (!(x >= 0 && x <= pr.bed_x && y >= 0 && y <= pr.bed_y) || (ko && x >= ko[0] && x <= ko[2] && y >= ko[1] && y <= ko[3]))
        throw new WriteError(`Refusing a move to X${f(x)} Y${f(y)}: outside this printer's safe area. Move the paper or check the pen offset.`);
      return `X${f(x)} Y${f(y)}`;
    };
    const up = `G1 Z${f(pr.z_lift)} F${i(pr.z_feed)}`, down = `G1 Z${f(pr.z_draw)} F${i(pr.z_feed)}`;
    const settle = pr.settle_ms >= 1 ? [`G4 P${i(pr.settle_ms)}`] : [];
    const travel = `F${i(pr.travel_feed)}`;
    let strokeNo = 0;
    const frac = n => (Math.imul(n, 0x9e3779b1) >>> 0) / 4294967296; // deterministic 0..1 per stroke
    const oneLine = h => Array.from(String(h), c => (c.codePointAt(0) < 32 || c.codePointAt(0) === 0x2028 || c.codePointAt(0) === 0x2029 ? " " : c)).join("");
    const out = header.map(h => "; " + oneLine(h)); // a header can never add a command line
    out.push("; BEFORE STARTING: take the pen out of the holder. Homing touches the nozzle to the plate.");
    const sound = pr.sounds && SOUND_PRINTERS.has(pr.model) ? name => tune(pr.model, name) : () => [];
    out.push("G90", "G21", ...sound("start"), "G28"); // always home: every move after this assumes a known position
    out.push(`G1 Z${f(pr.z_draw + CLEARANCE)} F${i(pr.z_feed)}`, `G0 ${xy(passes[0].strokes[0][0], 0)} ${travel}`,
      "; place the paper: the first letter goes right under the pen holder", ...sound("pause"), `G4 S${i(pr.paper_pause_s)}`,
      ...sound("resume"), down, "; attach the pen: slide it down until it touches the paper, then clamp it", ...sound("pause"),
      `G4 S${i(pr.pen_pause_s)}`, up, ...sound("resume")); // resume tune only once the pen is lifted off the paper
    passes.forEach((ps, k) => {
      out.push(`; PASS ${k + 1} of ${passes.length}: paper slid ${ps.shift} mm toward the back`);
      if (ps.hover) out.push(`G1 Z${f(Math.max(pr.z_lift, pr.z_draw + SLIDE_HOVER))} F${i(pr.z_feed)}`, // clear of wet ink
        `G0 ${xy(ps.hover, ps.shift)} ${travel}`,
        `; slide the paper ${ps.shift - passes[k - 1].shift} mm toward the back until the last mark written is right under the pen`,
        ...sound("pause"), `G4 S${i(pr.shift_pause_s)}`, ...sound("resume"), up);
      for (const s of ps.strokes) {
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
    const cfg = resolve({ ...settings, printer: { ...settings.printer, offset_x: 0, offset_y: 0 },
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
    toGcode, passNote, describe, capacity, layoutPages, MAX_PAGES, offsetTest, offsetFromTest, offsetTestMarks, placePaper, penRange };
});
