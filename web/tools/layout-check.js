// Opens every page of the site in a real browser (Edge or Chrome, already installed) at phone, tablet, laptop and desktop
// sizes, with every folded part and <details> open, and reports what a person would see as broken: text squeezed into a
// narrow column, the page scrolling sideways, something sticking out past the screen, cards overlapping, a button's
// label cut off, a broken image, a script error.
//   node web/tools/layout-check.js            check, list problems, exit 1 if any
//   node web/tools/layout-check.js --shots D  also save a full-page screenshot of each page at each size into D
"use strict";
const { spawn } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const WEB = path.join(__dirname, "..");

const PAGES = [["/", "guide"], ["/app", "app"], ["/printers", "printers"], ["/404.html", "404"]]
  .filter(([, l]) => !process.env.ONLY || process.env.ONLY.split(",").includes(l)); // ONLY=guide,app to check just those
const SIZES = [[320, 640, "small phone"], [375, 812, "phone"], [430, 932, "large phone"], [768, 1024, "tablet"],
  [1024, 768, "tablet landscape"], [1280, 800, "laptop"], [1600, 1000, "desktop"], [1920, 1080, "wide desktop"]];

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
const findBrowser = () => process.env.BROWSER || BROWSERS.find(f => fs.existsSync(f));

// the site as the host serves it: /app is app.html, /printers is printers.html
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".xml": "application/xml",
  ".txt": "text/plain", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html"; else if (!path.extname(p)) p += ".html";
    const f = path.join(WEB, p);
    if (!f.startsWith(WEB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

// runs in the page: open everything up, then look
const PREP = `(async () => {
  document.documentElement.classList.remove("rv-on"); // the scroll-in animation's start state
  for (const b of document.querySelectorAll(".folded > .fold-bar .fold-btn")) b.click();
  for (const d of document.querySelectorAll("details")) d.open = true;
  await new Promise(r => setTimeout(r, 400));
})()`;
const CHECK = `(() => {
  const out = [], W = innerWidth, seen = new Set();
  // seen at all: not display:none, invisible or see-through, nor inside a visually hidden box (1 px, clipped: for screen readers)
  const vis = el => { if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.clip !== "auto" || s.clipPath !== "none") return false; } return true; };
  const name = el => { let s = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "");
    const h = el.closest("section, .card, header, footer, nav, aside"); const t = h && h.querySelector("h1, h2, h3");
    return s + (t ? " (in \\"" + t.textContent.trim().slice(0, 40) + "\\")" : ""); };
  const add = (kind, el, more) => { const k = kind + name(el); if (seen.has(k)) return; seen.add(k); out.push(kind + ": " + name(el) + (more ? " " + more : "")); };
  const clipped = el => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const s = getComputedStyle(a); if (s.overflowX !== "visible" || s.position === "fixed") return true; } return false; };

  // 1. the page scrolls sideways
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 1) out.push("page scrolls sideways: " + sw + " px wide on a " + W + " px screen");

  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg, script, style, template, noscript") && el.tagName !== "svg") continue;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width && !r.height) continue;
    // 2. sticking out past the screen (unless a parent clips or scrolls it on purpose)
    if ((r.right > W + 1 || r.left < -1) && s.position !== "fixed" && !clipped(el)) add("off the screen", el, "(" + Math.round(r.left) + " to " + Math.round(r.right) + " px)");
    // 3. a control whose label is cut off
    if (el.matches("button, .btn, a.btn, label, select, h1, h2, h3, h4") && s.overflowX !== "visible" && s.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1)
      add("label cut off", el, "(" + el.scrollWidth + " px of text in " + el.clientWidth + ")");
    // 4. cards in a grid or row overlapping each other
    if (/grid|flex/.test(s.display)) {
      const kids = [...el.children].filter(k => vis(k) && !/absolute|fixed|sticky/.test(getComputedStyle(k).position)).map(k => [k, k.getBoundingClientRect()]).filter(([, b]) => b.width && b.height);
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i][1], b = kids[j][1], x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 2 && y > 2) add("overlapping", kids[j][0], "and " + name(kids[i][0]) + " (" + Math.round(x) + "×" + Math.round(y) + " px)");
      }
    }
    // 5. a broken image
    if (el.tagName === "IMG" && el.complete && !el.naturalWidth) add("image didn't load", el, el.getAttribute("src"));
  }
  // 6. text squeezed into a narrow column: few letters per line (the bug where each word sat on a line of its own)
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange();
  for (let n; (n = walk.nextNode());) {
    const t = n.textContent.replace(/\\s+/g, " ").trim(), el = n.parentElement;
    if (t.length < 40 || !el || el.closest("svg, script, style, pre, code, textarea, noscript") || !vis(el)) continue;
    range.selectNodeContents(n);
    const tops = [...range.getClientRects()].filter(q => q.width > 1).map(q => q.top).sort((a, b) => a - b);
    const lh = parseFloat(getComputedStyle(el).fontSize) * 0.6; let lines = 0, last = -1e9;
    for (const y of tops) if (y - last > lh) { lines++; last = y; }
    if (lines >= 3 && t.length / lines < 14) add("text squeezed", el, "(" + lines + " lines of about " + Math.round(t.length / lines) + " letters, " + Math.round(el.getBoundingClientRect().width) + " px wide: \\"" + t.slice(0, 40) + "…\\")");
  }
  return out;
})()`;

async function check({ shots } = {}) {
  const exe = findBrowser();
  if (!exe) throw Object.assign(new Error("no Edge or Chrome found (set BROWSER to one)"), { code: "NOBROWSER" });
  const server = await serve(), base = `http://127.0.0.1:${server.address().port}`;
  const port = 9300 + Math.floor(Math.random() * 600), prof = fs.mkdtempSync(path.join(os.tmpdir(), "hwlayout-"));
  const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--mute-audio", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "about:blank"], { stdio: "ignore" });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const problems = [];
  try {
    let targets;
    for (let i = 0; i < 75 && !targets; i++) { await sleep(200); try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {} }
    if (!targets) throw new Error("the browser didn't start");
    const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0, errors = [], loaded = null;
    const wait = new Map();
    ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
      if (d.method === "Runtime.exceptionThrown") errors.push("script error: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split("\n")[0]);
      if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push("console error: " + d.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 160));
      if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && d.params.entry.url?.startsWith(base)) errors.push("failed to load: " + d.params.entry.url.slice(base.length));
      if (d.method === "Page.loadEventFired" && loaded) loaded();
    };
    const send = (method, params = {}) => new Promise(r => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error("check failed in the page: " + r.result.exceptionDetails.exception?.description); return r.result.result.value; };
    await send("Runtime.enable"); await send("Page.enable"); await send("Log.enable");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    if (shots) fs.mkdirSync(shots, { recursive: true });
    for (const [url, label] of PAGES) for (const [w, h, size] of SIZES) {
      const mobile = w < 768;
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
      errors = [];
      const ready = new Promise(r => { loaded = r; });
      await send("Page.navigate", { url: base + url });
      await Promise.race([ready, sleep(15000)]);
      await sleep(label === "app" ? 2500 : 800);
      await evaluate(PREP);
      const found = [...new Set([...errors, ...await evaluate(CHECK)])];
      for (const p of found) problems.push(`${label} at ${w}×${h} (${size}): ${p}`);
      if (shots) {
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        fs.writeFileSync(path.join(shots, `${label}-${w}x${h}.png`), Buffer.from(shot.result.data, "base64"));
      }
    }
    ws.close();
  } finally {
    proc.kill(); server.close();
    await sleep(500); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  return problems;
}

module.exports = { check, findBrowser, PAGES, SIZES };

if (require.main === module) {
  const i = process.argv.indexOf("--shots"), shots = i > 0 ? process.argv[i + 1] : null;
  check({ shots }).then(p => {
    console.log(p.length ? p.join("\n") : `no layout problems: ${PAGES.length} pages at ${SIZES.length} sizes`);
    process.exit(p.length ? 1 : 0);
  }, e => { console.error(e.message); process.exit(2); });
}
