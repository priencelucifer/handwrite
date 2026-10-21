"""Record your handwriting from a phone/tablet as a style for write.py.

    python capture_server.py
then open the printed http://<this-pc>:8000 address on your phone (same Wi-Fi).
"""
import json
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

import model

PORT = 8000
MAX_BODY = 2_000_000


def save_capture(payload):
    """Validate a capture from the page and store it as styles/<name>-*.npy. Returns the style name."""
    name, text, strokes = payload.get("name"), payload.get("text"), payload.get("strokes")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]{1,32}", name):
        raise ValueError("name must be 1-32 chars of a-z, 0-9, -")
    if not isinstance(text, str) or not 3 <= len(text) <= 60:
        raise ValueError("text must be 3-60 characters")
    clean, dropped = model.clean_text(text)
    if dropped or "\n" in clean:
        raise ValueError(f"the model can't learn these characters: {' '.join(sorted(dropped)) or 'newline'}")
    if not isinstance(strokes, list) or not 1 <= len(strokes) <= 400:
        raise ValueError("no strokes")
    pts = [np.asarray(s, float) for s in strokes]
    if any(p.ndim != 2 or p.shape[1] != 2 or len(p) == 0 or not np.isfinite(p).all() for p in pts):
        raise ValueError("bad stroke data")
    if sum(len(p) for p in pts) < 10 * len(clean):
        raise ValueError("too little ink for that text: write the whole line")
    model.save_style(name, model.prepare_primer(pts, clean), clean)
    return name


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # default logs to stderr, which is None in the windowed app and would crash every request

    def do_GET(self):
        if self.path not in ("/", "/index.html"):
            return self.send_error(404)
        body = (model.HERE / "capture.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/save":
            return self.send_error(404)
        n = int(self.headers.get("Content-Length", 0))
        try:
            if not 0 < n <= MAX_BODY:
                raise ValueError("capture too large")
            name = save_capture(json.loads(self.rfile.read(n)))
            status, reply = 200, {"ok": True, "style": name}
            print(f"saved style {name!r}  ->  python write.py --style {name} --text \"...\"")
        except (ValueError, json.JSONDecodeError) as e:
            status, reply = 400, {"ok": False, "error": str(e)}
        body = json.dumps(reply).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.168.0.1", 1))  # no packet is sent; just picks the LAN interface
            return s.getsockname()[0]
        except OSError:
            return "localhost"


def start():
    """Serve the capture page from a background thread (for the app). Returns the phone URL."""
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://{lan_ip()}:{PORT}"


if __name__ == "__main__":
    print(f"Open http://{lan_ip()}:{PORT} on your phone (same Wi-Fi). Ctrl+C to stop.")
    print("If it doesn't load, allow Python through Windows Firewall for private networks.")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
