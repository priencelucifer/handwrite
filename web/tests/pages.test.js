// The website's pages stay in step with the printer data: every supported printer is listed, by name, where search
// engines can read it (printers.html), and the home page's count is right. Run: node --test web/tests
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const WEB = path.join(__dirname, ".."), G = require(path.join(WEB, "gcode.js"));
const read = f => fs.readFileSync(path.join(WEB, f), "utf8");
const names = G.PRINTER_GROUPS.filter(([v]) => v !== "Other").flatMap(([, n]) => n);
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

test("printers.html lists every supported printer as plain HTML, and nothing else", () => {
  const html = read("printers.html"), listed = [...html.matchAll(/<li><h3>(.*?)<\/h3>/g)].map(m => m[1]);
  assert.deepEqual(listed, names.map(esc), "re-run: node web/tools/printer-page.js");
  assert.match(html, new RegExp(`<h1>Handwriting on ${names.length} 3D printers</h1>`));
  assert.match(html, /<link rel="canonical" href="https:\/\/handplot\.org\/printers">/);
});

test("the home page links the list and gives the right count; the sitemap has the page", () => {
  const index = read("index.html");
  assert.match(index, new RegExp(`<h2>Works with ${names.length} printers</h2>`), "re-run: node web/tools/printer-page.js");
  assert.ok(index.includes('href="/printers"') && index.includes('href="#printers"'));
  assert.ok(read("sitemap.xml").includes("<loc>https://handplot.org/printers</loc>"));
});

test("app.html loads each script by its current version, so browsers can't keep running an old copy", () => {
  const { stamped, PAGE } = require(path.join(WEB, "tools", "stamp.js")), html = fs.readFileSync(PAGE, "utf8");
  assert.equal((html.match(/<script src="[\w-]+\.js\?v=\w{8}">/g) || []).length, 7);
  assert.ok(html === stamped(html), "a script changed: run node web/tools/stamp.js");
});

// Every tag opened is closed, in order. A missing </div> once nested each setting card in the guide inside the one
// before, so they got narrower and narrower down to a word a line.
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
function tagProblems(html) {
  const out = [], stack = [], blank = m => m.replace(/[^\n]/g, " ");
  const src = html.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, blank);
  const line = i => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[3]) continue;
    if (!m[1]) { stack.push([tag, line(m.index)]); continue; }
    const at = stack.map(t => t[0]).lastIndexOf(tag);
    if (at < 0) { out.push(`line ${line(m.index)}: </${tag}> closes nothing`); continue; }
    for (const [o, l] of stack.splice(at).slice(1)) out.push(`line ${l}: <${o}> is never closed (</${tag}> on line ${line(m.index)} comes first)`);
  }
  return out.concat(stack.map(([o, l]) => `line ${l}: <${o}> is never closed`));
}

test("every page closes each tag it opens, in order", () => {
  const pages = fs.readdirSync(WEB).filter(f => f.endsWith(".html"));
  assert.ok(pages.length >= 4);
  for (const f of pages) assert.deepEqual(tagProblems(read(f)), [], f);
  // the check itself: the guide as it was with the missing </div>
  const broken = read("index.html").replace(/(<h3>Mistakes<\/h3>.*?<span class="def">[^<]*<\/span><\/div>)<\/div>/, "$1");
  assert.notEqual(broken, read("index.html"));
  assert.match(tagProblems(broken).join("\n"), /<div> is never closed \(<\/section> on line \d+ comes first\)/);
  assert.deepEqual(tagProblems("<ul><li>a<li>b</ul>"), ["line 1: <li> is never closed (</ul> on line 1 comes first)", "line 1: <li> is never closed (</ul> on line 1 comes first)"]);
  assert.deepEqual(tagProblems("<p>a</p></div>"), ["line 1: </div> closes nothing"]);
});
