"""Builds dist/Handwrite-web.zip: the web app in a Handwrite/ folder, index.html renamed to Handwrite.html."""
import zipfile
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
FILES = ["index.html", "app.js", "engine.js", "gcode.js", "weights.js", "styles.js", "README.txt"]

out = WEB.parent / "dist" / "Handwrite-web.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(WEB / f, "Handwrite/" + ("Handwrite.html" if f == "index.html" else f))
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
