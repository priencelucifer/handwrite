"""Builds dist/Handwrite-web.zip: the web app in a Handwrite/ folder. On the website index.html is the guide and app.html
the app; in the zip, where people double-click a file, they are Guide.html and Handwrite.html (links between them follow)."""
import zipfile
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
RENAME = {"app.html": "Handwrite.html", "index.html": "Guide.html"}
FILES = ["app.html", "index.html", "guide-app.png", "app.js", "engine.js", "gcode.js", "weights.js", "styles.js", "README.txt"]

out = WEB.parent / "dist" / "Handwrite-web.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        if f in RENAME:
            html = (WEB / f).read_text(encoding="utf-8")
            for old, new in RENAME.items():
                html = html.replace(f'href="{old}"', f'href="{new}"')
            z.writestr("Handwrite/" + RENAME[f], html)
        else:
            z.write(WEB / f, "Handwrite/" + f)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
