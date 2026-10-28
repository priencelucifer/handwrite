// The site lives at handplot.org. A visit to an old address (handwrite.rickykashyap.top, or www.) goes on to the same
// page there, taking along what this browser saved at the old one (settings, pen offset, text: the hw.* keys) in the
// #fragment, which browsers never send to a server. handplot.org keeps whatever it doesn't already have, and only when
// the visit really came from an old address, so a link can't slip settings into someone's printer.
(function () {
  var HOME = "https://handplot.org", OLD = ["handwrite.rickykashyap.top", "www.handplot.org"];
  if (OLD.indexOf(location.hostname) >= 0) {
    var saved = {}, size = 0;
    try { // most important first; a very long text stays behind rather than make a link too long to open
      ["hw.settings", "hw.seed", "hw.toured", "hw.tips", "hw.more", "hw.edits", "hw.text"].forEach(function (k) {
        var v = localStorage.getItem(k);
        if (v !== null && size + v.length < 30000) { saved[k] = v; size += v.length; }
      });
    } catch (e) { /* storage blocked: nothing to take */ }
    document.documentElement.style.visibility = "hidden"; // no flash of the old page on the way
    location.replace(HOME + location.pathname + location.search + (size ? "#moved=" + encodeURIComponent(JSON.stringify(saved)) : location.hash));
    return;
  }
  var m = /^#moved=(.+)$/.exec(location.hash);
  if (!m) return;
  try {
    if (OLD.some(function (h) { return document.referrer.indexOf("https://" + h + "/") === 0; })) {
      var got = JSON.parse(decodeURIComponent(m[1]));
      for (var k in got) if (/^hw\.[a-z]+$/.test(k) && typeof got[k] === "string" && localStorage.getItem(k) === null) localStorage.setItem(k, got[k]);
    }
  } catch (e) { /* a broken fragment or blocked storage: start fresh */ }
  history.replaceState(null, "", location.pathname + location.search);
})();
