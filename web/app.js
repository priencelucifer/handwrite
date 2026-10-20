/* Handwrite web app: UI, background word generation, build-plate view, G-code export.
 * Engine: engine.js (HWEngine). Safety-critical layout/G-code: gcode.js (HWGcode). */
(() => {
  "use strict";
  const E = HWEngine, G = HWGcode, $ = id => document.getElementById(id);
  const STORE = { settings: "hw.settings", styles: "hw.styles", text: "hw.text", seed: "hw.seed" };
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
  let mine = loadMine();
  const state = {
    settings: mergeSettings(load(STORE.settings, null)),
    text: load(STORE.text, "Dear friend,\n\nThis letter was written by my 3D printer, one pen stroke at a time. Can you tell?\n\nBest wishes"),
    seed: load(STORE.seed, (Math.random() * 2 ** 31) | 0),
    view: null,      // {cfg, lines, passes} of the last good layout
    error: "",
    busy: false,
  };
  { // older saves named the 13 originals "9" or "p:9"
    const st = String(state.settings.writing.style), old = /^(?:p:)?(d+)$/.exec(st);
    if (old) state.settings.writing.style = `s:everyday-${+old[1] + 1}`;
    if (!state.settings.writing.style.startsWith("s:") && !state.settings.writing.style.startsWith("u:")) state.settings.writing.style = "s:neat-1";
  }

  function mergeSettings(saved) {
    const s = structuredClone(G.DEFAULT_SETTINGS);
    if (saved && typeof saved === "object")
      for (const sec of Object.keys(s)) if (saved[sec] && typeof saved[sec] === "object")
        for (const k of Object.keys(s[sec])) if (k in saved[sec]) s[sec][k] = saved[sec][k];
    return s;
  }
  const allStyles = () => [...presets, ...mine];
  const styleOf = key => allStyles().find(s => s.key === key);

  // ---------- word generation: a pool of Web Workers, each with its own copy of the model ----------
  const pool = (() => {
    const weights = E.b64ToBytes(HW_WEIGHTS_B64);
    const queue = [], jobs = new Map();
    let nextId = 1, workers = [], local = null;
    const workerSrc = `"use strict"; const HWEngine = (${E.source})();
      let model = null; const styles = new Map(), hands = new Map();
      onmessage = e => { const m = e.data;
        if (m.type === "init") { model = HWEngine.loadModel(m.weights); return; }
        if (m.type === "style") { styles.set(m.key, m.style); return; }
        try {
          let h = hands.get(m.key);
          if (!h) { h = new HWEngine.Hand(model, styles.get(m.key)); hands.set(m.key, h); }
          postMessage({ id: m.id, ink: h.word(m.word, m.seed, m.bias) });
        } catch (err) { postMessage({ id: m.id, error: String((err && err.message) || err) }); }
      };`;
    try {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
      const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.postMessage({ type: "init", weights });
        Object.assign(w, { job: null, styles: new Set() });
        w.onmessage = e => finish(w, e.data);
        w.onerror = e => { e.preventDefault(); fallBack(); };
        workers.push(w);
      }
    } catch { fallBack(); }

    function fallBack() { // no workers (very old browser or blocked): run on the page, slower but works
      for (const w of workers) { if (w.job) queue.unshift(w.job); w.terminate(); }
      workers = [];
      if (!local) local = { model: E.loadModel(weights), hands: new Map() };
      pump();
    }
    function finish(w, msg) {
      const job = w.job; w.job = null;
      if (job) (msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg.ink));
      pump();
    }
    function pump() {
      if (local) {
        if (local.running || !queue.length) return;
        local.running = true;
        setTimeout(() => { // one word per tick keeps the page responsive
          const job = queue.shift();
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
      for (const w of workers) {
        if (w.job || !queue.length) continue;
        // prefer a job whose style this worker has already primed (priming costs ~0.3 s per style)
        let i = queue.findIndex(j => w.styles.has(j.key));
        if (i < 0) i = 0;
        const job = queue.splice(i, 1)[0];
        if (!w.styles.has(job.key)) { w.postMessage({ type: "style", key: job.key, style: job.style }); w.styles.add(job.key); }
        w.job = job;
        w.postMessage({ id: job.id, key: job.key, word: job.word, seed: job.seed, bias: job.bias });
      }
    }
    return {
      word(style, word, seed, bias, front = false, tag = "") {
        return new Promise((resolve, reject) => {
          const job = { id: nextId++, key: style.key, style: style.data, word, seed, bias, tag, resolve, reject };
          front ? queue.unshift(job) : queue.push(job);
          pump();
        });
      },
      cancelQueued(tag) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].tag === tag) queue.splice(i, 1)[0].reject(new Error("cancelled"));
      },
    };
  })();

  // ---------- rendering pipeline ----------
  const inkCache = new Map(); // `${style}|${bias}|${seed}|${word}` -> strokes in x-height units
  const inkKey = (style, bias, w) => `${style}|${bias}|${w.seed}|${w.word}`;
  let renderToken = 0, renderTimer = 0;
  const scheduleRender = (delay = 350) => { updateCapacity(); clearTimeout(renderTimer); renderTimer = setTimeout(render, delay); };

  /** How much fits, worked out instantly from the settings (no handwriting needed). Returns the estimate or null. */
  function updateCapacity() {
    let cfg;
    try { cfg = G.resolve(state.settings); } catch { $("capacity").textContent = ""; return null; }
    const paras = G.words(E.cleanText(state.text).clean, state.seed), n = paras.flat().length;
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
    keep(STORE.settings, state.settings); keep(STORE.text, state.text); keep(STORE.seed, state.seed);
    let cfg;
    try { cfg = G.resolve(state.settings); } catch (e) { return fail(e, "Printer settings problem: "); }
    const style = styleOf(cfg.writing.style);
    if (!style) return fail(new Error("That handwriting style is gone. Pick another one."));
    const { clean, dropped } = E.cleanText(state.text);
    $("skipped").hidden = !dropped.size;
    $("skipped").textContent = dropped.size ? `Skipped characters the handwriting can't write: ${[...dropped].join(" ")}` : "";
    const paras = G.words(clean, state.seed), all = paras.flat();
    const cap = updateCapacity();
    // Clearly too long: say so now instead of writing every word first (borderline cases are decided by the real layout).
    if (cap && cap.pages > G.MAX_PAGES * 1.2)
      return fail(new G.WriteError(`Too much text: it needs about ${cap.pages} pages (${G.MAX_PAGES} at most). Shorten it, use smaller letters or bigger paper.`));
    if (!all.length) { state.view = null; state.error = ""; setBusy(false, "Type some text"); draw(); return updateSummary(); }
    const long = all.find(w => w.word.length > G.MAX_WORD);
    if (long) return fail(new Error(`The word "${long.word.slice(0, 20)}…" is too long (${G.MAX_WORD} letters at most).`));

    const bias = cfg.writing.bias;
    const need = [...new Map(all.flatMap(w => w.parts || [w]).filter(w => !inkCache.has(inkKey(style.key, bias, w))).map(w => [inkKey(style.key, bias, w), w])).values()];
    if (need.length) {
      let done = 0;
      setBusy(true, `Writing 0 / ${need.length} words`);
      try {
        await Promise.all(need.map(w => pool.word(style, w.word, w.seed, bias, false, "page").then(ink => {
          inkCache.set(inkKey(style.key, bias, w), ink);
          if (token === renderToken) setBusy(true, `Writing ${++done} / ${need.length} words`);
        })));
      } catch (e) {
        if (token !== renderToken || e.message === "cancelled") return;
        return fail(e, "The handwriting model failed: ");
      }
    }
    if (token !== renderToken) return;
    try {
      const rng = E.makeRng((state.seed ^ 0x5bd1e995) >>> 0); // layout randomness, separate from the words'
      const pages = G.layoutPages(paras, w => inkCache.get(inkKey(style.key, bias, w)), cfg, rng).map((lines, k, all) => {
        try { return { lines, passes: G.planPasses(lines, cfg) }; }
        catch (e) { if (all.length > 1) e.message = `Page ${k + 1}: ${e.message}`; throw e; }
      });
      state.view = { cfg, pages };
      state.page = Math.min(state.page || 0, pages.length - 1);
      state.error = "";
      setBusy(false, "Ready");
    } catch (e) { return fail(e); }
    draw(); updateSummary();
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
    $("statusText").textContent = text;
    $("save").disabled = $("saveAll").disabled = busy || !state.view || !!state.error;
  }
  function updateSummary() {
    $("error").hidden = !state.error;
    $("error").textContent = state.error;
    const v = cur(), n = state.view ? state.view.pages.length : 0;
    $("pager").hidden = n < 2; $("saveAll").hidden = n < 2;
    $("save").textContent = n > 1 ? `Save page ${state.page + 1}` : "Save G-code";
    if (n > 1) { $("pageLabel").textContent = `Page ${state.page + 1} of ${n}`; $("saveAll").textContent = `Save all ${n} pages`; }
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
    const sec = draw / pr.draw_feed * 60 * 1.3 + travel / pr.travel_feed * 60 * 1.5 + lifts * zTime +
      pr.paper_pause_s + pr.pen_pause_s + (passes.length - 1) * pr.shift_pause_s + 40; // +40 s homing
    if (pr.sounds && G.SOUND_PRINTERS.has(pr.model)) { // each tune: a 1 s wait, then its notes (10 ms units)
      const t = name => 1 + G.TUNES[name].reduce((a, n) => a + n[1], 0) / 100;
      return sec + t("start") + t("finish") + (2 + (passes.length - 1)) * (t("pause") + t("resume"));
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
  const canvas = $("plate"), ctx = canvas.getContext("2d");
  const view = { zoom: 1, panX: 0, panY: 0, s: 1, ox: 0, oy: 0 };
  let drag = null;
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
    if (!cfg) return;
    const pr = cfg.printer, p = cfg.paper, bx = pr.bed_x, by = pr.bed_y;
    const s = Math.min(W / (bx * 1.35), H / (by * 1.35)) * view.zoom;
    const limX = W / 2 + bx * s / 2 - 60, limY = H / 2 + by * s / 2 - 60; // keep some plate in view
    view.panX = Math.min(Math.max(view.panX, -limX), limX); view.panY = Math.min(Math.max(view.panY, -limY), limY);
    Object.assign(view, { s, ox: (W - bx * s) / 2 + view.panX, oy: (H - by * s) / 2 + view.panY, by });
    const X = x => view.ox + x * s, Y = y => view.oy + (by - y) * s;

    // plate + grid
    ctx.fillStyle = "#3a3d42"; roundRect(X(0), Y(by), bx * s, by * s, 6 * Math.min(1, s)); ctx.fill();
    ctx.lineWidth = 1;
    for (let g = 10; g < Math.max(bx, by); g += 10) {
      if (g % 50 && s * 10 < 12) continue; // fine grid only when zoomed in enough to tell lines apart
      ctx.strokeStyle = g % 50 ? "#43464c" : "#52565d";
      if (g < bx) line(X(g), Y(0), X(g), Y(by));
      if (g < by) line(X(0), Y(g), X(bx), Y(g));
    }
    if (pr.keepout) { // nozzle may not go here (P1/X1 filament cutter); shown where the pen would be
      const [a, b, c, d] = pr.keepout;
      ctx.fillStyle = "rgba(201,42,42,.35)";
      ctx.fillRect(X(a + pr.offset_x), Y(d + pr.offset_y), (c - a) * s, (d - b) * s);
    }
    // paper (in pass 1 position) + writing area
    const pX = px => X(p.x + px), pY = py => Y(p.y + p.height - py);
    ctx.fillStyle = "#ffffff"; ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 8;
    ctx.fillRect(pX(0), pY(0), p.width * s, p.height * s); ctx.shadowBlur = 0;
    const [l, t, r, b] = G.writingArea(cfg);
    if (r > l && b > t) { ctx.setLineDash([5, 4]); ctx.strokeStyle = "#7aa2d6"; ctx.strokeRect(pX(l), pY(t), (r - l) * s, (b - t) * s); }
    // handwriting
    const v = cur();
    if (v) {
      ctx.setLineDash([]); ctx.strokeStyle = "#1b2a6b"; ctx.fillStyle = "#1b2a6b";
      ctx.lineWidth = Math.max(0.8, 0.5 * s); ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      for (const ln of v.lines) for (const st of ln) {
        ctx.moveTo(pX(st[0][0]), pY(st[0][1]));
        if (st.length === 1) ctx.lineTo(pX(st[0][0]) + 0.01, pY(st[0][1]));
        for (let i = 1; i < st.length; i++) ctx.lineTo(pX(st[i][0]), pY(st[i][1]));
      }
      ctx.stroke();
      // where the paper gets slid between passes
      for (let k = 1; k < v.passes.length; k++) {
        const prevB = G.extent(v.passes[k - 1].strokes)[3], nextT = G.extent(v.passes[k].strokes)[1], yy = (prevB + nextT) / 2;
        ctx.setLineDash([6, 4]); ctx.strokeStyle = "#c92a2a"; ctx.lineWidth = 1.5;
        line(pX(0), pY(yy), pX(p.width), pY(yy));
        label(`pass ${k + 1}: slide paper ${v.passes[k].shift - v.passes[k - 1].shift} mm back`, pX(p.width) - 6, pY(yy) - 6, "#c92a2a", "right");
      }
    }
    ctx.setLineDash([7, 5]); ctx.strokeStyle = "#e08a00"; ctx.lineWidth = 2; ctx.strokeRect(X(0), Y(by), bx * s, by * s);
    ctx.setLineDash([]);
    label(`${pr.model} · plate ${bx} × ${by} mm`, 14, 22, css("--muted"), "left");
    label("FRONT OF PRINTER", W / 2, H - 58, css("--muted"), "center");
  }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function label(text, x, y, color, align) {
    ctx.font = "600 12px system-ui, sans-serif"; ctx.textAlign = align; ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(text).width, x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    ctx.fillStyle = css("--panel") || "#fff"; ctx.globalAlpha = .9; ctx.fillRect(x0 - 6, y - 14, w + 12, 20); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function toBed(e) { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left - view.ox) / view.s, view.by - (e.clientY - r.top - view.oy) / view.s]; }
  function onPaper(e) {
    const cfg = plateCfg(); if (!cfg) return false;
    const [x, y] = toBed(e), p = cfg.paper;
    return x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height;
  }
  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId);
    const p = state.settings.paper;
    drag = e.button === 0 && onPaper(e) ? { kind: "paper", start: toBed(e), x: p.x, y: p.y } : { kind: "pan", sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY };
  });
  canvas.addEventListener("pointermove", e => {
    canvas.style.cursor = drag ? "grabbing" : onPaper(e) ? "grab" : "default";
    if (!drag) return;
    if (drag.kind === "pan") { view.panX = drag.px + e.clientX - drag.sx; view.panY = drag.py + e.clientY - drag.sy; return draw(); }
    const cfg = plateCfg(); if (!cfg) return;
    const [x, y] = toBed(e), p = state.settings.paper, pr = cfg.printer;
    // keep at least 20 mm of paper over the plate so it can't be lost
    p.x = Math.round(Math.min(Math.max(drag.x + x - drag.start[0], 20 - cfg.paper.width), pr.bed_x - 20));
    p.y = Math.round(Math.min(Math.max(drag.y + y - drag.start[1], 20 - cfg.paper.height), pr.bed_y - 20));
    relayout();
  });
  canvas.addEventListener("pointerup", () => { if (drag && drag.kind === "paper") scheduleRender(0); drag = null; });
  canvas.addEventListener("wheel", e => { e.preventDefault(); zoomAt(Math.pow(1.0015, -e.deltaY), e); }, { passive: false });
  function zoomAt(f, e) {
    const r = canvas.getBoundingClientRect(), mx = e ? e.clientX - r.left : r.width / 2, my = e ? e.clientY - r.top : r.height / 2;
    const z = Math.min(Math.max(view.zoom * f, 1), 14), k = z / view.zoom, W = canvas.clientWidth, H = canvas.clientHeight;
    const cfg = plateCfg(); if (!cfg) return;
    const bx = cfg.printer.bed_x, by = cfg.printer.bed_y, s1 = view.s * k;
    view.panX = mx - (mx - view.ox) * k - (W - bx * s1) / 2;
    view.panY = my - (my - view.oy) * k - (H - by * s1) / 2;
    view.zoom = z; draw();
  }
  /** Paper moved: words are cached, so re-layout is instant; done on the next frame to keep dragging smooth. */
  let frame = 0;
  function relayout() { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => render()); }
  new ResizeObserver(() => draw()).observe(canvas);
  $("zoomIn").onclick = () => zoomAt(1.5); $("zoomOut").onclick = () => zoomAt(1 / 1.5);
  $("zoomFit").onclick = () => { Object.assign(view, { zoom: 1, panX: 0, panY: 0 }); draw(); };

  // ---------- controls ----------
  const W_ = () => state.settings.writing, P_ = () => state.settings.paper, PR_ = () => state.settings.printer;
  $("text").value = state.text;
  $("text").addEventListener("input", e => { state.text = e.target.value; scheduleRender(); });
  for (const [id, key] of [["bias", "bias"], ["wobble", "wobble"]]) {
    const el = $(id), out = el.nextElementSibling;
    el.value = W_()[key]; out.textContent = (+el.value).toFixed(2);
    el.addEventListener("input", () => { W_()[key] = +el.value; out.textContent = (+el.value).toFixed(2); scheduleRender(key === "wobble" ? 60 : 400); });
  }
  bindNumber("xh", () => W_(), "x_height", 60);
  bindNumber("margin", () => P_(), "margin", 60);
  bindNumber("marginY", () => P_(), "margin_y", 60);
  function bindNumber(id, obj, key, delay) {
    const el = $(id); el.value = obj()[key];
    el.addEventListener("input", () => { if (el.value !== "" && Number.isFinite(+el.value)) { obj()[key] = +el.value; scheduleRender(delay); } });
  }
  for (const m of Object.keys(G.PRINTERS)) $("printer").add(new Option(m, m));
  for (const m of Object.keys(G.PAPERS)) $("paper").add(new Option(m, m));
  $("printer").value = PR_().model; $("paper").value = P_().size;
  $("printer").onchange = () => { PR_().model = $("printer").value; centrePaper(); };
  $("paper").onchange = () => { P_().size = $("paper").value; centrePaper(); };
  for (const o of ["portrait", "landscape"]) $(o).onclick = () => { P_().orientation = o; syncOrientation(); centrePaper(); };
  function syncOrientation() { for (const o of ["portrait", "landscape"]) $(o).setAttribute("aria-pressed", P_().orientation === o); }
  syncOrientation();
  function centrePaper() {
    try {
      const cfg = G.resolve(state.settings);
      P_().x = Math.round((cfg.printer.bed_x - cfg.paper.width) / 2);
      P_().y = Math.round((cfg.printer.bed_y - cfg.paper.height) / 2);
    } catch { /* invalid settings: render() explains */ }
    Object.assign(view, { zoom: 1, panX: 0, panY: 0 });
    scheduleRender(0);
  }
  const syncSounds = () => {
    $("sounds").checked = PR_().sounds !== false;
    const ok = G.SOUND_PRINTERS.has(PR_().model);
    $("sounds").disabled = !ok;
    $("soundsNote").textContent = ok ? "Tunes at start, pauses, resume and finish" : "Not supported by this printer";
  };
  $("sounds").onchange = () => { PR_().sounds = $("sounds").checked; scheduleRender(0); };
  $("printer").addEventListener("change", syncSounds);
  syncSounds();
  $("reroll").onclick = () => { state.seed = (Math.random() * 2 ** 31) | 0; scheduleRender(0); };

  // ---------- handwriting style picker with live previews ----------
  const thumbs = new Map();
  function buildStyles() {
    const box = $("styles"); box.textContent = "";
    let group = "";
    for (const st of allStyles()) {
      const g = st.group || "Mine";
      if (g !== group) { const h = document.createElement("div"); h.className = "style-group"; h.textContent = (group = g); box.append(h); }
      const b = document.createElement("button");
      b.type = "button"; b.className = "style" + (st.key.startsWith("u:") ? " mine" : "");
      b.setAttribute("aria-pressed", W_().style === st.key);
      b.title = st.label;
      const c = document.createElement("canvas"); c.width = 220; c.height = 68;
      b.append(c, document.createTextNode(st.label));
      b.onclick = () => {
        W_().style = st.key;
        if (st.bias !== undefined) { W_().bias = st.bias; $("bias").value = st.bias; $("bias").nextElementSibling.textContent = st.bias.toFixed(2); }
        buildStyles(); scheduleRender(0);
      };
      box.append(b);
      if (thumbs.has(st.key)) paintThumb(c, thumbs.get(st.key));
      else pool.word(st, "Handwriting", 7, st.bias ?? 1, true).then(ink => { thumbs.set(st.key, ink); paintThumb(c, ink); if (st.key === W_().style) updateCapacity(); }).catch(() => {});
    }
  }
  function paintThumb(c, ink) {
    const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of ink) for (const [x, y] of s) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const k = Math.min((c.width - 16) / (x1 - x0), (c.height - 12) / (y1 - y0));
    g.strokeStyle = "#1b2a6b"; g.lineWidth = 2; g.lineCap = g.lineJoin = "round"; g.beginPath();
    for (const s of ink) { s.forEach(([x, y], i) => { const px = 8 + (x - x0) * k, py = c.height - 6 - (y - y0) * k; i ? g.lineTo(px, py) : g.moveTo(px, py); }); }
    g.stroke();
  }

  // ---------- printer settings dialog ----------
  const HELP = {
    paper_pause_s: ["Pause 1: place the paper", "s", "After homing, the head rises and stops right above where the first letter will be written, then waits this long. Put the paper where the preview shows it and tape it down. The pen is not in the holder yet."],
    pen_pause_s: ["Pause 2: attach the pen", "s", "The head lowers to the writing height over the first letter and waits this long. Slide the pen down through the holder until the tip just touches the paper, then clamp it. Writing starts when the pause ends."],
    shift_pause_s: ["Pause 3: slide the paper", "s", "Only for pages longer than the plate, like A4 on an A1. The pen stops just above where the last written mark must end up; slide the paper toward the back until that mark is right under the pen tip. Once per extra pass."],
    z_draw: ["Writing height", "mm", "Nozzle height while the pen is down. The pen is clamped touching the paper at this height in pause 2, so any height that clears the holder works. At least 2 mm."],
    z_lift: ["Pen-up height", "mm", "Nozzle height when moving between strokes. About 2 mm above the writing height: handwriting lifts the pen thousands of times."],
    offset_x: ["Pen offset X", "mm", "Pen tip position minus nozzle position, left/right. BambuPlot calls this the tool offset."],
    offset_y: ["Pen offset Y", "mm", "Same, front/back."],
    draw_feed: ["Writing speed", "mm/min", "1500 is about the speed of real handwriting."],
    travel_feed: ["Travel speed", "mm/min", "Speed of pen-up moves between strokes."],
    z_feed: ["Up/down speed", "mm/min", "How fast the pen is lifted and lowered."],
    settle_ms: ["Pen settle time", "ms", "A tiny wait after every pen down and up so the ink starts and stops cleanly. Raise it if strokes start faint."],
    line_spacing: ["Line spacing", "mm", "Baseline to baseline. Ruled paper is 7 to 8.7."],
    word_spacing: ["Word spacing", "× letter", "Gap between words, in letter heights."],
    bed_x: ["Bed width", "mm", "Only used when the printer is Custom."],
    bed_y: ["Bed depth", "mm", "Only used when the printer is Custom."],
    bed_z: ["Max height", "mm", "How high the nozzle can go. Only used when the printer is Custom."],
    width: ["Paper width", "mm", "Only used when the paper is Custom."],
    height: ["Paper height", "mm", "Only used when the paper is Custom."],
  };
  const GROUPS = [
    ["Pauses during printing", "printer", ["paper_pause_s", "pen_pause_s", "shift_pause_s"]],
    ["Pen heights", "printer", ["z_draw", "z_lift"]],
    ["Pen offset", "printer", ["offset_x", "offset_y"]],
    ["Speeds", "printer", ["draw_feed", "travel_feed", "z_feed", "settle_ms"]],
    ["Lines", "writing", ["line_spacing", "word_spacing"]],
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
      body.append(fs);
    }
    $("settingsDlg").showModal();
  };
  $("settingsSave").onclick = e => {
    const next = structuredClone(state.settings);
    for (const inp of $("settingsBody").querySelectorAll("input")) next[inp.dataset.sec][inp.dataset.key] = inp.value === "" ? NaN : +inp.value;
    try { G.resolve(next); } catch (err) { e.preventDefault(); $("settingsMsg").textContent = err.message; return; }
    state.settings = next; scheduleRender(0);
  };

  // ---------- my handwriting: capture, save, import/export ----------
  const SENTENCES = ["the quick brown fox jumps over", "Pack my box with five dozen jugs", "Hello, how are you doing today?",
    "I hope this letter finds you well.", "See you soon - love, me"];
  let sentenceIdx = 0, padStrokes = [], current = null, penSeen = false;
  const pad = $("pad"), pctx = pad.getContext("2d");
  $("openMine").onclick = () => {
    $("sentence").value = SENTENCES[sentenceIdx]; $("mineName").value = `Mine ${mine.length + 1}`; $("mineMsg").textContent = "";
    padStrokes = []; listMine(); $("mineDlg").showModal(); sizePad();
  };
  $("nextSentence").onclick = () => { sentenceIdx = (sentenceIdx + 1) % SENTENCES.length; $("sentence").value = SENTENCES[sentenceIdx]; };
  function sizePad() { const d = window.devicePixelRatio || 1; pad.width = pad.clientWidth * d; pad.height = pad.clientHeight * d; pctx.setTransform(d, 0, 0, d, 0, 0); drawPad(); }
  function drawPad() {
    const w = pad.clientWidth, h = pad.clientHeight;
    pctx.clearRect(0, 0, w, h);
    pctx.strokeStyle = "#d6def5"; pctx.lineWidth = 1;
    for (const y of [h * 0.45, h * 0.7]) { pctx.beginPath(); pctx.moveTo(0, y); pctx.lineTo(w, y); pctx.stroke(); }
    pctx.strokeStyle = "#1b2a6b"; pctx.lineWidth = 2.5; pctx.lineCap = pctx.lineJoin = "round";
    for (const s of padStrokes) { pctx.beginPath(); s.forEach(([x, y], i) => i ? pctx.lineTo(x, y) : pctx.moveTo(x, y)); if (s.length === 1) pctx.lineTo(s[0][0] + .1, s[0][1]); pctx.stroke(); }
  }
  const padPos = e => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const ignoreTouch = e => penSeen && e.pointerType === "touch"; // palm rejection once a stylus is used
  pad.addEventListener("pointerdown", e => { if (e.pointerType === "pen") penSeen = true; if (ignoreTouch(e)) return; pad.setPointerCapture(e.pointerId); current = [padPos(e)]; padStrokes.push(current); drawPad(); });
  pad.addEventListener("pointermove", e => { if (!current || ignoreTouch(e)) return; for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) current.push(padPos(ev)); drawPad(); });
  for (const t of ["pointerup", "pointercancel"]) pad.addEventListener(t, () => { current = null; });
  $("undo").onclick = () => { padStrokes.pop(); drawPad(); };
  $("clear").onclick = () => { padStrokes = []; drawPad(); };
  $("saveMine").onclick = () => {
    const msg = $("mineMsg"), { clean, dropped } = E.cleanText($("sentence").value.trim());
    if (dropped.size || clean.includes("\n") || clean.length < 3) return void (msg.textContent = "Use 3-60 letters, digits or basic punctuation in the sentence.");
    const pts = padStrokes.reduce((n, s) => n + s.length, 0);
    if (pts < 10 * clean.length) return void (msg.textContent = "Write the whole sentence first.");
    try {
      const strokes = E.preparePrimer(padStrokes, clean);
      const name = ($("mineName").value.trim() || `Mine ${mine.length + 1}`).slice(0, 30);
      const item = { id: Date.now().toString(36), name, chars: clean, strokesB64: f32ToB64(strokes) };
      mine.push(toStyle(item)); saveMine();
      W_().style = "u:" + item.id;
      padStrokes = []; drawPad(); listMine(); buildStyles(); scheduleRender(0);
      msg.textContent = `Saved "${name}" and selected it. Write another sentence to make more styles.`;
      $("mineName").value = `Mine ${mine.length + 1}`;
    } catch (err) { msg.textContent = "Could not use that sample: " + err.message; }
  };
  function listMine() {
    const box = $("mineList"); box.textContent = "";
    if (!mine.length) { box.innerHTML = '<p class="hint">None yet.</p>'; return; }
    for (const st of mine) {
      const row = document.createElement("div"); row.className = "mine-item";
      row.innerHTML = "<div><b></b><br><small></small></div>";
      row.querySelector("b").textContent = st.label; row.querySelector("small").textContent = `“${st.data.chars}”`;
      const del = document.createElement("button"); del.type = "button"; del.className = "btn small"; del.textContent = "Delete";
      del.onclick = () => { mine = mine.filter(m => m !== st); saveMine(); if (W_().style === st.key) W_().style = presets[0].key; listMine(); buildStyles(); scheduleRender(0); };
      row.append(del); box.append(row);
    }
  }
  $("exportMine").onclick = () => download(JSON.stringify({ format: "handwrite-styles", version: 1, styles: mine.map(m => m.raw) }, null, 1), "my-handwriting.json", "application/json");
  $("importMine").onchange = async e => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 5e6) throw new Error("file too large");
      const data = JSON.parse(await file.text());
      const items = (data && data.format === "handwrite-styles" && Array.isArray(data.styles)) ? data.styles : null;
      if (!items) throw new Error("not a handwriting file from this app");
      let added = 0;
      for (const it of items.slice(0, 200)) { const st = toStyle(it); if (!mine.some(m => m.key === st.key)) { mine.push(st); added++; } }
      saveMine(); listMine(); buildStyles();
      $("mineMsg").textContent = `Imported ${added} handwriting style${added === 1 ? "" : "s"}.`;
    } catch (err) { $("mineMsg").textContent = "Import failed: " + err.message; }
  };
  /** Stored style -> picker entry. Validates everything, since it may come from an imported file. */
  function toStyle(it) {
    if (!it || typeof it.id !== "string" || !/^[a-z0-9]{1,20}$/i.test(it.id)) throw new Error("bad style id");
    if (typeof it.name !== "string" || typeof it.chars !== "string" || typeof it.strokesB64 !== "string") throw new Error("bad style fields");
    const { clean, dropped } = E.cleanText(it.chars);
    if (dropped.size || !clean || clean.length > 120) throw new Error("bad style text");
    const bytes = E.b64ToBytes(it.strokesB64);
    if (bytes.length % 12 || bytes.length === 0 || bytes.length > E.MAX_STROKE_LEN * 12) throw new Error("bad style strokes");
    const strokes = new Float32Array(bytes.buffer);
    if (!strokes.every(Number.isFinite)) throw new Error("bad style strokes");
    const raw = { id: it.id, name: it.name.slice(0, 30), chars: clean, strokesB64: it.strokesB64 };
    const bias = typeof it.bias === "number" && it.bias >= 0 && it.bias <= 2 ? it.bias : undefined; // neatness it looks best at
    if (bias !== undefined) raw.bias = bias;
    return { key: "u:" + raw.id, label: raw.name, group: "Mine", bias, data: { strokes, chars: clean }, raw };
  }
  function loadMine() { const out = []; for (const it of load(STORE.styles, [])) { try { out.push(toStyle(it)); } catch { /* skip damaged */ } } return out; }
  function saveMine() { keep(STORE.styles, mine.map(m => m.raw)); }
  function f32ToB64(f) { const b = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }

  // ---------- save G-code ----------
  $("save").onclick = async () => {
    const v = cur(), n = state.view ? state.view.pages.length : 0;
    if (!v || state.error || state.busy) return;
    let gcode;
    try {
      const cfg = G.resolve(state.settings); // the exact settings shown now, checked again
      if (JSON.stringify(cfg) !== JSON.stringify(v.cfg)) { await render(); return $("save").click(); }
      gcode = G.toGcode(G.planPasses(v.lines, cfg), cfg, [...G.describe(cfg, state.seed), ...(n > 1 ? [`page ${state.page + 1} of ${n}`] : []),
        `estimated time: about ${eta(v).dur} (including pauses)`]);
    } catch (e) { return fail(e); }
    const name = n > 1 ? pageFile(state.page, n) : `handwriting-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.gcode`;
    const where = await download(gcode, name, "text/plain");
    if (!where) return;
    const t = eta(v);
    $("savedWhere").textContent = `${where} Only run it on the ${v.cfg.printer.model}. Writing takes about ${t.dur} including the pauses (done around ${t.at} if you start now).`;
    showSteps(v, []);
  };
  function showSteps(v, extra) {
    const steps = [...extra, "Take the pen out of the holder. The printer homes first, and homing touches the nozzle to the plate.",
      `Start the file. The head moves over the first letter and waits ${v.cfg.printer.paper_pause_s} s: put the paper where the preview shows and tape it down.`,
      `The head lowers and waits ${v.cfg.printer.pen_pause_s} s: slide the pen down until it touches the paper, then clamp it.`];
    if (v.passes.length > 1) steps.push(G.passNote(v.passes) + ` You have ${v.cfg.printer.shift_pause_s} s each time.`);
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
      files = view.pages.map((p, k) => ({ name: pageFile(k, n), text: G.toGcode(G.planPasses(p.lines, cfg), cfg,
        [...G.describe(cfg, state.seed), `page ${k + 1} of ${n}`, `estimated time: about ${eta({ cfg, passes: p.passes }).dur} (including pauses)`]) }));
    } catch (e) { return fail(e); }
    // A plain download, not the folder picker: Edge/Chrome refuse to let a page pick Downloads itself ("contains system files").
    saveBlob(makeZip(files), "handwriting-pages.zip");
    const where = `Saved handwriting-pages.zip (${files[0].name} to ${files[n - 1].name}) to your Downloads folder. Open it and copy the files onto the SD card.`;
    const all = eta(view.pages.reduce((sum, p) => sum + estimate({ cfg: view.cfg, passes: p.passes }), 0));
    $("savedWhere").textContent = `${where} Only run them on the ${view.cfg.printer.model}. All pages together take about ${all.dur}, plus changing the paper.`;
    showSteps({ cfg: view.cfg, passes: [] }, [`Print the files in order, ${files[0].name} first. Each page is a complete job: put a fresh sheet in for each one.`]);
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
  const goPage = d => { if (!state.view) return; state.page = Math.min(Math.max(state.page + d, 0), state.view.pages.length - 1); draw(); updateSummary(); };
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
  buildStyles();
  render();
})();
