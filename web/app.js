/* Handplot web app: UI, background word generation, build-plate view, G-code export.
 * Engine: engine.js (HWEngine). Safety-critical layout/G-code: gcode.js (HWGcode). */
(() => {
  "use strict";
  const E = HWEngine, G = HWGcode, $ = id => document.getElementById(id);
  const STORE = { settings: "hw.settings", text: "hw.text", seed: "hw.seed", edits: "hw.edits", toured: "hw.toured", tips: "hw.tips", more: "hw.more" };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off: settings last this session */ } };

  // ---------- state ----------
  // Handwriting catalogue: the 13 recorded writers, plus slanted/wider versions of them (the model copies the sample's
  // geometry, so these write as genuinely different hands). bias = the neatness each style looks best at.
  const base = HW_PRESETS.map(E.decodePreset);
  const NEAT = [0, 1, 3, 5, 7, 8, 10, 12]; // reliably legible on hard words (final t's, x's, digits); 4 drops final t-bars, 2/6/9/11 are scruffy
  const CATALOG = [
    ...NEAT.map((b, i) => ["Neat", `neat-${i + 1}`, `Neat ${i + 1}`, b, 0, 1, 1.8]),
    ...NEAT.map((b, i) => ["Neat", `italic-${i + 1}`, `Italic ${i + 1}`, b, 15, 1, 1.7]),
    ...base.map((_, b) => ["Everyday", `everyday-${b + 1}`, `Everyday ${b + 1}`, b, 0, 1, 1.3]),
    ...[0, 3, 8, 12].map((b, i) => ["Everyday", `rounded-${i + 1}`, `Rounded ${i + 1}`, b, 5, 1.25, 1.4]),
    ...[1, 5, 7, 10].map((b, i) => ["Everyday", `upright-${i + 1}`, `Upright ${i + 1}`, b, -8, 1, 1.4]),
    ...[2, 6, 9].map((b, i) => ["Casual", `casual-${i + 1}`, `Casual ${i + 1}`, b, 0, 1, 0.8]),
    ...[1, 5, 7, 10, 12].map((b, i) => ["Casual", `quick-${i + 1}`, `Quick ${i + 1}`, b, 10, 1.1, 0.9]),
  ];
  const presets = CATALOG.map(([group, id, label, b, slant, width, bias]) => ({ key: "s:" + id, label, group, bias,
    data: { chars: base[b].chars, strokes: E.transformPrimer(base[b].strokes, slant, width) } }));
  const state = {
    settings: mergeSettings(load(STORE.settings, null)),
    text: load(STORE.text, "Dear friend,\n\nThis letter was written by my 3D printer, one pen stroke at a time. Can you tell?\n\nBest wishes"),
    seed: load(STORE.seed, (Math.random() * 2 ** 31) | 0),
    view: null,      // {cfg, lines, passes} of the last good layout
    error: "",
    busy: false,
    dryRun: false,      // this session only: save files that write 8 mm above the paper
    startLine: 1,       // save the page from this line on (the pen ran out or the run stopped mid-page)
    rerolls: new Map(), // a word's original seed -> how often it was clicked to be written again
    edits: loadEdits(), // word key ("word|n", see G.words) -> {dx, dy, size, style}: changes made in the preview
  };
  { // older saves named the 13 originals "9" or "p:9"
    const st = String(state.settings.writing.style), old = /^(?:p:)?(d+)$/.exec(st);
    if (old) state.settings.writing.style = `s:everyday-${+old[1] + 1}`;
    if (!state.settings.writing.style.startsWith("s:")) state.settings.writing.style = "s:neat-1";
  }

  function mergeSettings(saved) {
    const s = structuredClone(G.DEFAULT_SETTINGS);
    if (saved && typeof saved === "object")
      for (const sec of Object.keys(s)) if (saved[sec] && typeof saved[sec] === "object")
        for (const k of Object.keys(s[sec])) if (k in saved[sec]) s[sec][k] = saved[sec][k];
    return s;
  }
  const styleOf = key => presets.find(s => s.key === key);

  // ---------- word edits: move, size and handwriting per word, made in the preview ----------
  /** Saved edits, checked: storage can hold anything. The layout checks them again. */
  function loadEdits() {
    const out = new Map(), raw = load(STORE.edits, null);
    if (raw && typeof raw === "object") for (const [k, e] of Object.entries(raw)) { const c = cleanEdit(e); if (c) out.set(k, c); }
    return out;
  }
  function cleanEdit(e) {
    if (!e || typeof e !== "object") return null;
    const num = v => typeof v === "number" && Number.isFinite(v), o = {};
    if (num(e.dx) && Math.abs(e.dx) >= 0.005) o.dx = Math.round(Math.min(Math.max(e.dx, -999), 999) * 100) / 100;
    if (num(e.dy) && Math.abs(e.dy) >= 0.005) o.dy = Math.round(Math.min(Math.max(e.dy, -999), 999) * 100) / 100;
    if (num(e.size) && Math.abs(e.size - 1) >= 0.005) o.size = Math.round(Math.min(Math.max(e.size, G.WORD_SIZE[0]), G.WORD_SIZE[1]) * 100) / 100;
    if (typeof e.style === "string" && e.style) o.style = e.style;
    return Object.keys(o).length ? o : null;
  }
  /** Change the edits of these word keys: f(edit) returns the new edit; empty ones are dropped. */
  function changeEdits(keys, f) {
    remember();
    for (const k of keys) { const e = cleanEdit(f({ ...state.edits.get(k) })); if (e) state.edits.set(k, e); else state.edits.delete(k); }
    keep(STORE.edits, Object.fromEntries(state.edits));
    syncBar(); scheduleRender(0);
  }
  /** The text's words with their edits applied (G.words output, changed in place). */
  function applyEdits(paras) {
    for (const w of paras.flat()) {
      const e = state.edits.get(w.key);
      if (!e) continue;
      if (e.size) w.size = e.size;
      if (e.dx) w.dx = e.dx;
      if (e.dy) w.dy = e.dy;
      if (e.style && styleOf(e.style)) { w.style = e.style; for (const p of w.parts || []) p.style = e.style; }
    }
    return paras;
  }

  // ---------- word generation: a pool of Web Workers, each with its own copy of the model ----------
  const pool = (() => {
    const weights = E.b64ToBytes(HW_WEIGHTS_B64);
    const queue = [], later = []; // later: style previews, written once the page's words are done
    let nextId = 1, workers = [], local = null, pumpSoon = false;
    const workerSrc = `"use strict"; const HWEngine = (${E.source})();
      let model = null, runner = null, busy = false; const styles = new Map(), hands = new Map();
      // Words are written together (wordRunner) in slices of steps; between slices new jobs come in and join the batch.
      const tick = new MessageChannel();
      tick.port1.onmessage = () => {
        const end = performance.now() + 50;
        while (performance.now() < end && runner.step());
        if (runner.size) tick.port2.postMessage(0); else busy = false;
      };
      onmessage = e => { const m = e.data;
        if (m.type === "init") { model = HWEngine.loadModel(m.weights); runner = HWEngine.wordRunner(model); return; }
        if (m.type === "style") { styles.set(m.key, m.style); return; }
        for (const j of m.jobs) {
          const fail = err => postMessage({ id: j.id, error: String((err && err.message) || err) });
          try {
            let h = hands.get(j.key);
            if (!h) { h = new HWEngine.Hand(model, styles.get(j.key)); hands.set(j.key, h); }
            runner.add(h.wordSteps(j.word, j.seed, j.bias), ink => postMessage({ id: j.id, ink }), fail);
          } catch (err) { fail(err); }
        }
        if (!busy && runner.size) { busy = true; tick.port2.postMessage(0); }
      };`;
    try {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
      const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.postMessage({ type: "init", weights });
        Object.assign(w, { jobs: new Map(), styles: new Set() });
        w.onmessage = e => finish(w, e.data);
        w.onerror = e => { e.preventDefault(); fallBack(); };
        workers.push(w);
      }
    } catch { fallBack(); }

    function fallBack() { // no workers (very old browser or blocked): run on the page, slower but works
      for (const w of workers) { queue.unshift(...w.jobs.values()); w.terminate(); }
      workers = [];
      if (!local) local = { model: E.loadModel(weights), hands: new Map() };
      pump();
    }
    function finish(w, msg) {
      const job = w.jobs.get(msg.id);
      w.jobs.delete(msg.id);
      if (job) (msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg.ink));
      pump();
    }
    function pump() {
      const q = queue.length ? queue : later;
      if (local) {
        if (local.running || !q.length) return;
        local.running = true;
        setTimeout(() => { // one word per tick keeps the page responsive
          const job = q.shift();
          try {
            let h = local.hands.get(job.key);
            if (!h) { h = new E.Hand(local.model, job.style); local.hands.set(job.key, h); }
            job.resolve(h.word(job.word, job.seed, job.bias));
          } catch (err) { job.reject(err); }
          local.running = false;
          pump();
        }, 0);
        return;
      }
      // Each worker writes several words at once (the model's weights are then read from memory once for all of them)
      // and is kept one batch ahead, so its batches stay full.
      for (const w of workers) {
        for (let q = queue.length ? queue : later; w.jobs.size <= E.MAX_BATCH && q.length; q = queue.length ? queue : later) {
          if (q === later && w.jobs.size) break; // a preview primes a new style first: only on an idle worker, never holding up the page
          // prefer a style this worker has already primed (priming costs ~0.3 s per style); no more than its share
          // of that style's words, so all workers stay busy to the end
          let i = q.findIndex(j => w.styles.has(j.key));
          if (i < 0) i = 0;
          const key = q[i].key, share = Math.ceil(q.filter(j => j.key === key).length / workers.length), batch = [];
          for (let k = i; k < q.length && batch.length < Math.min(E.MAX_BATCH, share); ) if (q[k].key === key) batch.push(q.splice(k, 1)[0]); else k++;
          if (!w.styles.has(key)) { w.postMessage({ type: "style", key, style: batch[0].style }); w.styles.add(key); }
          for (const job of batch) w.jobs.set(job.id, job);
          w.postMessage({ jobs: batch.map(j => ({ id: j.id, key, word: j.word, seed: j.seed, bias: j.bias })) });
        }
      }
    }
    return {
      /** preview: a style-picker preview, written after the page's words. */
      word(style, word, seed, bias, preview = false, tag = "") {
        return new Promise((resolve, reject) => {
          (preview ? later : queue).push({ id: nextId++, key: style.key, style: style.data, word, seed, bias, tag, resolve, reject });
          if (!pumpSoon) { pumpSoon = true; queueMicrotask(() => { pumpSoon = false; pump(); }); } // once a whole page is queued
        });
      },
      cancelQueued(tag) {
        for (const q of [queue, later])
          for (let i = q.length - 1; i >= 0; i--) if (q[i].tag === tag) q.splice(i, 1)[0].reject(new Error("cancelled"));
      },
    };
  })();

  // ---------- rendering pipeline ----------
  const inkCache = new Map(); // `${style}|${bias}|${seed}|${word}` -> strokes in x-height units
  const inkKey = (style, bias, w) => `${style}|${bias}|${w.seed}|${w.word}`;
  const MARKS = "_*"; // _underline_ and *second pen*: kept through cleanText, read by G.words
  /** The text as the handwriting reads it: the symbols the layout draws itself kept; tabs as 4-space indents. */
  const source = () => E.cleanText(state.text.replace(/\t/g, "    "), MARKS + G.GLYPH_CHARS);
  const seedOrigin = new Map(); // seed of a rewritten word -> its original seed (state.rerolls is keyed by that)
  /** Words clicked to be written again get a fresh seed per click; the layout reports the new seed. */
  function rerolled(list) {
    for (const w of list) {
      const n = state.rerolls.get(w.seed);
      if (!n) continue;
      const orig = w.seed, next = v => (v + Math.imul(n, 0x9e3779b9)) >>> 0;
      w.seed = next(w.seed);
      if (w.parts) for (const part of w.parts) part.seed = next(part.seed);
      seedOrigin.set(w.seed, orig);
    }
    return list;
  }
  const startLine = v => Math.min(Math.max(1, state.startLine), v.lines.length);
  let renderToken = 0, renderTimer = 0;
  const scheduleRender = (delay = 350) => { updateCapacity(); clearTimeout(renderTimer); renderTimer = setTimeout(render, delay); };

  /** How much fits, worked out instantly from the settings (no handwriting needed). Returns the estimate or null. */
  function updateCapacity() {
    let cfg;
    try { cfg = G.resolve(state.settings); } catch { $("capacity").textContent = ""; return null; }
    const paras = G.words(source().clean, state.seed, state.settings.writing.code === true), n = paras.flat().length;
    const cap = G.capacity(cfg, charWidth(cfg.writing.style), paras);
    cap.pages = Math.max(1, Math.ceil(cap.needed / Math.max(1, cap.lines)));
    const over = n > 0 && cap.pages > G.MAX_PAGES;
    $("count").textContent = `${n} words · ≈${cap.words} per page`;
    $("count").style.color = over ? "var(--danger)" : "";
    $("capacity").className = "hint" + (over ? " warn" : "");
    $("capacity").textContent = `About ${cap.words} words fit per page (${cap.lines} lines, ≈${cap.perLine} words each).` +
      (!n ? "" : over ? ` Your text needs about ${cap.pages} pages, more than the ${G.MAX_PAGES}-page limit.`
        : cap.pages > 1 ? ` Your text needs about ${cap.pages} pages.` : ` Your text needs about ${cap.needed} of ${cap.lines} lines.`);
    return cap;
  }
  /** Average letter width of a style in x-heights, from its preview word once that exists. */
  function charWidth(key) {
    const ink = thumbs.get(key);
    if (!ink) return 0.75; // typical of the presets until the preview is ready
    let mx = 0;
    for (const s of ink) for (const p of s) mx = Math.max(mx, p[0]);
    return mx / "Handwriting".length;
  }

  async function render() {
    const token = ++renderToken;
    pool.cancelQueued("page");
    try { // the paper can't sit so far back that the pen can't reach its top border: what's lost is then at the bottom
      const c = G.resolve(state.settings), top = G.penRange(c, G.BED_INSET)[3] + c.paper.margin_y;
      if (c.paper.y + c.paper.height > top) P_().y = Math.floor(top - c.paper.height);
    } catch { /* resolve below reports it */ }
    keep(STORE.settings, state.settings); keep(STORE.text, state.text); keep(STORE.seed, state.seed);
    let cfg;
    try { cfg = G.resolve(state.settings); } catch (e) { return fail(e); } // says which setting, and quickFix may offer the fix
    const style = styleOf(cfg.writing.style);
    if (!style) return fail(new Error("That handwriting style is gone. Pick another one."));
    const { clean, dropped } = source(), head = E.cleanText(cfg.writing.header, MARKS + G.GLYPH_CHARS);
    for (const c of head.dropped) dropped.add(c);
    $("skipped").hidden = !dropped.size;
    $("skipped").textContent = dropped.size ? `Skipped characters the handwriting can't write: ${[...dropped].join(" ")}` : "";
    const paras = applyEdits(G.words(clean, state.seed, cfg.writing.code)), all = rerolled(paras.flat());
    const changed = all.filter(w => state.edits.has(w.key)).length;
    $("editsNote").hidden = !changed;
    $("editsCount").textContent = `${changed} word${changed === 1 ? "" : "s"} changed in the preview.`;
    const cap = updateCapacity();
    // Clearly too long: say so now instead of writing every word first (borderline cases are decided by the real layout).
    if (cap && cap.pages > G.MAX_PAGES * 1.2)
      return fail(new G.WriteError(`Too much text: it needs about ${cap.pages} pages (${G.MAX_PAGES} at most). Shorten it, use smaller letters or bigger paper.`));
    if (!all.length) { state.view = null; state.error = ""; setBusy(false, "Type some text"); draw(); return updateSummary(); }
    const long = all.find(w => (w.parts || [w]).some(p => !p.glyph && p.word.length > G.MAX_WORD));
    if (long) return fail(new Error(`The word "${long.word.slice(0, 20)}…" is too long (${G.MAX_WORD} letters at most).`));

    const bias = cfg.writing.bias;
    const keyOf = w => inkKey(w.style || style.key, bias, w); // a word can have its own handwriting
    const missing = ws => [...new Map(ws.flatMap(w => w.parts || [w]).filter(w => !w.glyph && !inkCache.has(keyOf(w))).map(w => [keyOf(w), w])).values()]; // drawn symbols need no model
    /** Have the workers write these words into inkCache. False if this render was replaced or failed (fail() shown). */
    const generate = async list => {
      if (!list.length) return true;
      let done = 0;
      setBusy(true, `Writing 0 / ${list.length} words`);
      try {
        await Promise.all(list.map(w => pool.word(styleOf(w.style) || style, w.word, w.seed, bias, false, "page").then(ink => {
          inkCache.set(keyOf(w), ink);
          if (token === renderToken) setBusy(true, `Writing ${++done} / ${list.length} words`);
        })));
        return token === renderToken;
      } catch (e) {
        if (token !== renderToken || e.message === "cancelled") return false;
        fail(e, "The handwriting model failed: ");
        return false;
      }
    };
    // Header line: every sheet's is written afresh, so its words exist per sheet. Those for the estimated pages are
    // written with the text; a sheet beyond that asks for its own (layoutPages stops, they're written, it runs again).
    const withHeader = head.clean.trim() !== "" || cfg.writing.page_numbers;
    const headerFor = k => G.headerWords(head.clean, cfg.writing.page_numbers, state.seed, k).map(rerolled);
    const headerAhead = k => Array.from({ length: 3 }, (_, j) => headerFor(k + j).flat()).flat();
    if (!(await generate(missing([...all, ...(withHeader ? headerAhead(0) : [])])))) return;
    let pages;
    for (let attempt = 0; ; attempt++) {
      if (token !== renderToken) return;
      if (attempt > G.MAX_PAGES) return fail(new Error("The header words couldn't be written."));
      try {
        const rng = E.makeRng((state.seed ^ 0x5bd1e995) >>> 0); // layout randomness, separate from the words'
        const opts = !withHeader ? {} : { header: k => {
          const hw = headerFor(k);
          if (missing(hw.flat()).length) throw Object.assign(new Error("header words needed"), { needPage: k });
          return hw;
        } };
        pages = G.layoutPages(paras, w => inkCache.get(keyOf(w)), cfg, rng, G.MAX_PAGES, opts).map((lines, k, all) => {
          try { return { lines, passes: G.planPasses(lines, cfg) }; }
          catch (e) { if (all.length > 1) e.message = `Page ${k + 1}: ${e.message}`; throw e; }
        });
        break;
      } catch (e) {
        if (e.needPage === undefined) return fail(e);
        if (!(await generate(missing(headerAhead(e.needPage))))) return;
      }
    }
    state.view = { cfg, pages };
    hover = null; // the word boxes are new
    state.page = Math.min(state.page || 0, pages.length - 1);
    state.error = "";
    setBusy(false, "Ready");
    if (sel && !selected().length) select(null); // its words are gone (text changed) or on another page
    draw(); updateSummary(); syncBar();
    if (!load(STORE.toured, false)) startTour(); // first visit: show what each part is for, once the page is there
    else if (pages.length > 1) tipOnce("pages", `Your text runs onto ${pages.length} pages. Use the arrows above the preview to see each one, and Save all pages to get them all.`);
  }

  /** The page on screen: {cfg, lines, passes}, or null. */
  const cur = () => state.view ? { cfg: state.view.cfg, ...state.view.pages[state.page] } : null;
  const pageFile = (k, n) => `${String(k + 1).padStart(n >= 10 ? 2 : 1, "0")}_page.gcode`; // 01.. so 10 sorts after 9

  function fail(e, prefix = "") {
    state.error = prefix + (e && e.message || String(e));
    state.view = null; // never show (or save) handwriting that no longer matches the settings
    if (!(e instanceof G.WriteError) && !prefix) console.error(e);
    setBusy(false, "Needs attention", true);
    draw(); updateSummary();
  }
  function setBusy(busy, text, err = false) {
    state.busy = busy;
    $("status").className = "pill" + (busy ? " busy" : err ? " err" : "");
    const m = /(\d+) \/ (\d+)/.exec(text); $("status").style.setProperty("--p", busy && m ? (m[1] / m[2]).toFixed(3) : "0"); // pill progress
    $("statusText").textContent = text;
    $("save").disabled = $("saveAll").disabled = busy || !state.view || !!state.error;
  }
  function updateSummary() {
    $("error").hidden = !state.error;
    $("error").textContent = state.error;
    const fix = state.error && quickFix(state.error);
    if (fix) { const b = document.createElement("button"); b.type = "button"; b.className = "fix"; b.textContent = fix[0]; b.onclick = fix[1]; $("error").append(b); }
    syncMore();
    const v = cur(), n = state.view ? state.view.pages.length : 0;
    $("pager").hidden = n < 2; $("saveAll").hidden = n < 2;
    const tags = [state.dryRun && "dry run", v && startLine(v) > 1 && `from line ${startLine(v)}`].filter(Boolean).join(", ");
    $("save").textContent = (n > 1 ? `Save page ${state.page + 1}` : "Save G-code") + (tags ? ` (${tags})` : "");
    if (n > 1) { $("pageLabel").textContent = `Page ${state.page + 1} of ${n}`; $("saveAll").textContent = `Save all ${n} pages` + (state.dryRun ? " (dry run)" : ""); }
    if (v) $("startLine").max = v.lines.length;
    $("prevPage").disabled = state.page <= 0; $("nextPage").disabled = state.page >= n - 1;
    $("summary").hidden = !v || !!state.error;
    if (!v || state.error) return;
    const t = eta(v), all = n > 1 ? eta(state.view.pages.reduce((sum, p) => sum + estimate({ cfg: v.cfg, passes: p.passes }), 0)) : null;
    $("summary").innerHTML = (all ? `⏱ Page ${state.page + 1}: about <b>${t.dur}</b> · all ${n} pages: about <b>${all.dur}</b> (plus changing paper)<br>`
      : `⏱ Writing takes about <b>${t.dur}</b> · done around <b>${t.at}</b> if you start now<br>`) +
      `${v.cfg.printer.model} · ${v.cfg.paper.size} ${v.cfg.paper.orientation}` +
      (v.passes.length > 1 ? `<br>${escapeHtml(G.passNote(v.passes))}` : "");
  }
  const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /** True if the file swaps pens: pen 1 and pen 2 (*marked*) strokes in it (only ever in one pass). */
  const penChange = passes => passes.length === 1 && passes[0].strokes.some(s => s.pen === G.PEN2) && passes[0].strokes.some(s => s.pen !== G.PEN2);
  /** Rough print time: drawing + travel + pen up/down + pauses. */
  function estimate({ cfg, passes }) {
    const pr = cfg.printer, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let draw = 0, travel = 0, lifts = 0, last = null;
    for (const ps of passes) for (const s of ps.strokes) {
      if (last) travel += d(last, s[0]);
      for (let i = 1; i < s.length; i++) draw += d(s[i - 1], s[i]);
      last = s[s.length - 1]; lifts++;
    }
    const zTime = 2 * Math.abs(pr.z_lift - pr.z_draw) / pr.z_feed * 60 + 2 * pr.settle_ms / 1000;
    const change = penChange(passes) ? 1 : 0;
    const sec = draw / pr.draw_feed * 60 * 1.3 + travel / pr.travel_feed * 60 * 1.5 + lifts * zTime +
      pr.paper_pause_s + pr.pen_pause_s * (1 + 2 * change) + (passes.length - 1) * pr.shift_pause_s + 40; // +40 s homing
    if (pr.sounds && G.SOUND_PRINTERS.has(pr.model)) { // each tune: a 1 s wait, then its lines (10 ms units, the longest channel)
      const t = name => 1 + G.tuneOf(pr.model, name).reduce((a, s) => a + Math.max(s[1], s[4], s[7]), 0) / 100;
      return sec + t("start") + t("finish") + (2 + (passes.length - 1) + change) * (t("pause") + t("resume"));
    }
    return sec;
  }
  /** "about 14 min, done around 3:42 pm if you start now" */
  function eta(v) {
    const sec = typeof v === "number" ? v : estimate(v);
    const dur = sec < 90 ? `${Math.round(sec / 10) * 10} s` : sec < 3600 ? `${Math.round(sec / 60)} min`
      : `${Math.floor(sec / 3600)} h ${Math.round(sec % 3600 / 60)} min`;
    const at = new Date(Date.now() + sec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return { dur, at };
  }
  setInterval(() => { if (state.view && !state.error) updateSummary(); }, 60000); // keep "done around" current

  // ---------- build-plate view ----------
  const canvas = $("plate"), ctx = canvas.getContext("2d"), stageEl = canvas.closest(".stage");
  // fit: "plate" (the whole plate), "paper" (full screen: the whole paper), or null (zoomed in: cx, cy, zoom stay as set).
  // Whatever it follows is fitted again on every draw, so a rotation or the browser's bars coming and going can't move
  // the page off screen.
  const view = { fit: "plate", zoom: 1, fitZoom: 1, cx: null, cy: null, s: 1, ox: 0, oy: 0, base: 0, W: 0, H: 0, by: 0 };
  if (new URLSearchParams(location.search).has("test")) window.__hwView = view; // read by the phone tests (phone.js); nothing else uses it
  let drag = null;
  let sel = null; // selected word(s): {key: the word clicked, keys: what changes (it, or its whole line), lineKeys, line: bool}
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function plateCfg() { // what to draw: the last layout's cfg, or the settings alone when there is no layout yet
    try { const c = G.resolve(state.settings); return c; } catch { return state.view && state.view.cfg; }
  }
  function draw() {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cfg = plateCfg();
    if (!cfg || !W || !H) return; // no size yet (mid-layout): nothing to fit the view to
    const pr = cfg.printer, p = cfg.paper, bx = pr.bed_x, by = pr.bed_y, dx = pr.offset_x, dy = pr.offset_y;
    const base = Math.min(W / (bx * 1.35), H / (by * 1.35)), full = stageEl.classList.contains("full");
    if (view.fit === "plate") Object.assign(view, { zoom: 1, fitZoom: 1, cx: null, cy: null });
    else if (view.fit === "paper") paperView(p, base, W, H);
    const s = base * view.zoom;
    // the view's centre in bed mm: the plate's middle, or the spot zoomed into; never so far that less than 40 px of the
    // paper (full screen) or the plate stays on screen, so a zoomed page can't be lost
    const [l0, t0, l1, t1] = full ? [p.x, p.y, p.x + p.width, p.y + p.height] : [dx, dy, dx + bx, dy + by];
    const kx = Math.max(0, W / 2 - 40) / s, ky = Math.max(0, H / 2 - 40) / s;
    const cx = Math.min(Math.max(view.cx ?? dx + bx / 2, l0 - kx), l1 + kx), cy = Math.min(Math.max(view.cy ?? dy + by / 2, t0 - ky), t1 + ky);
    if (view.cx !== null) Object.assign(view, { cx, cy });
    Object.assign(view, { s, base, W, H, by, ox: W / 2 - cx * s, oy: H / 2 - (by - cy) * s });
    const X = x => view.ox + x * s, Y = y => view.oy + (by - y) * s;

    // plate + grid, drawn where the pen tip can go (the nozzle's travel moved by the pen offset, like the cutter
    // corner below), so the strip the pen can't use shows at the front, where the pen would leave the real plate
    const plate = () => roundRect(X(dx), Y(by + dy), bx * s, by * s, 6 * Math.min(1, s));
    ctx.fillStyle = "#2A2B2D"; plate(); ctx.fill();
    ctx.lineWidth = 1;
    for (let g = 10; g < Math.max(bx, by); g += 10) {
      if (g % 50 && s * 10 < 12) continue; // fine grid only when zoomed in enough to tell lines apart
      ctx.strokeStyle = g % 50 ? "#333538" : "#3E4044";
      if (g < bx) line(X(g + dx), Y(dy), X(g + dx), Y(by + dy));
      if (g < by) line(X(dx), Y(g + dy), X(bx + dx), Y(g + dy));
    }
    ctx.save(); plate(); ctx.clip(); // shade where the pen would be past the real plate's edges
    ctx.beginPath(); ctx.rect(X(dx), Y(by + dy), bx * s, by * s); ctx.rect(X(0), Y(by), bx * s, by * s);
    ctx.fillStyle = "rgba(150,140,125,.42)"; ctx.fill("evenodd"); ctx.restore();
    for (const [a, b, c, d] of pr.keepouts) { // nozzle may not go here (e.g. P1/X1 filament cutter); shown where the pen would be
      ctx.fillStyle = "rgba(184,58,46,.35)";
      ctx.fillRect(X(a + pr.offset_x), Y(d + pr.offset_y), (c - a) * s, (d - b) * s);
    }
    // paper (in pass 1 position) + writing area
    const pX = px => X(p.x + px), pY = py => Y(p.y + p.height - py);
    ctx.fillStyle = css("--sheet") || "#FFFDF8"; ctx.shadowColor = "rgba(40,30,15,.30)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
    ctx.fillRect(pX(0), pY(0), p.width * s, p.height * s); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    if (p.ruling > 0) { // ruled paper: its printed lines and margin line, to check the writing sits on them
      ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(90,140,220,.45)";
      for (let yy = p.first_line; yy < p.height; yy += p.ruling) line(pX(0), pY(yy), pX(p.width), pY(yy));
      if (p.margin_line > 0) { ctx.strokeStyle = "rgba(220,80,80,.55)"; line(pX(p.margin_line), pY(0), pX(p.margin_line), pY(p.height)); }
    }
    // shade the part inside the borders that can't be written on (past the pen's reach), page coords [x0, y0, x1, y1]
    const [l, t, r, b] = G.writingArea(cfg), m = p.margin, my = p.margin_y, w = p.width, h = p.height;
    const lost = [[m, my, w - m, t], [m, b, w - m, h - my], [m, t, l, b], [r, t, w - m, b]]
      .filter(([a, b2, c, d]) => c - a > 0.5 && d - b2 > 0.5);
    ctx.fillStyle = "rgba(150,140,125,.42)";
    for (const [a, b2, c, d] of lost) ctx.fillRect(pX(a), pY(b2), (c - a) * s, (d - b2) * s);
    if (r > l && b > t) { ctx.setLineDash([5, 4]); ctx.strokeStyle = "#6F92CC"; ctx.strokeRect(pX(l), pY(t), (r - l) * s, (b - t) * s); }
    // handwriting
    const v = cur();
    if (v) {
      ctx.setLineDash([]); ctx.lineWidth = Math.max(0.8, 0.5 * s); ctx.lineCap = ctx.lineJoin = "round";
      const from = startLine(v), paths = [new Path2D(), new Path2D(), new Path2D()]; // already written, pen 1, pen 2
      const [ox, oy] = drag && drag.kind === "word" && drag.moved ? drag.delta : [0, 0];
      v.lines.forEach((ln, k) => {
        const lifted = new Set(); // strokes of the selected words while they are being dragged
        if (ox || oy) for (const w of ln.words || []) if (sel.keys.includes(w.key)) for (let j = w.s0; j < w.s1; j++) lifted.add(j);
        ln.forEach((st, j) => {
          const path = paths[k < from - 1 ? 0 : st.pen === G.PEN2 ? 2 : 1], ax = lifted.has(j) ? ox : 0, ay = lifted.has(j) ? oy : 0;
          path.moveTo(pX(st[0][0] + ax), pY(st[0][1] + ay));
          if (st.length === 1) path.lineTo(pX(st[0][0] + ax) + 0.01, pY(st[0][1] + ay));
          for (let i = 1; i < st.length; i++) path.lineTo(pX(st[i][0] + ax), pY(st[i][1] + ay));
        });
      });
      ["#C9C2B5", "#1B2A6B", "#B23A2B"].forEach((c, j) => { ctx.strokeStyle = c; ctx.stroke(paths[j]); });
      const outline = ([a, b2, c, d], fill, width, dash = []) => {
        ctx.setLineDash(dash); ctx.fillStyle = fill; ctx.fillRect(pX(a) - 3, pY(b2) - 3, (c - a) * s + 6, (d - b2) * s + 6);
        ctx.strokeStyle = "#22367A"; ctx.lineWidth = width; ctx.strokeRect(pX(a) - 3, pY(b2) - 3, (c - a) * s + 6, (d - b2) * s + 6); ctx.setLineDash([]);
      };
      if (hover && !(sel && sel.keys.includes(hover.key))) outline(hover.box, "rgba(34,54,122,.10)", 1);
      const picked = selected();
      for (const w of picked) { const [a, b2, c, d] = w.box; outline([a + ox, b2 + oy, c + ox, d + oy], "rgba(34,54,122,.16)", w.key === sel.key ? 2 : 1, w.key === sel.key ? [] : [4, 3]); }
      if (picked.length) {
        const [a, b2, c, d] = G.extent(picked.map(w => [[w.box[0], w.box[1]], [w.box[2], w.box[3]]]));
        placeBar(pX(a + ox), pY(b2 + oy), pX(c + ox), pY(d + oy), W, H);
      }
      if (from > 1 || document.activeElement === $("startLine")) // line numbers, to pick where to start again
        v.lines.forEach((ln, k) => label(String(k + 1), pX(G.extent(ln)[0]) - 10, pY(ln.baseline), k < from - 1 ? "#6B6255" : "#22367A", "right", css("--sheet"))); // on the paper, which stays light
      // where the paper gets slid between passes
      for (let k = 1; k < v.passes.length; k++) {
        const prevB = G.extent(v.passes[k - 1].strokes)[3], nextT = G.extent(v.passes[k].strokes)[1], yy = (prevB + nextT) / 2;
        ctx.setLineDash([6, 4]); ctx.strokeStyle = "#B83A2E"; ctx.lineWidth = 1.5;
        line(pX(0), pY(yy), pX(p.width), pY(yy));
        label(`pass ${k + 1}: slide paper ${v.passes[k].shift - v.passes[k - 1].shift} mm back`, pX(p.width) - 6, pY(yy) - 6, "#A3301E", "right", css("--sheet"));
      }
    }
    ctx.setLineDash([7, 5]); ctx.strokeStyle = "#D9861E"; ctx.lineWidth = 2; ctx.strokeRect(X(dx), Y(by + dy), bx * s, by * s);
    ctx.setLineDash([]);
    const area = q => (q[2] - q[0]) * (q[3] - q[1]), big = lost.reduce((m, q) => (!m || area(q) > area(m) ? q : m), null);
    if (big && (big[3] - big[1]) * s > 24 && (big[2] - big[0]) * s > 120) // at its top edge, clear of the chips at the bottom
      label("pen can't reach", pX((big[0] + big[2]) / 2), pY(big[1]) + 19, css("--muted"), "center");
    if (!full) label(`${pr.model} · plate ${bx} × ${by} mm`, 14, 22, css("--muted"), "left");
    const fy = Y(dy) + 22;
    if (!full || fy <= H - 12) // just under the plate, above the chips; zoomed onto the paper in full screen, only if the front edge shows
      label("FRONT OF PRINTER", X(dx + bx / 2), full ? fy : Math.min(fy, H - 58), css("--muted"), "center");
  }
  /** The word bar sits just under the selection (above it when there's no room), inside the preview. */
  function placeBar(x0, y0, x1, y1, W, H) {
    const bar = $("wordBar");
    if (bar.hidden) return;
    const bw = bar.offsetWidth, bh = bar.offsetHeight, gap = 12;
    if (getComputedStyle(bar).getPropertyValue("--dock").trim() === "1") { // phones: full width along the bottom of the preview, or just
      const low = Math.max(8, H - bh - 8); // above the selection if that would hide it (in full screen the view moves instead)
      bar.style.left = ""; bar.style.top = `${canvas.offsetTop + (stageEl.classList.contains("full") || y1 + 4 <= low ? low : Math.max(8, y0 - bh - 8))}px`;
      return;
    }
    const x = Math.max(gap, Math.min((x0 + x1) / 2 - bw / 2, W - bw - gap));
    let y = y1 + gap + 4;
    if (y + bh > H - gap) y = y0 - bh - gap - 4;
    y = Math.max(gap, Math.min(y, H - bh - gap));
    bar.style.left = `${canvas.offsetLeft + x}px`; bar.style.top = `${canvas.offsetTop + y}px`;
  }
  /** Full screen: the whole paper, as big as it fits below or beside the toolbar (whichever shows it bigger), centred there. */
  function paperView(p, base, W, H) {
    const c = canvas.getBoundingClientRect(), t = $("zoomFull").parentElement.getBoundingClientRect(), m = 12;
    const bottom = H - m - ($("pager").hidden ? 0 : 56);
    let best = null;
    for (const [x0, y0, x1, y1] of [[m, t.bottom - c.top + 8, W - m, bottom], [m, m, t.left - c.left - 8, bottom]]) {
      const k = Math.min((x1 - x0) / (p.width * 1.04), (y1 - y0) / (p.height * 1.04));
      if (k > 0 && (!best || k > best.k)) best = { k, mx: (x0 + x1) / 2, my: (y0 + y1) / 2 };
    }
    if (!best) return;
    Object.assign(view, { zoom: best.k / base, fitZoom: best.k / base,
      cx: p.x + p.width / 2 + (W / 2 - best.mx) / best.k, cy: p.y + p.height / 2 + (best.my - H / 2) / best.k });
  }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function label(text, x, y, color, align, bg) {
    ctx.font = `600 12px ${css("--font-sans") || "system-ui, sans-serif"}`; ctx.textAlign = align; ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(text).width, x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    ctx.fillStyle = bg || css("--panel") || "#fff"; ctx.globalAlpha = .92; roundRect(x0 - 7, y - 15, w + 14, 21, 6); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function toBed(e) { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left - view.ox) / view.s, view.by - (e.clientY - r.top - view.oy) / view.s]; }
  function onPaper(e) {
    const cfg = plateCfg(); if (!cfg) return false;
    const [x, y] = toBed(e), p = cfg.paper;
    return x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height;
  }
  /** The word nearest the pointer on the page shown, within padPx of it (a fingertip): {w: {seed, key, box, s0, s1}, ln: its line}, or null. */
  function wordAt(e, padPx = 0) {
    const v = cur(), cfg = plateCfg();
    if (!v || !cfg || state.busy) return null;
    const [bx, by] = toBed(e), p = cfg.paper, x = bx - p.x, y = p.y + p.height - by, pad = Math.max(0.6, padPx / view.s);
    let best = null, bestD = Infinity;
    for (const ln of v.lines) for (const w of ln.words || []) {
      const d = Math.hypot(Math.max(w.box[0] - x, 0, x - w.box[2]), Math.max(w.box[1] - y, 0, y - w.box[3]));
      if (d <= pad && d < bestD) { best = { w, ln }; bestD = d; }
    }
    return best;
  }
  /** What a finger pressing here takes hold of: {kind: "word" | "paper" | "pan" | "tap", hit: the word nearest it}.
   *  The selected word; in full screen at the whole-page view any word (nothing else moves there). The paper only in
   *  the normal view: full screen shows too little of the plate to place it, so a finger that misses a word can't move it. */
  function fingerGrab(e) {
    const near = wordAt(e, 14), pan = zoomedIn();
    if (near && !isFixed(near.w.key) && (isFull() && !pan || sel && sel.keys.includes(near.w.key))) return { kind: "word", hit: near };
    return { kind: !isFull() && onPaper(e) ? "paper" : pan ? "pan" : "tap", hit: near };
  }
  let hover = null; // word under the mouse
  const isFull = () => stageEl.classList.contains("full");
  const touches = new Map(); // finger -> [x, y] in the preview
  let lastTap = null; // the previous finger tap, for double-tap
  const inView = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const zoomedIn = () => view.fit === null && view.zoom > view.fitZoom * 1.02;
  canvas.addEventListener("pointerdown", e => {
    const touch = e.pointerType === "touch";
    if (touch) touches.set(e.pointerId, inView(e));
    if (touch && touches.size === 2 && isFull()) { // two fingers in full screen: pinch to zoom, move them to look around
      const [a, b] = [...touches.values()], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (drag && drag.kind === "word" && drag.moved) draw(); // a half-dragged word goes back
      drag = { kind: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z0: view.zoom, ax: (mx - view.ox) / view.s, ay: view.by - (my - view.oy) / view.s };
      return;
    }
    if (touches.size > 1) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer can't be captured */ }
    const p = state.settings.paper;
    if (touch) { // a finger: nothing changes until it moves (a tap, or a second finger for a pinch, picks nothing up)
      drag = { ...fingerGrab(e), start: toBed(e), x: p.x, y: p.y, sx: e.clientX, sy: e.clientY, cx: view.cx, cy: view.cy, moved: false, delta: [0, 0] };
      return;
    }
    const hit = e.button === 0 ? wordAt(e) : null;
    if (hit) { // a word: select it (unless it's part of the selection already) and maybe drag it
      if (!sel || !sel.keys.includes(hit.w.key)) select(hit.w, hit.ln);
      drag = { kind: isFixed(hit.w.key) ? "none" : "word", start: toBed(e), sx: e.clientX, sy: e.clientY, moved: false, delta: [0, 0] };
      return draw();
    }
    drag = e.button === 0 && onPaper(e) ? { kind: "paper", start: toBed(e), x: p.x, y: p.y, sx: e.clientX, sy: e.clientY, moved: false }
      : { kind: "bg", sx: e.clientX, sy: e.clientY, moved: false }; // beside the paper: the plate stays put (a click deselects)
  });
  canvas.addEventListener("pointermove", e => {
    const touch = e.pointerType === "touch";
    if (touch && touches.has(e.pointerId)) touches.set(e.pointerId, inView(e));
    if (drag && drag.kind === "pinch") {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const zoom = Math.min(Math.max(drag.z0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / drag.d0, view.fitZoom * 0.8), 14), k = view.base * zoom;
      Object.assign(view, { fit: null, zoom, cx: drag.ax + (view.W / 2 - mx) / k, cy: drag.ay + (my - view.H / 2) / k }); // the spot between the fingers stays there
      return draw();
    }
    if (!drag) {
      if (touch) return;
      const hit = wordAt(e), w = hit && hit.w;
      if ((w && w.key) !== (hover && hover.key)) { hover = w; draw(); }
      canvas.style.cursor = w ? (sel && sel.keys.includes(w.key) && !isFixed(w.key) ? "move" : "pointer") : onPaper(e) ? "grab" : "default";
      return;
    }
    if (drag.kind === "none") return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < (touch ? 10 : 4)) return; // still a tap or a click
    drag.moved = true;
    if (drag.kind === "word" && drag.hit && (!sel || !sel.keys.includes(drag.hit.w.key))) select(drag.hit.w, drag.hit.ln); // a finger picks the word up
    if (drag.kind === "tap") return; // a finger sliding over the whole-page view: the plate stays put
    if (drag.kind === "pan") { // a zoomed-in page follows the finger
      Object.assign(view, { cx: drag.cx - (e.clientX - drag.sx) / view.s, cy: drag.cy + (e.clientY - drag.sy) / view.s });
      return draw();
    }
    canvas.style.cursor = drag.kind === "word" ? "move" : drag.kind === "bg" ? "default" : "grabbing";
    if (drag.kind === "word") { // mm on the page (y down), kept on the paper; drawn live, laid out when let go
      const [x, y] = toBed(e);
      drag.delta = fitMove(x - drag.start[0], drag.start[1] - y);
      return draw();
    }
    if (drag.kind === "bg") return;
    hover = null;
    const cfg = plateCfg(); if (!cfg) return;
    const [x, y] = toBed(e), p = state.settings.paper, pr = cfg.printer;
    // keep at least 20 mm of paper over the plate so it can't be lost
    p.x = Math.round(Math.min(Math.max(drag.x + x - drag.start[0], 20 - cfg.paper.width), pr.bed_x - 20));
    p.y = Math.round(Math.min(Math.max(drag.y + y - drag.start[1], 20 - cfg.paper.height), pr.bed_y - 20));
    relayout();
  });
  function pointerEnd(e, cancelled) {
    const touch = e.pointerType === "touch";
    if (touch) touches.delete(e.pointerId);
    const d = drag;
    if (d && d.kind === "pinch") { // both fingers up: zoomed out as far as the whole page means the whole page again
      if (touches.size) return;
      drag = null;
      if (view.zoom <= view.fitZoom * 1.02) { view.fit = "paper"; draw(); }
      return;
    }
    drag = null;
    if (!d) return;
    if (cancelled) { if (d.kind === "word" && d.moved) draw(); return; } // the browser took over (the page scrolled): nothing happens
    if (touch && !d.moved) return tapAt(e, d.hit);
    if (d.kind === "word" && d.moved) return moveBy(...d.delta);
    if (d.kind === "paper" && d.moved) return scheduleRender(0);
    if ((d.kind === "paper" || d.kind === "bg") && !d.moved && sel) { select(null); draw(); } // a click beside the words: done
  }
  canvas.addEventListener("pointerup", e => pointerEnd(e, false));
  canvas.addEventListener("pointercancel", e => pointerEnd(e, true));
  canvas.addEventListener("pointerleave", e => { if (e.pointerType !== "touch" && hover && !drag) { hover = null; draw(); } });
  canvas.addEventListener("touchstart", e => { // the normal view on a phone: a finger moving the paper or a word mustn't scroll the page too
    const t = e.touches[0];
    if (!isFull() && e.touches.length === 1 && /^(paper|word)$/.test(fingerGrab({ clientX: t.clientX, clientY: t.clientY }).kind)) e.preventDefault();
  }, { passive: false });
  /** A finger tap: on a word its bar opens, elsewhere it closes. In full screen, two quick taps zoom in there, or back out. */
  function tapAt(e, hit) {
    const now = e.timeStamp || performance.now(), [x, y] = inView(e); // when the finger lifted, not when this ran
    if (isFull() && lastTap && now - lastTap.t < 350 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
      lastTap = null;
      if (zoomedIn()) { view.fit = "paper"; draw(); } else zoomAt(2.5, e);
      return;
    }
    lastTap = { t: now, x, y };
    if (hit) { if (!sel || !sel.keys.includes(hit.w.key)) select(hit.w, hit.ln); requestAnimationFrame(revealSelection); }
    else if (sel) select(null);
    draw();
  }
  /** Write these words again: each gets the next fresh seed, the rest of the page keeps its handwriting. */
  function rewriteWords(seeds) {
    remember();
    for (const seed of seeds) {
      const orig = seedOrigin.get(seed) ?? seed;
      state.rerolls.set(orig, (state.rerolls.get(orig) || 0) + 1);
    }
    hover = null;
    scheduleRender(0);
  }

  // ---------- the selection and its editor bar ----------
  const isFixed = key => key.startsWith("header"); // header words are written afresh per sheet: no lasting edits
  const wordText = key => key.replace(/^header\d+:/, "").replace(/\|\d+$/, "");
  /** The selected words on the page shown, from the last layout: [{seed, key, box, s0, s1}]. */
  function selected() {
    const v = cur();
    if (!sel || !v) return [];
    return v.lines.flatMap(ln => (ln.words || []).filter(w => sel.keys.includes(w.key)));
  }
  function select(w, ln) {
    sel = w ? { key: w.key, keys: [w.key], lineKeys: (ln.words || []).map(x => x.key).filter(k => !isFixed(k)), line: false } : null;
    $("wordBar").classList.remove("adding");
    syncBar();
    if (!w && isFull() && view.fit === null && view.zoom <= view.fitZoom * 1.02) view.fit = "paper"; // moved only to show the word
  }
  /** Full screen on a phone: if the word bar along the bottom covers the selected word, the view moves up to show it. */
  function revealSelection() {
    const bar = $("wordBar"), ws = selected(), v = cur();
    if (bar.hidden || !ws.length || !isFull() || !v || getComputedStyle(bar).getPropertyValue("--dock").trim() !== "1") return;
    const p = v.cfg.paper, low = Math.max(...ws.map(w => view.oy + (view.by - (p.y + p.height - w.box[3])) * view.s));
    const limit = bar.offsetTop - canvas.offsetTop - 12;
    if (low <= limit) return;
    Object.assign(view, { fit: null, cx: (view.W / 2 - view.ox) / view.s, cy: view.by - (view.H / 2 - view.oy) / view.s - (low - limit) / view.s });
    draw();
  }
  function setLine(line) {
    if (!sel || isFixed(sel.key)) return;
    sel.line = line; sel.keys = line ? sel.lineKeys : [sel.key];
    syncBar(); draw();
  }
  /** The bar shows what is selected and its current size and handwriting. */
  function syncBar() {
    const bar = $("wordBar");
    bar.hidden = !sel;
    if (!sel) return;
    const fixed = isFixed(sel.key), e = state.edits.get(sel.key) || {};
    bar.classList.toggle("fixed-word", fixed);
    $("wbLabel").textContent = `“${(sel.line ? sel.keys : [sel.key]).map(wordText).join(" ")}”`;
    $("wbWord").setAttribute("aria-pressed", !sel.line); $("wbLine").setAttribute("aria-pressed", sel.line);
    $("wbAdd").textContent = sel.line ? "+ Add line" : "+ Add word";
    $("wbAddText").placeholder = sel.line ? "A new line to go under this one" : `Words to add after “${wordText(sel.key)}”`;
    $("wbSize").textContent = `${Math.round((e.size || 1) * 100)}%`;
    const styles = new Set(sel.keys.map(k => (state.edits.get(k) || {}).style || ""));
    $("wbStyle").value = styles.size === 1 ? [...styles][0] : "";
  }
  /** A move (mm, y down) cut short so the selected words stay on the paper. */
  function fitMove(dx, dy) {
    const v = cur(), ws = selected();
    if (!v || !ws.length) return [0, 0];
    const p = v.cfg.paper, [a, b, c, d] = G.extent(ws.map(w => [[w.box[0], w.box[1]], [w.box[2], w.box[3]]]));
    return [Math.min(Math.max(dx, -a), p.width - c), Math.min(Math.max(dy, -b), p.height - d)];
  }
  function moveBy(dx, dy) {
    if (!sel || isFixed(sel.key)) return;
    [dx, dy] = fitMove(dx, dy);
    if (dx || dy) changeEdits(sel.keys, e => ({ ...e, dx: (e.dx || 0) + dx, dy: (e.dy || 0) + dy }));
  }
  function resizeBy(step) {
    if (!sel || isFixed(sel.key)) return;
    changeEdits(sel.keys, e => ({ ...e, size: Math.min(Math.max(Math.round(((e.size || 1) + step) * 10) / 10, G.WORD_SIZE[0]), G.WORD_SIZE[1]) }));
  }
  { // the bar's handwriting list: the page's own, then every style by group
    const box = $("wbStyle"), page = new Option("Page handwriting", "");
    box.append(page);
    let group = null;
    for (const st of presets) {
      if (!group || group.label !== st.group) { group = document.createElement("optgroup"); group.label = st.group; box.append(group); }
      group.append(new Option(st.label, st.key));
    }
  }
  const STEP = e => (e && e.shiftKey ? 5 : 0.5); // mm per press
  $("wbLeft").onclick = e => moveBy(-STEP(e), 0); $("wbRight").onclick = e => moveBy(STEP(e), 0);
  $("wbUp").onclick = e => moveBy(0, -STEP(e)); $("wbDown").onclick = e => moveBy(0, STEP(e));
  $("wbSmaller").onclick = () => resizeBy(-0.1); $("wbBigger").onclick = () => resizeBy(0.1);
  $("wbStyle").onchange = e => { const v = e.target.value; changeEdits(sel ? sel.keys : [], ed => ({ ...ed, style: v || undefined })); };
  $("wbReset").onclick = () => changeEdits(sel ? sel.keys : [], () => null);
  $("wbAgain").onclick = () => rewriteWords(selected().map(w => w.seed));
  $("wbWord").onclick = () => setLine(false); $("wbLine").onclick = () => setLine(true);
  $("wbClose").onclick = () => { select(null); draw(); };

  /** The text box's words as the page keys them ("word|n", like G.words), each with where it ends in the text. */
  function textWords(text) {
    const keep = MARKS + G.GLYPH_CHARS, code = W_().code === true, seen = new Map(), out = [];
    for (const m of text.matchAll(/\S+/g)) { // cleanText turns every space but \n into " ", so these are G.words' tokens
      const w = G.words(E.cleanText(m[0], keep).clean, 0, code)[0][0];
      if (!w) continue;
      const n = (seen.get(w.word) || 0) + 1;
      seen.set(w.word, n);
      out.push({ key: `${w.word}|${n}`, end: m.index + m[0].length });
    }
    return out;
  }
  /** Adds words after the selected word, or (Whole line) a line under the selected line, to the text box. Words already
   *  moved or resized keep their changes; Ctrl+Z takes the addition out again. */
  function addText(add) {
    if (!sel || isFixed(sel.key) || !add.trim()) return false;
    const text = state.text, old = textWords(text), at = Math.max(...old.filter(w => sel.keys.includes(w.key)).map(w => w.end));
    if (!Number.isFinite(at)) return false;
    let put, rest = text.slice(at);
    if (sel.line) { // code keeps the line's indent unless one was typed
      const start = text.lastIndexOf("\n", at - 1) + 1, indent = W_().code === true && !/^\s/.test(add) ? text.slice(start).match(/^[^\S\n]*/)[0] : "";
      rest = rest.replace(/^[^\S\n]+/, "");
      put = "\n" + indent + add.trimEnd() + (rest && rest[0] !== "\n" ? "\n" : ""); // a line from the middle of a paragraph: the rest goes on after it
    } else put = " " + add.trim();
    const next = text.slice(0, at) + put + rest, now = textWords(next).filter(w => w.end <= at || w.end > at + put.length);
    remember(true);
    if (now.length === old.length) { // the same words in the same order: later copies of an added word move up a number
      const to = new Map(old.map((w, i) => [w.key, now[i].key]));
      state.edits = new Map([...state.edits].map(([k, e]) => [to.get(k) || k, e]));
      keep(STORE.edits, Object.fromEntries(state.edits));
    }
    undoStack.undo.at(-1).after = next;
    state.text = $("text").value = next;
    scheduleRender(0);
    return true;
  }
  const closeAdd = () => { $("wordBar").classList.remove("adding"); draw(); };
  $("wbAdd").onclick = () => { $("wbAddText").value = ""; $("wordBar").classList.add("adding"); draw(); $("wbAddText").focus(); };
  $("wbAddCancel").onclick = closeAdd;
  $("wbAddForm").onsubmit = e => { e.preventDefault(); if (addText($("wbAddText").value)) closeAdd(); else $("wbAddText").focus(); };
  $("wbAddText").addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); closeAdd(); } }); // not full screen's Esc
  $("resetEdits").onclick = () => { remember(); state.edits.clear(); keep(STORE.edits, {}); syncBar(); scheduleRender(0); };
  document.addEventListener("keydown", e => {
    if (!sel || e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector("dialog[open]")) return;
    const k = e.key, s = STEP(e), act = { ArrowLeft: () => moveBy(-s, 0), ArrowRight: () => moveBy(s, 0), ArrowUp: () => moveBy(0, -s),
      ArrowDown: () => moveBy(0, s), "+": () => resizeBy(0.1), "=": () => resizeBy(0.1), "-": () => resizeBy(-0.1), Escape: () => { select(null); draw(); } }[k];
    if (act) { e.preventDefault(); act(); }
  });
  canvas.addEventListener("wheel", e => { e.preventDefault(); zoomAt(Math.pow(1.0015, -e.deltaY), e); }, { passive: false });
  /** Zoom by f around a point (the pointer, or the middle): that spot stays where it is. All the way out: the whole plate
   *  (or, in full screen, the whole paper) again. */
  function zoomAt(f, e) {
    if (!view.base) return;
    const r = canvas.getBoundingClientRect(), mx = e ? e.clientX - r.left : view.W / 2, my = e ? e.clientY - r.top : view.H / 2;
    const ax = (mx - view.ox) / view.s, ay = view.by - (my - view.oy) / view.s, least = view.fitZoom;
    const zoom = Math.min(Math.max(view.zoom * f, least), 14), k = view.base * zoom;
    if (zoom <= least * 1.001) view.fit = isFull() ? "paper" : "plate";
    else Object.assign(view, { fit: null, zoom, cx: ax + (view.W / 2 - mx) / k, cy: ay + (my - view.H / 2) / k });
    draw();
  }
  /** Paper moved: words are cached, so re-layout is instant; done on the next frame to keep dragging smooth. */
  let frame = 0;
  function relayout() { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => render()); }
  new ResizeObserver(() => draw()).observe(canvas); // the view re-fits: rotation, the browser's bars, entering full screen
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw()); // paper + labels follow the theme
  $("zoomIn").onclick = () => zoomAt(1.5); $("zoomOut").onclick = () => zoomAt(1 / 1.5);
  $("zoomFit").onclick = () => { view.fit = isFull() ? "paper" : "plate"; draw(); };

  // full screen: the preview over the whole screen, fitted to the paper and kept fitted while the screen settles
  function setFull(on) {
    if (isFull() === on) return;
    stageEl.classList.toggle("full", on); document.documentElement.classList.toggle("stage-full", on);
    $("zoomFull").setAttribute("aria-pressed", on); $("zoomFull").setAttribute("aria-label", on ? "Close full screen" : "Full screen");
    $("zoomFullLbl").textContent = on ? "Close" : "Full screen";
    view.fit = on ? "paper" : "plate"; lastTap = null; touches.clear(); drag = null;
    if (on) {
      window.history.pushState({ full: true }, ""); // the phone's Back button closes it
      if (stageEl.requestFullscreen && matchMedia("(pointer: coarse)").matches) stageEl.requestFullscreen().catch(() => {}); // hides the browser bars where allowed
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (window.history.state && window.history.state.full) window.history.back();
    }
    draw();
  }
  $("zoomFull").onclick = () => setFull(!isFull());
  addEventListener("popstate", () => setFull(false));
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && isFull()) setFull(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !e.defaultPrevented && isFull()) setFull(false); });

  // ---------- controls ----------
  const W_ = () => state.settings.writing, P_ = () => state.settings.paper, PR_ = () => state.settings.printer;
  $("text").value = state.text;
  $("text").addEventListener("input", e => {
    state.text = e.target.value; scheduleRender(); syncIndent();
    if (!W_().code &&(state.text.match(/^\s*(#include|#define|import |from \S+ import|def |class |public |int main|library\(|function\b)|<-|[;{}(]\s*$/gm) || []).length >= 3)
      tipOnce("code", "Writing code? Turn on Code under the text box: every line and indent stays as typed, and _ and * are written as they are.");
  });
  /** Code: the text box shows indents in a fixed-width font, without spelling marks; the markup tip doesn't apply. */
  const syncCode = () => { const on = W_().code === true; $("codeMode").checked = on; $("text").classList.toggle("code", on); $("text").spellcheck = !on; $("markupTip").hidden = on; };
  syncCode();
  $("codeMode").onchange = () => { W_().code = $("codeMode").checked; if (W_().code) $("tipToast").hidden = true; syncCode(); syncIndent(); scheduleRender(0); }; // the tip said to do this
  for (const [id, key] of [["bias", "bias"], ["wobble", "wobble"], ["wordSpacing", "word_spacing"], ["indent", "indent"]]) {
    const el = $(id), out = el.nextElementSibling;
    const show = () => { out.textContent = key === "indent" ? `${(el.value * 4 * (+$("xh").value || W_().x_height)).toFixed(1)} mm` : (+el.value).toFixed(2); }; // indent: a tab's width
    const fill = () => el.style.setProperty("--fill", (el.value - el.min) / (el.max - el.min) * 100 + "%");
    el.value = W_()[key]; show(); fill();
    if (key === "indent") $("xh").addEventListener("input", show);
    // only neatness needs new handwriting; the others just re-lay the cached words
    el.addEventListener("input", () => { W_()[key] = +el.value; show(); fill(); scheduleRender(key === "bias" ? 400 : 60); });
  }
  /** The indent slider shows once the text has an indented line, or is code. */
  function syncIndent() { $("indentRow").hidden = !(W_().code === true || /^[^\S\n]+\S/m.test(state.text)); }
  syncIndent();
  bindNumber("xh", () => W_(), "x_height", 60);
  bindNumber("lineSpacing", () => W_(), "line_spacing", 60);
  bindNumber("margin", () => P_(), "margin", 60);
  bindNumber("marginY", () => P_(), "margin_y", 60);
  function bindNumber(id, obj, key, delay) {
    const el = $(id); el.value = obj()[key];
    el.addEventListener("input", () => { if (el.value !== "" && Number.isFinite(+el.value)) { obj()[key] = +el.value; scheduleRender(delay); } });
  }
  // printer: the maker first (Bambu Lab, then everyone OrcaSlicer knows), then only that maker's printers
  const makerOf = m => (G.PRINTER_GROUPS.find(([, names]) => names.includes(m)) || G.PRINTER_GROUPS[0])[0];
  for (const [vendor] of G.PRINTER_GROUPS) $("printerMaker").add(new Option(vendor === "Other" ? "Other (custom size)" : vendor, vendor));
  function fillPrinters(vendor) {
    const sel = $("printer");
    sel.textContent = "";
    for (const m of G.PRINTER_GROUPS.find(g => g[0] === vendor)[1]) sel.add(new Option(m.startsWith(vendor + " ") ? m.slice(vendor.length + 1) : m, m));
  }
  $("printerMaker").value = makerOf(PR_().model); fillPrinters($("printerMaker").value);
  $("printerMaker").onchange = () => { fillPrinters($("printerMaker").value); $("printer").dispatchEvent(new Event("change")); }; // its first printer
  for (const m of Object.keys(G.PAPERS)) $("paper").add(new Option(m, m));
  $("printer").value = PR_().model; $("paper").value = P_().size;
  $("printer").onchange = () => {
    PR_().model = $("printer").value; centrePaper();
    tipOnce(`printer:${PR_().model}`, "New printer? Before using ink, run the offset test (Printer settings) and save a reach check (Printing): no pen, no paper, just a look at where the head goes.");
  };
  $("paper").onchange = () => { P_().size = $("paper").value; centrePaper(); };
  $("placePaper").onclick = centrePaper;
  for (const o of ["portrait", "landscape"]) $(o).onclick = () => { P_().orientation = o; syncOrientation(); centrePaper(); };
  function syncOrientation() { for (const o of ["portrait", "landscape"]) $(o).setAttribute("aria-pressed", P_().orientation === o); }
  syncOrientation();
  function centrePaper() {
    try {
      Object.assign(P_(), G.placePaper(G.resolve(state.settings))); // where the pen reaches, not just mid-plate
    } catch { /* invalid settings: render() explains */ }
    view.fit = isFull() ? "paper" : "plate"; // and show it whole
    scheduleRender(0);
  }
  const syncSounds = () => {
    $("sounds").checked = PR_().sounds !== false;
    const ok = G.SOUND_PRINTERS.has(PR_().model);
    $("sounds").disabled = !ok;
    $("soundsNote").textContent = ok ? "Bambu's own start and finish tunes, plus a tune at each pause" : "Not supported by this printer";
  };
  $("sounds").onchange = () => { PR_().sounds = $("sounds").checked; scheduleRender(0); };
  $("slide").checked = P_().slide === true;
  $("slide").onchange = () => { P_().slide = $("slide").checked; scheduleRender(0); };
  $("printer").addEventListener("change", syncSounds);
  syncSounds();
  $("reroll").onclick = () => { state.seed = (Math.random() * 2 ** 31) | 0; state.rerolls.clear(); seedOrigin.clear(); scheduleRender(0); };
  // ruled paper: how far apart its printed lines are, where the first one is, and its margin line
  const RULINGS = [[0, "Plain paper"], [6, "Ruled 6 mm"], [7, "Ruled 7 mm"], [7.1, "Ruled 7.1 mm (US college)"], [8, "Ruled 8 mm"],
    [8.7, "Ruled 8.7 mm (US wide)"], [9, "Ruled 9 mm"], [10, "Ruled 10 mm"]];
  for (const [mm, text] of RULINGS) $("ruling").add(new Option(text, mm));
  if (!RULINGS.some(([mm]) => mm === P_().ruling)) $("ruling").add(new Option(`Ruled ${P_().ruling} mm`, P_().ruling));
  const syncRuling = () => { $("ruling").value = String(P_().ruling); $("ruledRow").hidden = !(P_().ruling > 0); };
  $("ruling").onchange = () => {
    P_().ruling = +$("ruling").value;
    const fit = G.rulingLetters(P_().ruling); // as people write on lined paper, so a tail seldom meets the next line's tall letters
    if (P_().ruling > 0 && W_().x_height > fit) { W_().x_height = fit; $("xh").value = fit; }
    syncRuling(); scheduleRender(0);
  };
  syncRuling();
  bindNumber("firstLine", () => P_(), "first_line", 60);
  bindNumber("marginLine", () => P_(), "margin_line", 60);
  // header line and page numbers, written at the top of every sheet
  $("header").value = W_().header;
  $("header").addEventListener("input", () => { W_().header = $("header").value; scheduleRender(); });
  $("pageNumbers").checked = W_().page_numbers === true;
  $("pageNumbers").onchange = () => { W_().page_numbers = $("pageNumbers").checked; scheduleRender(0); };
  // printing: dry run, and starting again partway down the page (both for this session only)
  $("dryRun").checked = state.dryRun; $("startLine").value = state.startLine; // a reload may restore the old form state: this session's is off / 1
  $("dryRun").onchange = () => { state.dryRun = $("dryRun").checked; updateSummary(); };
  $("startLine").addEventListener("input", () => { state.startLine = Math.max(1, Math.floor(+$("startLine").value) || 1); draw(); updateSummary(); });
  for (const ev of ["focus", "blur"]) $("startLine").addEventListener(ev, () => draw()); // line numbers show while it's in use

  // ---------- handwriting style picker with live previews ----------
  const thumbs = new Map();
  function buildStyles() {
    const box = $("styles"), keepTop = box.scrollTop; box.textContent = "";
    let group = "";
    for (const st of presets) {
      const g = st.group;
      if (g !== group) { const h = document.createElement("div"); h.className = "style-group"; h.textContent = (group = g); box.append(h); }
      const b = document.createElement("button");
      b.type = "button"; b.className = "style";
      b.setAttribute("aria-pressed", W_().style === st.key);
      b.title = st.label;
      const c = document.createElement("canvas"); c.width = 220; c.height = 68;
      b.append(c, document.createTextNode(st.label));
      b.onclick = () => {
        W_().style = st.key;
        if (st.bias !== undefined) { W_().bias = st.bias; $("bias").value = st.bias; $("bias").nextElementSibling.textContent = st.bias.toFixed(2); $("bias").style.setProperty("--fill", st.bias / 2 * 100 + "%"); }
        buildStyles(); $("styles").querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }); scheduleRender(0);
      };
      box.append(b);
      if (thumbs.has(st.key)) paintThumb(c, thumbs.get(st.key));
      else pool.word(st, "Handwriting", 7, st.bias ?? 1, true).then(ink => { thumbs.set(st.key, ink); paintThumb(c, ink); if (st.key === W_().style) updateCapacity(); }).catch(() => b.classList.add("ready")); // no preview: end the skeleton anyway
    }
    box.scrollTop = keepTop;
  }
  function paintThumb(c, ink) {
    const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of ink) for (const [x, y] of s) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const k = Math.min((c.width - 16) / (x1 - x0), (c.height - 12) / (y1 - y0));
    g.strokeStyle = "#1b2a6b"; g.lineWidth = 2; g.lineCap = g.lineJoin = "round"; g.beginPath();
    for (const s of ink) { s.forEach(([x, y], i) => { const px = 8 + (x - x0) * k, py = c.height - 6 - (y - y0) * k; i ? g.lineTo(px, py) : g.moveTo(px, py); }); }
    g.stroke();
    if (c.parentElement) c.parentElement.classList.add("ready"); // ends the skeleton
  }

  // ---------- printer settings dialog ----------
  const HELP = {
    paper_pause_s: ["Pause 1: place the paper", "s", "After homing, the head rises and stops right above where the first letter will be written, then waits this long. Put the paper where the preview shows it and tape it down. The pen is not in the holder yet."],
    pen_pause_s: ["Pause 2: attach the pen", "s", "The head lowers to the writing height over the first letter and waits this long. Slide the pen down through the holder until the tip just touches the paper, then clamp it. Writing starts when the pause ends."],
    shift_pause_s: ["Pause 3: slide the paper", "s", "Only with \"Slide the paper\" on, for pages longer than the pen reaches, like A4 on an A1. The pen stops just above where the last written mark must end up; slide the paper toward the back until that mark is right under the pen tip. Once per extra pass."],
    z_draw: ["Writing height", "mm", "Nozzle height while the pen is down. The pen is clamped touching the paper at this height in pause 2, so any height that clears the holder works. At least 2 mm."],
    press_bottom: ["Press harder toward the bottom", "mm", "If the writing gets fainter down the page, the bed sits a little lower there (the printer can't level the bed with a pen fitted). The pen goes this much lower by the bottom of the page, starting from nothing at the first letter. Try 0.3, then more if the last lines are still faint. 0 is off; at most 2."],
    z_lift: ["Pen-up height", "mm", "Nozzle height when moving between strokes. About 2 mm above the writing height: handwriting lifts the pen thousands of times."],
    offset_x: ["Pen offset X", "mm", "Pen tip position minus nozzle position, left/right: negative when the pen is left of the nozzle. BambuPlot calls this the tool offset."],
    offset_y: ["Pen offset Y", "mm", "Same, front/back: negative when the pen is in front of the nozzle. If it's wrong, the last lines can run off the front of the plate."],
    draw_feed: ["Writing speed", "mm/min", "1500 is about the speed of real handwriting."],
    travel_feed: ["Travel speed", "mm/min", "Speed of pen-up moves between strokes."],
    z_feed: ["Up/down speed", "mm/min", "How fast the pen is lifted and lowered."],
    settle_ms: ["Pen settle time", "ms", "A tiny wait after every pen down and up so the ink starts and stops cleanly. Raise it if strokes start faint."],
    bed_x: ["Bed width", "mm", "Only used when the printer is Custom."],
    bed_y: ["Bed depth", "mm", "Only used when the printer is Custom."],
    bed_z: ["Max height", "mm", "How high the nozzle can go. Only used when the printer is Custom."],
    width: ["Paper width", "mm", "Only used when the paper is Custom."],
    height: ["Paper height", "mm", "Only used when the paper is Custom."],
  };
  const GROUPS = [
    ["Pen offset", "printer", ["offset_x", "offset_y"]],
    ["Pauses during printing", "printer", ["paper_pause_s", "pen_pause_s", "shift_pause_s"]],
    ["Pen heights", "printer", ["z_draw", "z_lift", "press_bottom"]],
    ["Speeds", "printer", ["draw_feed", "travel_feed", "z_feed", "settle_ms"]],
    ["Custom printer", "printer", ["bed_x", "bed_y", "bed_z"]],
    ["Custom paper", "paper", ["width", "height"]],
  ];
  $("openSettings").onclick = () => {
    const body = $("settingsBody"); body.textContent = ""; $("settingsMsg").textContent = "";
    for (const [title, sec, keys] of GROUPS) {
      const fs = document.createElement("fieldset"), lg = document.createElement("legend");
      lg.textContent = title; fs.append(lg);
      for (const key of keys) {
        const [label, unit, help] = HELP[key], [lo, hi] = G.LIMITS[sec][key], id = "set_" + key;
        const row = document.createElement("div"); row.className = "field";
        row.innerHTML = `<label for="${id}"></label><div class="unit" data-unit=""><input type="number" id="${id}" step="any"></div><p></p>`;
        row.querySelector("label").textContent = label;
        row.querySelector(".unit").dataset.unit = unit;
        Object.assign(row.querySelector("input"), { value: state.settings[sec][key], min: lo, max: hi });
        row.querySelector("input").dataset.sec = sec; row.querySelector("input").dataset.key = key;
        row.querySelector("p").textContent = help;
        fs.append(row);
      }
      if (title === "Pen offset") fs.append(offsetTestBlock());
      body.append(fs);
    }
    $("settingsDlg").showModal();
  };
  /** Settings with the dialog's (maybe unsaved) values. */
  function dialogSettings() {
    const next = structuredClone(state.settings);
    for (const inp of $("settingsBody").querySelectorAll("input[data-key]")) next[inp.dataset.sec][inp.dataset.key] = inp.value === "" ? NaN : +inp.value;
    return next;
  }
  /** Pen offset test: print two lines on A4 in the plate's back-left corner, measure them, get the offset. */
  function offsetTestBlock() {
    const t = document.createElement("div"); t.className = "offset-test";
    t.innerHTML = `<p class="hint">Don't know the offset? Print the offset test. Push A4 paper into the top-left corner of the plate (the far-left corner, top left in the preview), with its
      top and left edges lined up with the plate's back and left edges. Run the file like any other, then measure to the
      middle of each line the pen drew and type the distances in: the offset above follows. Click Save to keep it.</p>
      <button type="button" class="btn small" id="otSave">Save offset test G-code</button>
      <div class="field"><label for="otTop">Long line</label><div class="unit" data-unit="mm"><input type="number" id="otTop" step="any"></div><p>Distance from the paper's top edge down to the long line.</p></div>
      <div class="field"><label for="otLeft">Short mark</label><div class="unit" data-unit="mm"><input type="number" id="otLeft" step="any"></div><p>Distance from the paper's left edge to the short mark.</p></div>
      <p class="hint" id="otMsg" role="status"></p>`;
    t.querySelector("#otSave").onclick = async () => {
      let gcode;
      try { gcode = G.offsetTest(dialogSettings()); } catch (err) { return void (t.querySelector("#otMsg").textContent = err.message); }
      const where = await download(gcode, "pen-offset-test.gcode", "text/plain");
      if (where) t.querySelector("#otMsg").textContent = `${where} Take the pen out, start it, put the paper in the corner in pause 1 and clamp the pen in pause 2.`;
    };
    // The distances are the offset in another form, kept in step both ways, so the saved offset shows here too.
    const top = t.querySelector("#otTop"), left = t.querySelector("#otLeft"), msg = t.querySelector("#otMsg");
    const fromOffset = () => {
      try {
        const m = G.offsetTestMarks(dialogSettings()), ox = $("set_offset_x").value, oy = $("set_offset_y").value;
        left.value = ox === "" ? "" : +(m.left + +ox).toFixed(2); top.value = oy === "" ? "" : +(m.top - +oy).toFixed(2);
      } catch { /* another field is invalid: Save says which */ }
    };
    const toOffset = () => {
      if (!(+top.value > 0) || !(+left.value > 0)) return void (msg.textContent = "Enter both distances in mm.");
      try {
        const o = G.offsetFromTest(dialogSettings(), +left.value, +top.value);
        $("set_offset_x").value = o.offset_x; $("set_offset_y").value = o.offset_y;
        msg.textContent = `Pen offset X ${o.offset_x}, Y ${o.offset_y} mm. Click Save to keep it.`;
      } catch (err) { msg.textContent = err.message; }
    };
    top.oninput = left.oninput = toOffset;
    queueMicrotask(() => { // the offset fields exist once the dialog is built
      for (const id of ["set_offset_x", "set_offset_y"]) $(id).addEventListener("input", () => { fromOffset(); msg.textContent = ""; });
      fromOffset();
    });
    return t;
  }
  $("settingsSave").onclick = e => {
    const next = dialogSettings();
    try { G.resolve(next); } catch (err) { e.preventDefault(); $("settingsMsg").textContent = err.message; return; }
    const moved = ["offset_x", "offset_y"].some(k => next.printer[k] !== state.settings.printer[k]);
    state.settings = next;
    if (moved) centrePaper(); else scheduleRender(0); // a new pen offset changes where the pen reaches
  };

  // ---------- save G-code ----------
  /** The settings a file is saved with: those shown, plus the dry run when it's ticked (checked like any other). */
  const outCfg = cfg => state.dryRun ? G.resolve({ ...state.settings, printer: { ...state.settings.printer, dry_run: true } }) : cfg;
  const tagged = (name, from) => name.replace(/\.gcode$/, `${from > 1 ? `-from-line-${from}` : ""}${state.dryRun ? "-dry-run" : ""}.gcode`);
  $("save").onclick = async () => {
    const v = cur(), n = state.view ? state.view.pages.length : 0;
    if (!v || state.error || state.busy) return;
    let gcode, passes, from = 1;
    try {
      const cfg = G.resolve(state.settings); // the exact settings shown now, checked again
      if (JSON.stringify(cfg) !== JSON.stringify(v.cfg)) { await render(); return $("save").click(); }
      const out = outCfg(cfg);
      from = startLine(v);
      try { passes = G.planPasses(from > 1 ? v.lines.slice(from - 1) : v.lines, out); }
      catch (e) { if (from > 1) e.message = `Can't start at line ${from}: ${e.message}`; throw e; }
      gcode = G.toGcode(passes, out, [...G.describe(out, state.seed), ...(n > 1 ? [`page ${state.page + 1} of ${n}`] : []),
        ...(from > 1 ? [`starts at line ${from} of the page: lines 1 to ${from - 1} were written before`] : []),
        `estimated time: about ${eta({ cfg: out, passes }).dur} (including pauses)`]);
    } catch (e) {
      if (from > 1) { $("error").hidden = false; $("error").textContent = e.message; return; } // keep the page on screen
      return fail(e);
    }
    const name = tagged(n > 1 ? pageFile(state.page, n) : `handwriting-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.gcode`, from);
    const where = await download(gcode, name, "text/plain");
    if (!where) return;
    const t = eta({ cfg: v.cfg, passes });
    $("savedWhere").textContent = `${where} Only run it on the ${v.cfg.printer.model}. Writing takes about ${t.dur} including the pauses (done around ${t.at} if you start now).`;
    showSteps({ cfg: v.cfg, passes }, from > 1 ? [`Leave the paper taped where it is. In the first pause the head stops over the first letter of line ${from}: check that it lines up.`] : []);
  };
  // ---------- ergonomics: what's changed is visible, errors come with a fix, every word change can be undone ----------
  /** "More options" summaries: what's inside, or (accent) which of its settings differ from the defaults. */
  function syncMore() {
    const D = G.DEFAULT_SETTINGS, w = W_(), p = P_(), pr = PR_(), on = (cond, name) => (cond ? [name] : []);
    const sets = {
      moreHand: [["line wobble, word and line spacing"], [...on(w.wobble !== D.writing.wobble, "line wobble"), ...on(w.word_spacing !== D.writing.word_spacing, "word spacing"),
        ...on(w.line_spacing !== D.writing.line_spacing, "line spacing")]],
      morePage: [["borders, lined paper, header, page numbers"], [...on(p.margin !== D.paper.margin || p.margin_y !== D.paper.margin_y, "borders"),
        ...on(p.ruling > 0, `lined paper ${p.ruling} mm`), ...on(!!(w.header || "").trim(), "header"), ...on(w.page_numbers, "page numbers"),
        ...on(pr.sounds === false && G.SOUND_PRINTERS.has(pr.model), "sounds off"), ...on(p.slide, "long pages")]],
      morePrint: [["dry run, start again from a line, reach check"], [...on(state.dryRun, "dry run"), ...on(state.startLine > 1, `from line ${state.startLine}`)]],
    };
    for (const [id, [[inside], changed]] of Object.entries(sets)) {
      const el = $(id + "Sum");
      el.textContent = changed.length ? `Changed: ${changed.join(", ")}` : inside;
      el.classList.toggle("changed", changed.length > 0);
    }
  }
  { // each "More options" stays open or closed as you left it
    const open = load(STORE.more, {}) || {};
    for (const d of document.querySelectorAll("details.more")) {
      if (open[d.id]) d.open = true;
      d.addEventListener("toggle", () => { const o = load(STORE.more, {}) || {}; o[d.id] = d.open; keep(STORE.more, o); });
    }
  }
  /** An error that has an obvious fix gets a button that does it: [label, action], or null. */
  const setInput = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event("input")); };
  function quickFix(msg) {
    const xh = W_().x_height, smaller = Math.max(1, Math.round(xh * 0.85 * 10) / 10), m = /use ([\d.]+) mm letters or smaller/.exec(msg);
    if (m) return [`Use ${m[1]} mm letters`, () => setInput("xh", m[1])];
    if (/Line spacing is too small/.test(msg)) { const v = Math.ceil(xh * 1.6 * 2) / 2; return [`Set line spacing to ${v} mm`, () => setInput("lineSpacing", v)]; }
    if (/moved word|was moved off the paper/.test(msg)) return ["Put moved words back", () => changeEdits([...state.edits.keys()], e => ({ ...e, dx: 0, dy: 0 }))];
    if (/turn on sliding the paper/.test(msg)) return ["Turn on long pages", () => { $("slide").checked = true; $("slide").dispatchEvent(new Event("change")); }];
    if (/drag the paper|paper is on the build plate/.test(msg)) return ["Place paper automatically", () => centrePaper()];
    if (/smaller letters|wider than a line|doesn't fit/i.test(msg) && smaller < xh) return [`Use ${smaller} mm letters`, () => setInput("xh", smaller)];
    return null;
  }
  // undo / redo for word changes and rewrites (the text box keeps its own undo)
  const undoStack = { undo: [], redo: [] }; // not `history`: that's the browser's
  const snapshot = () => ({ edits: new Map([...state.edits].map(([k, e]) => [k, { ...e }])), rerolls: new Map(state.rerolls) });
  /** text: the change also changes the text box (an added word); .after is set to the text it made. */
  function remember(text) { undoStack.undo.push({ ...snapshot(), ...(text && { text: state.text }) }); if (undoStack.undo.length > 100) undoStack.undo.shift(); undoStack.redo.length = 0; $("wbUndo").hidden = false; }
  function travel(from, to) {
    if (!from.length) return;
    const s = from.pop(), text = s.text !== undefined && state.text === s.after; // not over typing done in the text box since
    to.push({ ...snapshot(), ...(text && { text: state.text, after: s.text }) });
    state.edits = s.edits; state.rerolls = s.rerolls;
    if (text) state.text = $("text").value = s.text;
    keep(STORE.edits, Object.fromEntries(state.edits));
    $("wbUndo").hidden = !undoStack.undo.length;
    syncBar(); scheduleRender(0);
  }
  const undo = () => travel(undoStack.undo, undoStack.redo), redo = () => travel(undoStack.redo, undoStack.undo);
  $("wbUndo").onclick = undo;
  document.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); if (!$("save").disabled) $("save").click(); return; } // save the G-code, not the web page
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector("dialog[open]")) return;
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ---------- guidance: a first-visit tour, one-time tips, and the menu ----------
  const TOUR = [ // [what to light up, title, text]
    ["#text", "Type your note", "Write or paste what you want written. The page on the right updates as you type."],
    ["#styles", "Pick a handwriting", "Every style is written live by the model, so no two letters are the same. Try a few."],
    ["#printerMaker", "Choose your printer and paper", "Pick the maker, then your printer, then the paper. The preview shows where the paper sits on the plate."],
    ["#plate", "Check your page", matchMedia("(pointer: coarse)").matches
      ? "This is your page on the build plate. Drag the paper to move it, and tap any word to change it. Full screen shows the page big and keeps the paper still: drag a word to move it, pinch or double-tap to zoom."
      : "This is your page on the build plate. Drag the paper to move it, and click any word to move it, resize it or change its handwriting."],
    ["#save", "Save and print", "Happy with it? Save the G-code. The app then walks you through printing it, one step at a time."],
  ];
  let tourAt = -1;
  const tourTarget = sel => { const t = document.querySelector(sel); return t.closest(".card") || t.closest(".stage") || t; };
  function startTour(at = 0) {
    if (document.querySelector("dialog[open]")) return;
    tourAt = at; $("coachSpot").hidden = $("coach").hidden = false; $("tipToast").hidden = true;
    showTourStep();
    $("coachNext").focus({ preventScroll: true });
  }
  function endTour() {
    if (tourAt < 0) return;
    tourAt = -1; $("coachSpot").hidden = $("coach").hidden = true;
    keep(STORE.toured, true);
  }
  function showTourStep() {
    const [sel, title, text] = TOUR[tourAt], target = tourTarget(sel);
    $("coachStep").textContent = `${tourAt + 1} of ${TOUR.length}`; $("coachTitle").textContent = title; $("coachText").textContent = text;
    $("coachBack").hidden = tourAt === 0; $("coachNext").textContent = tourAt === TOUR.length - 1 ? "Let's go" : "Next";
    if (target.closest(".scroll") || innerWidth <= 860) target.scrollIntoView({ block: "center", behavior: "instant" });
    placeTour();
  }
  function placeTour() { // the spotlight around the part, the card beside it (right, below or above), all on screen
    if (tourAt < 0) return;
    const r = tourTarget(TOUR[tourAt][0]).getBoundingClientRect(), pad = 6, spot = $("coachSpot"), card = $("coach");
    const box = { l: Math.max(4, r.left - pad), t: Math.max(4, r.top - pad), r: Math.min(innerWidth - 4, r.right + pad), b: Math.min(innerHeight - 4, r.bottom + pad) };
    Object.assign(spot.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.r - box.l}px`, height: `${box.b - box.t}px` });
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, fit = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let x, y;
    if (box.r + gap + cw <= innerWidth - 12) { x = box.r + gap; y = fit(box.t, 12, innerHeight - ch - 12); }
    else if (box.b + gap + ch <= innerHeight - 12) { x = fit(box.l, 12, innerWidth - cw - 12); y = box.b + gap; }
    else if (box.t - gap - ch >= 12) { x = fit(box.l, 12, innerWidth - cw - 12); y = box.t - gap - ch; }
    else { x = fit((innerWidth - cw) / 2, 12, innerWidth - cw - 12); y = innerHeight - ch - 12; } // big part: the card over its bottom
    card.style.left = `${x}px`; card.style.top = `${y}px`;
  }
  $("coachNext").onclick = () => { if (tourAt >= TOUR.length - 1) return endTour(); tourAt++; showTourStep(); };
  $("coachBack").onclick = () => { if (tourAt > 0) { tourAt--; showTourStep(); } };
  $("coachSkip").onclick = endTour;
  addEventListener("resize", placeTour);
  document.addEventListener("scroll", placeTour, true);
  document.addEventListener("keydown", e => { if (tourAt >= 0 && e.key === "Escape") { e.stopImmediatePropagation(); endTour(); } }, true);

  /** A tip shown once ever (remembered in this browser), at the moment it matters; not during the tour. */
  let tipTimer = 0;
  function tipOnce(key, text) {
    const seen = load(STORE.tips, {});
    if (tourAt >= 0 || !load(STORE.toured, false) || (seen && seen[key])) return;
    keep(STORE.tips, { ...(seen && typeof seen === "object" ? seen : {}), [key]: true });
    $("tipText").textContent = text; $("tipToast").hidden = false;
    clearTimeout(tipTimer); tipTimer = setTimeout(() => { $("tipToast").hidden = true; }, 12000);
  }
  $("tipClose").onclick = () => { clearTimeout(tipTimer); $("tipToast").hidden = true; };

  // the menu: how to use, supported printers, the tour again
  const setMenu = open => { $("appMenu").hidden = !open; $("appMenuBtn").setAttribute("aria-expanded", open); if (open) $("appMenu").querySelector("a, button").focus(); };
  $("appMenuBtn").onclick = e => { e.stopPropagation(); setMenu($("appMenu").hidden); };
  document.addEventListener("click", e => { if (!$("appMenu").hidden && !e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("appMenu").hidden) { setMenu(false); $("appMenuBtn").focus(); } });
  $("tourAgain").onclick = () => { setMenu(false); select(null); draw(); startTour(); };

  // ---------- reach check: the head visits the far corners of this page's writing, no pen, no paper ----------
  $("reachCheck").onclick = async () => {
    const v = cur();
    if (!v || state.error || state.busy) return;
    let gcode;
    try {
      const cfg = G.resolve(state.settings); // the exact settings shown now, checked again
      if (JSON.stringify(cfg) !== JSON.stringify(v.cfg)) { await render(); return $("reachCheck").click(); }
      gcode = G.reachCheck(G.planPasses(v.lines, cfg), cfg, [...G.describe(cfg, state.seed), "reach check for this page: no pen, no paper"]);
    } catch (e) { return fail(e); }
    const where = await download(gcode, `reach-check-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.gcode`, "text/plain");
    if (!where) return;
    $("savedWhere").textContent = `${where} Only run it on the ${v.cfg.printer.model}.`;
    $("savedSteps").textContent = "";
    for (const s of ["Take the pen out of the holder and leave the plate empty. The printer homes first, and homing touches the nozzle to the plate.",
      `Start the file. The head goes to the four corners of where this page will be written, at the height it travels at when writing, and waits ${G.REACH_WAIT_S} s at each.`,
      "Watch the pen holder at each corner: it must clear the bed clips, the nozzle wiper and the frame. If anything comes close, stop the printer, then move the paper inward or check the pen offset.",
      "All clear? Save the page and write it."]) { const li = document.createElement("li"); li.textContent = s; $("savedSteps").append(li); }
    $("savedDlg").showModal();
  };
  function showSteps(v, extra) {
    const pr = v.cfg.printer, steps = [...extra];
    if (state.dryRun) steps.unshift(`Dry run: the pen is clamped as usual, then every stroke is drawn ${G.DRY_RUN_LIFT} mm above the paper, so nothing gets written.`);
    steps.push("Take the pen out of the holder. The printer homes first, and homing touches the nozzle to the plate.",
      `Start the file. The head moves over the first letter and waits ${pr.paper_pause_s} s: put the paper where the preview shows and tape it down.`,
      `The head lowers and waits ${pr.pen_pause_s} s: slide the pen down until it touches the paper, then clamp it.`);
    if (penChange(v.passes)) steps.push(`When the first pen is done, the head rises and waits ${pr.pen_pause_s} s: take that pen out. Then it lowers and waits ${pr.pen_pause_s} s: slide the second pen in until it touches the paper, and clamp it.`);
    if (v.passes.length > 1) steps.push(G.passNote(v.passes) + ` You have ${pr.shift_pause_s} s each time.`);
    steps.push("Stay with the printer for the first run.");
    $("savedSteps").textContent = "";
    for (const s of steps) { const li = document.createElement("li"); li.textContent = s; $("savedSteps").append(li); }
    $("savedDlg").showModal();
  }

  // ---------- save all pages: one zip into Downloads ----------
  $("saveAll").onclick = async () => {
    const view = state.view;
    if (!view || state.error || state.busy) return;
    const n = view.pages.length;
    let files;
    try {
      const cfg = G.resolve(state.settings);
      if (JSON.stringify(cfg) !== JSON.stringify(view.cfg)) { await render(); return $("saveAll").click(); }
      const out = outCfg(cfg);
      files = view.pages.map((p, k) => ({ name: tagged(pageFile(k, n), 1), text: G.toGcode(G.planPasses(p.lines, out), out,
        [...G.describe(out, state.seed), `page ${k + 1} of ${n}`, `estimated time: about ${eta({ cfg: out, passes: p.passes }).dur} (including pauses)`]) }));
    } catch (e) { return fail(e); }
    // A plain download, not the folder picker: Edge/Chrome refuse to let a page pick Downloads itself ("contains system files").
    const zip = `handwriting-pages${state.dryRun ? "-dry-run" : ""}.zip`;
    saveBlob(makeZip(files), zip);
    const where = `Saved ${zip} (${files[0].name} to ${files[n - 1].name}) to your Downloads folder. Open it and copy the files onto the SD card.`;
    const all = eta(view.pages.reduce((sum, p) => sum + estimate({ cfg: view.cfg, passes: p.passes }), 0));
    $("savedWhere").textContent = `${where} Only run them on the ${view.cfg.printer.model}. All pages together take about ${all.dur}, plus changing the paper.`;
    const changing = view.pages.find(p => penChange(p.passes)); // its passes only tell showSteps to explain the pen change
    showSteps({ cfg: view.cfg, passes: changing ? changing.passes : [] }, [`Print the files in order, ${files[0].name} first. Each page is a complete job: put a fresh sheet in for each one.`]);
  };
  function saveBlob(blob, name) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  /** Minimal .zip (stored, no compression) of text files: [{name, text}]. */
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc32 = d => { let c = 0xffffffff; for (const b of d) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const put = (view, fields) => fields.forEach(([o, v, sz]) => sz === 4 ? view.setUint32(o, v, true) : view.setUint16(o, v, true));
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30)); // local header; date 0x21 = 1980-01-01
      put(h, [[0, 0x04034b50, 4], [4, 20, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2]]);
      parts.push(h, name, data);
      const c = new DataView(new ArrayBuffer(46)); // central directory entry
      put(c, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [42, offset, 4]]);
      central.push(c, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((n, p) => n + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    put(end, [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4]]);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }
  // page navigation
  const goPage = d => {
    if (!state.view) return;
    state.page = Math.min(Math.max(state.page + d, 0), state.view.pages.length - 1);
    state.startLine = 1; $("startLine").value = 1; // a start line belongs to one page
    select(null); draw(); updateSummary();
  };
  $("prevPage").onclick = () => goPage(-1);
  $("nextPage").onclick = () => goPage(1);
  /** Save a file: the system Save dialog where supported, otherwise a normal download. Returns a message or "". */
  async function download(text, name, type) {
    if (window.showSaveFilePicker) {
      try {
        const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: name.endsWith(".gcode") ? "G-code" : "JSON", accept: { [type]: [name.slice(name.lastIndexOf("."))] } }] });
        const w = await h.createWritable(); await w.write(text); await w.close();
        return `Saved as ${h.name}.`;
      } catch (e) { if (e.name === "AbortError") return ""; /* otherwise fall back to a download */ }
    }
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return `Saved to your Downloads folder as ${name}.`;
  }

  // ---------- start ----------
  { // settings saved before the slide option: place the paper once by where the pen reaches (pen offset)
    const saved = load(STORE.settings, null);
    if (saved && saved.paper && saved.paper.slide === undefined) try { Object.assign(P_(), G.placePaper(G.resolve(state.settings))); } catch { /* render explains */ }
  }
  render(); // first, so the page's words are queued before the style previews
  buildStyles();
})();
