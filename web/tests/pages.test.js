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
  assert.ok(index.includes('href="printers.html"') && index.includes('href="#printers"'));
  assert.ok(read("sitemap.xml").includes("<loc>https://handplot.org/printers</loc>"));
});
