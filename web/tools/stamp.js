// Stamps app.html's scripts with a hash of their contents (src="gcode.js?v=1a2b3c4d"): the host lets browsers keep a
// script for hours, so a changed file needs a new address or people keep running the old one. Run after editing any
// script: node web/tools/stamp.js (web/tests/pages.test.js fails while a stamp is stale).
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const WEB = path.join(__dirname, ".."), PAGE = path.join(WEB, "app.html");
// (line endings ignored: a Windows checkout must stamp the same as the deployed copy)
const stamp = f => crypto.createHash("sha1").update(fs.readFileSync(path.join(WEB, f), "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 8);
const stamped = html => html.replace(/<script src="([\w-]+\.js)(?:\?v=\w+)?">/g, (_, f) => `<script src="${f}?v=${stamp(f)}">`);
if (require.main === module) { fs.writeFileSync(PAGE, stamped(fs.readFileSync(PAGE, "utf8"))); console.log("stamped app.html"); }
module.exports = { stamped, PAGE };
