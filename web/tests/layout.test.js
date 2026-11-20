// Every page of the site, opened in a real browser at phone, tablet, laptop and desktop sizes with every folded part
// open: no squeezed text, no sideways scrolling, nothing off the screen, no overlapping cards, no cut-off labels, no
// broken images, no script errors. Needs Edge or Chrome (already on most computers; set BROWSER to point at one);
// skipped where there is none. Run: node --test web/tests/layout.test.js   (about 2 minutes)
"use strict";
const test = require("node:test");
const path = require("path");
const L = require(path.join(__dirname, "..", "tools", "layout-check.js"));

test(`every page looks right at ${L.SIZES.length} screen sizes, from a small phone to a wide desktop`, { skip: !L.findBrowser() && "no Edge or Chrome found" }, async () => {
  const problems = await L.check();
  if (problems.length) throw new Error(`${problems.length} layout problem(s); see them with node web/tools/layout-check.js --shots <folder>\n` + problems.join("\n"));
});
