"""Handwrite: type text, preview it as handwriting, save G-code for the pen plotter."""
import copy
import re
import secrets
import threading
import tkinter as tk
import tomllib
import webbrowser
from tkinter import filedialog, messagebox, ttk

import capture_server
import model
import write

CONFIG = model.HERE / "config.toml"
INK = "#1b2a6b"
# Set in the main window (or by dragging the paper), or no longer used, so hidden in Settings.
MAIN_KEYS = {"style", "bias", "wobble", "x_height","model", "size", "orientation", "x", "y", "margin", "pause_after_home_s", "home"}
CONFIG_LINE = re.compile(r'^(?P<key>\w+)\s*=\s*(?P<val>"[^"]*"|\S+)\s*(?:#\s*(?P<note>.*))?$')
SECTIONS = {"printer": "Printer and pen", "paper": "Paper (Custom size only)", "writing": "Writing"}
# Settings window: (label, explanation) per key. Shown from here, not config.toml comments,
# so an installed config from an older version still gets the current help text.
HELP = {
    "paper_pause_s": ("Pause 1: place the paper (seconds)",
                      "After homing, the head rises and stops right above where the first letter will be "
                      "written, then waits this long. Put the paper on the plate where the preview shows it and "
                      "tape it down. The pen is not in the holder yet."),
    "pen_pause_s": ("Pause 2: attach the pen (seconds)",
                    "Next the head lowers to the writing height (z draw) over the first letter and waits this "
                    "long. Slide the pen down through the holder until the tip just touches the paper, then "
                    "clamp it. Writing starts as soon as this pause ends."),
    "shift_pause_s": ("Pause 3: slide the paper (seconds)",
                      "Only for pages longer than the plate, like A4 on an A1. When everything that fits is "
                      "written, the pen stops just above the spot where the last written mark must end up. Slide "
                      "the paper toward the back of the printer until that mark is right under the pen tip. "
                      "Writing continues when the time is up. Happens once per extra pass."),
    "settle_ms": ("Pen settle time (milliseconds)",
                  "A tiny wait after every pen down and up so the ink starts and stops cleanly. Nothing for you "
                  "to do. Raise it if the start of strokes looks faint."),
    "home": ("Home first (true/false)", "Home all axes (G28) at the start, before the pen is attached."),
    "offset_x": ("Pen offset X (mm)", "Pen tip position minus nozzle position, left/right. BambuPlot calls "
                                      "this the tool offset."),
    "offset_y": ("Pen offset Y (mm)", "Same, front/back."),
    "z_draw": ("Writing height (mm)", "Nozzle height while the pen is down. The pen is clamped touching the "
                                      "paper at this height in pause 2, so any height that clears the holder works."),
    "z_lift": ("Pen-up height (mm)", "Nozzle height when moving between strokes. Keep it about 2 mm above the "
                                     "writing height: handwriting lifts the pen thousands of times."),
    "z_feed": ("Up/down speed (mm/min)", ""),
    "draw_feed": ("Writing speed (mm/min)", "1500 is about the speed of real handwriting."),
    "travel_feed": ("Travel speed (mm/min)", "Speed of pen-up moves."),
    "bed_x": ("Bed width (mm)", "Only used when the printer is Custom."),
    "bed_y": ("Bed depth (mm)", "Only used when the printer is Custom."),
    "bed_z": ("Max height (mm)", "How high the nozzle can go. Only used when the printer is Custom."),
    "width": ("Paper width (mm)", ""),
    "height": ("Paper height (mm)", ""),
    "line_spacing": ("Line spacing (mm)", "Baseline to baseline. Ruled paper is 7 to 8.7."),
    "word_spacing": ("Word spacing", "Gap between words, in letter heights."),
}
MAX_BORDER = 50


def set_values(text, values):
    """Set `key = value` lines per (section, key) in config text, keeping comments.
    A key missing from its section (older config files) is added under the section header."""
    lines = text.splitlines()
    for (section, key), val in values.items():
        start = lines.index(f"[{section}]")
        end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("[")), len(lines))
        for i in range(start + 1, end):
            m = CONFIG_LINE.match(lines[i])
            if m and m["key"] == key:
                lines[i] = lines[i][:m.start("val")] + val + lines[i][m.end("val"):]
                break
        else:
            lines.insert(start + 1, f"{key} = {val}")
    return "\n".join(lines) + "\n"


def read_config():
    return CONFIG.read_text(encoding="utf-8-sig")


class App:
    def __init__(self, root):
        self.root = root
        root.title("Handwrite")
        root.minsize(1000, 660)
        text = read_config()
        raw = tomllib.loads(text)
        missing = {k: f'"{v}"' if isinstance(v, str) else str(v)
                   for k, v in write.DEFAULTS.items() if k[1] not in raw[k[0]]}
        if missing:  # older config file: add the newer keys so Settings shows them
            CONFIG.write_text(set_values(text, missing), encoding="utf-8")
            raw = tomllib.loads(read_config())
        w, pr, p = raw["writing"], raw["printer"], raw["paper"]
        self.seed = secrets.randbelow(1_000_000)
        self.last = None  # (settings key, lines, cfg, skipped chars) of the last render
        self.cfg, self.lines = None, []  # what the plate view shows
        self.busy = False
        self.drag = None
        self.phone_url = None

        left = ttk.Frame(root, padding=12)
        left.pack(side="left", fill="y")
        ttk.Label(left, text="Text to write").pack(anchor="w")
        self.text = tk.Text(left, width=42, height=12, wrap="word", font=("Segoe UI", 11), undo=True)
        self.text.pack(fill="both", expand=True, pady=(2, 10))
        self.text.insert("1.0", "Dear friend,\n\nThis letter was written by my printer. Can you tell?\n")

        opts = ttk.Frame(left)
        opts.pack(fill="x")
        self.printer = ttk.Combobox(opts, state="readonly", width=26, values=list(write.PRINTERS))
        self.printer.set(pr.get("model", "Custom"))
        paper_row = ttk.Frame(opts)
        self.paper = ttk.Combobox(paper_row, state="readonly", width=12, values=list(write.PAPERS))
        self.paper.set(p.get("size", "Custom"))
        self.landscape = tk.BooleanVar(value=p.get("orientation") == "landscape")
        landscape = ttk.Checkbutton(paper_row, text="Landscape", variable=self.landscape, command=self.setup_changed)
        self.paper.pack(side="left")
        landscape.pack(side="left", padx=8)
        self.border = tk.StringVar(value=f"{p['margin']:g}")
        border = ttk.Spinbox(opts, from_=0, to=MAX_BORDER, increment=1, textvariable=self.border, width=6,
                             command=self.border_changed)
        border.bind("<Return>", self.border_changed)
        border.bind("<FocusOut>", self.border_changed)
        for box in (self.printer, self.paper):
            box.bind("<<ComboboxSelected>>", self.setup_changed)
        self.style = ttk.Combobox(opts, state="readonly", width=14, postcommand=self.refresh_styles)
        self.refresh_styles()
        self.style.set(str(w["style"]))
        self.bias = tk.DoubleVar(value=w["bias"])
        self.wobble = tk.DoubleVar(value=w.get("wobble", 1.0))
        self.size = tk.StringVar(value=str(w["x_height"]))
        for row, (label, widget) in enumerate([
            ("Printer", self.printer),
            ("Paper", paper_row),
            ("Border (mm)", border),
            ("Handwriting", self.style),
            ("Neatness", ttk.Scale(opts, from_=0, to=2, variable=self.bias, length=160)),
            ("Line wobble", ttk.Scale(opts, from_=0, to=2, variable=self.wobble, length=160)),
            ("Letter size (mm)", ttk.Spinbox(opts, from_=1.5, to=10, increment=0.2, textvariable=self.size, width=6)),
        ]):
            ttk.Label(opts, text=label).grid(row=row, column=0, sticky="w", pady=3)
            widget.grid(row=row, column=1, sticky="w", padx=8)

        self.controls = [self.printer, self.paper, landscape, border]  # disabled while writing
        for label, cmd in [("Preview", self.preview), ("Write it differently", self.reroll),
                           ("Save G-code…", self.save), (None, None),
                           ("Add my handwriting…", self.add_handwriting),
                           ("Printer & paper settings…", self.settings)]:
            if label is None:
                ttk.Separator(left).pack(fill="x", pady=8)
                continue
            b = ttk.Button(left, text=label, command=cmd)
            b.pack(fill="x", pady=2)
            self.controls.append(b)
        self.status = ttk.Label(left, text="", wraplength=320, foreground="#555")
        self.status.pack(fill="x", pady=(10, 0))

        self.canvas = tk.Canvas(root, background="#dcdcdc", highlightthickness=0)
        self.canvas.pack(side="right", fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda e: self.draw())
        self.canvas.bind("<Motion>", self.hover)
        self.canvas.bind("<ButtonPress-1>", self.drag_start)
        self.canvas.bind("<B1-Motion>", self.drag_move)
        self.canvas.bind("<ButtonRelease-1>", self.drag_end)
        self.canvas.bind("<MouseWheel>", lambda e: self.zoom_at(1.2 ** (e.delta / 120), e.x, e.y))
        for b in (2, 3):  # middle or right drag pans, even over the paper
            self.canvas.bind(f"<ButtonPress-{b}>", self.pan_start)
            self.canvas.bind(f"<B{b}-Motion>", self.pan_move)
        self.zoom, self.pan, self.panning = 1.0, [0.0, 0.0], None
        zoombar = ttk.Frame(self.canvas)
        zoombar.place(relx=1, x=-10, y=8, anchor="ne")
        for label, cmd in [("+", lambda: self.zoom_at(1.5)), ("−", lambda: self.zoom_at(1 / 1.5)),
                           ("Fit", self.zoom_fit)]:
            ttk.Button(zoombar, text=label, width=4, command=cmd).pack(side="left", padx=1)
        root.after(200, self.preview)

    def say(self, msg, error=False):
        self.status.config(text=msg, foreground="#b00020" if error else "#555")

    def refresh_styles(self):
        self.style["values"] = model.list_styles()

    def current(self):
        """(text, cfg, cache key) from the window. Raises ValueError (letter size) or WriteError."""
        cfg = write.load_config(read_config())
        size = float(self.size.get())
        if not 1 <= size <= 20:
            raise ValueError
        cfg["writing"].update(style=self.style.get(), bias=round(self.bias.get(), 2),
                              wobble=round(self.wobble.get(), 2), x_height=size)
        text = self.text.get("1.0", "end")
        # Moving the paper only needs new handwriting when it changes where the text may go.
        fixed = copy.deepcopy(cfg)
        del fixed["paper"]["x"], fixed["paper"]["y"]
        return text, cfg, (text, self.seed, repr(fixed), write.writing_area(cfg))

    def run(self, then):
        """Render in the background (a page takes a few seconds), then call then(strokes, cfg)."""
        if self.busy:
            return
        try:
            text, cfg, key = self.current()
        except ValueError:
            return self.say("Letter size must be a number between 1 and 20 mm.", error=True)
        except (write.WriteError, tomllib.TOMLDecodeError) as e:
            return self.say(f"Settings problem: {e}", error=True)
        self.cfg = cfg
        if self.last and self.last[0] == key:
            self.last = (key, self.last[1], cfg, self.last[3])
            self.lines = self.last[1]
            self.draw()
            if self.show_status(self.last[3]):
                then(self.lines, cfg)
            return
        self.lines = []
        self.draw()
        self.busy = True
        for b in self.controls:
            b.state(["disabled"])
        self.say("Writing…")
        result = {}

        def work():
            try:
                result["ok"] = write.render(text, cfg, self.seed)
            except write.WriteError as e:
                result["err"] = str(e)
            except Exception as e:  # keep the window alive; show what broke
                result["err"] = f"Something went wrong: {e!r}"

        worker = threading.Thread(target=work, daemon=True)
        worker.start()

        def poll():
            if worker.is_alive():
                return self.root.after(100, poll)
            self.busy = False
            for b in self.controls:
                b.state(["!disabled"])
            if "err" in result:
                return self.say(result["err"], error=True)
            lines, dropped = result["ok"]
            self.last = (key, lines, cfg, dropped)
            self.lines = lines
            self.draw()
            if self.show_status(dropped):
                then(lines, cfg)

        poll()

    def show_status(self, dropped):
        """Status line: skipped characters and what to do between passes. False if the page can't be written."""
        try:
            passes = write.plan_passes(self.lines, self.cfg)
        except write.WriteError as e:
            self.say(str(e), error=True)
            return False
        msgs = ["Skipped characters it can't write: " + " ".join(sorted(dropped))] if dropped else []
        if len(passes) > 1:
            msgs.append(write.pass_note(passes))
        self.say("\n\n".join(msgs))
        return True

    def preview(self):
        self.run(lambda strokes, cfg: None)

    def reroll(self):
        self.seed = secrets.randbelow(1_000_000)
        self.preview()

    def setup_changed(self, event=None):
        """New printer, paper or orientation: save it and centre the paper on the plate."""
        new = set_values(read_config(), {
            ("printer", "model"): f'"{self.printer.get()}"',
            ("paper", "size"): f'"{self.paper.get()}"',
            ("paper", "orientation"): '"landscape"' if self.landscape.get() else '"portrait"',
        })
        cfg = write.load_config(new)
        pr, p = cfg["printer"], cfg["paper"]
        CONFIG.write_text(set_values(new, {("paper", "x"): str(round((pr["bed_x"] - p["width"]) / 2)),
                                           ("paper", "y"): str(round((pr["bed_y"] - p["height"]) / 2))}),
                          encoding="utf-8")
        self.zoom, self.pan = 1.0, [0.0, 0.0]  # new plate size: start from the whole plate
        self.preview()

    def border_changed(self, event=None):
        """Blank border around the paper's edge: save it and redraw."""
        if self.busy:  # a page is being written; apply the new border right after
            return self.root.after(300, self.border_changed)
        try:
            border = float(self.border.get())
            if not 0 <= border <= MAX_BORDER:
                raise ValueError
        except ValueError:
            return self.say(f"Border must be a number from 0 to {MAX_BORDER} mm.", error=True)
        text = read_config()
        if tomllib.loads(text)["paper"]["margin"] != border:
            CONFIG.write_text(set_values(text, {("paper", "margin"): f"{border:g}"}), encoding="utf-8")
        self.preview()  # also replaces an earlier "Border must be…" message (instant when nothing changed)

    # ---- build-plate view: bed in mm, front edge at the bottom of the screen ----

    def to_screen(self, X, Y):
        s, ox, oy = self.xf
        return ox + X * s, oy + (self.cfg["printer"]["bed_y"] - Y) * s

    def page_rect(self, l, t, r, b):
        """Page rectangle (mm, y down from the paper's back edge) -> screen rectangle."""
        p = self.cfg["paper"]
        top = p["y"] + p["height"]
        return (*self.to_screen(p["x"] + l, top - t), *self.to_screen(p["x"] + r, top - b))

    def draw(self):
        c = self.canvas
        c.delete("all")
        if not self.cfg:
            return
        pr, p = self.cfg["printer"], self.cfg["paper"]
        bx, by = pr["bed_x"], pr["bed_y"]
        W, H = c.winfo_width(), c.winfo_height()
        # Fit with padding so paper hanging over the edge stays visible, then apply zoom and pan.
        s = min(W / (bx * 1.4), H / (by * 1.4)) * self.zoom
        lim_x, lim_y = W / 2 + bx * s / 2 - 50, H / 2 + by * s / 2 - 50  # keep some plate in view
        self.pan = [min(max(self.pan[0], -lim_x), lim_x), min(max(self.pan[1], -lim_y), lim_y)]
        self.xf = (s, (W - bx * s) / 2 + self.pan[0], (H - by * s) / 2 + self.pan[1])

        x0, y0, x1, y1 = (*self.to_screen(0, by), *self.to_screen(bx, 0))
        c.create_rectangle(x0, y0, x1, y1, fill="#3c3c3c", outline="")
        for g in range(10, int(max(bx, by)), 10):
            if g % 50 and s * 10 < 12:
                continue  # 10 mm lines only once zoomed in far enough to tell them apart
            color = "#555555" if g % 50 == 0 else "#464646"
            if g < bx:
                c.create_line(*self.to_screen(g, 0), *self.to_screen(g, by), fill=color)
            if g < by:
                c.create_line(*self.to_screen(0, g), *self.to_screen(bx, g), fill=color)
        c.create_rectangle(*self.page_rect(0, 0, p["width"], p["height"]), fill="white", outline="#999")
        l, t, r, b = write.writing_area(self.cfg)
        if r > l and b > t:
            c.create_rectangle(*self.page_rect(l, t, r, b), outline="#9db4cf", dash=(4, 3))
        width = max(1.0, 0.5 * s)  # 0.5 mm pen
        ox, oy = self.page_rect(0, 0, 0, 0)[:2]
        for st in (s_ for line in self.lines for s_ in line):
            pts = st * s + [ox, oy]
            if len(pts) == 1:
                x, y = pts[0]
                c.create_oval(x - width / 2, y - width / 2, x + width / 2, y + width / 2, fill=INK, outline=INK)
            else:
                c.create_line(*pts.ravel().tolist(), fill=INK, width=width, capstyle="round", joinstyle="round")
        try:
            passes = write.plan_passes(self.lines, self.cfg) if self.lines else []
        except write.WriteError:
            passes = []  # status line explains; happens while dragging the paper somewhere unwritable
        for k in range(1, len(passes)):  # where the paper gets slid between passes
            y = (max(st[:, 1].max() for st in passes[k - 1][1]) + min(st[:, 1].min() for st in passes[k][1])) / 2
            lx, ly, rx, _ = self.page_rect(0, y, p["width"], y)
            c.create_line(lx, ly, rx, ly, fill="#c0392b", dash=(5, 3))
            label = c.create_text(rx - 4, ly - 3, anchor="se", fill="#c0392b",
                                  text=f"pass {k + 1}: slide paper {passes[k][0] - passes[k - 1][0]} mm back")
            c.tag_raise(label, c.create_rectangle(c.bbox(label), fill="white", outline="#c0392b"))
        c.create_rectangle(x0, y0, x1, y1, outline="#e08a00", width=2, dash=(6, 4))  # plate edge over the paper
        for label in (c.create_text(10, 10, anchor="nw", fill="#444",
                                    text=f"{pr['model']}: build plate {bx:g} × {by:g} mm (orange), grid 50 mm"
                                         f"{' / 10 mm' if s * 10 >= 12 else ''}. Drag the paper to move it.\n"
                                         "Scroll to zoom; drag the background (or right-drag anywhere) to pan."),
                      c.create_text(W / 2, H - 10, anchor="s", text="FRONT OF PRINTER", fill="#444")):
            x0, y0, x1, y1 = c.bbox(label)  # backdrop: readable when zoomed in over the paper
            c.tag_raise(label, c.create_rectangle(x0 - 4, y0 - 2, x1 + 4, y1 + 2, fill="#dcdcdc", outline=""))

    def on_paper(self, e):
        if not self.cfg or self.busy:
            return False
        x0, y0, x1, y1 = self.page_rect(0, 0, self.cfg["paper"]["width"], self.cfg["paper"]["height"])
        return x0 <= e.x <= x1 and y0 <= e.y <= y1

    def hover(self, e):
        self.canvas.config(cursor="fleur" if self.drag or self.on_paper(e) else "")

    def zoom_at(self, factor, x=None, y=None):
        """Zoom by `factor`, keeping the plate point under (x, y) (default: view centre) where it is."""
        if not self.cfg:
            return
        c = self.canvas
        W, H = c.winfo_width(), c.winfo_height()
        x, y = (W / 2 if x is None else x), (H / 2 if y is None else y)
        new = min(max(self.zoom * factor, 1.0), 12.0)
        f = new / self.zoom
        s, ox, oy = self.xf
        bx, by = self.cfg["printer"]["bed_x"], self.cfg["printer"]["bed_y"]
        self.zoom = new
        self.pan = [x - (x - ox) * f - (W - bx * s * f) / 2, y - (y - oy) * f - (H - by * s * f) / 2]
        self.draw()

    def zoom_fit(self):
        self.zoom, self.pan = 1.0, [0.0, 0.0]
        self.draw()

    def pan_start(self, e):
        self.panning = (e.x, e.y, *self.pan)
        self.canvas.config(cursor="fleur")

    def pan_move(self, e):
        if self.panning:
            sx, sy, px, py = self.panning
            self.pan = [px + e.x - sx, py + e.y - sy]
            self.draw()

    def drag_start(self, e):
        p = self.cfg["paper"] if self.cfg else None
        self.drag = (e.x, e.y, p["x"], p["y"]) if self.on_paper(e) else None
        if not self.drag:
            self.pan_start(e)  # left-drag on the background pans

    def drag_move(self, e):
        if not self.drag:
            return self.pan_move(e)
        sx, sy, px, py = self.drag
        s = self.xf[0]
        pr, p = self.cfg["printer"], self.cfg["paper"]
        # keep at least 20 mm of paper over the plate so it can't be dragged out of sight
        p["x"] = round(min(max(px + (e.x - sx) / s, 20 - p["width"]), pr["bed_x"] - 20))
        p["y"] = round(min(max(py - (e.y - sy) / s, 20 - p["height"]), pr["bed_y"] - 20))
        self.draw()

    def drag_end(self, e):
        self.panning = None
        if not self.drag:
            return
        self.drag = None
        p = self.cfg["paper"]
        CONFIG.write_text(set_values(read_config(), {("paper", "x"): str(p["x"]), ("paper", "y"): str(p["y"])}),
                          encoding="utf-8")
        self.preview()

    def save(self):
        def ask(lines, cfg):
            try:
                passes = write.plan_passes(lines, cfg)  # re-checks every point: the paper may have moved
            except write.WriteError as e:
                return self.say(str(e), error=True)
            path = filedialog.asksaveasfilename(parent=self.root, defaultextension=".gcode", initialfile="handwriting.gcode",
                                                filetypes=[("G-code", "*.gcode"), ("All files", "*.*")])
            if path:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(write.to_gcode(passes, cfg, write.describe(cfg, self.seed)))
                msg = (f"Saved {path}. Only run it on the {cfg['printer']['model']}. After homing, the head stops "
                       "over the first letter: place the paper there. Then it lowers: slide the pen down onto the "
                       "paper and clamp it.")
                self.say(msg + ("\n\n" + write.pass_note(passes) if len(passes) > 1 else ""))
        self.run(ask)

    def add_handwriting(self):
        if not self.phone_url:
            try:
                self.phone_url = capture_server.start()
            except OSError:  # port busy: the capture server is already running elsewhere
                self.phone_url = f"http://{capture_server.lan_ip()}:{capture_server.PORT}"
        webbrowser.open(f"http://localhost:{capture_server.PORT}")
        messagebox.showinfo("Add my handwriting", (
            "The writing page opened in your browser. You can write there with a pen or touchscreen, "
            f"or on your phone (same Wi-Fi) open:\n\n{self.phone_url}\n\n"
            "Each sentence you save appears in the Handwriting list as mine-1, mine-2, …\n"
            "If Windows asks about the firewall, allow private networks."), parent=self.root)

    def settings(self):
        text = read_config()
        win = tk.Toplevel(self.root)
        win.title("Printer & paper settings")
        win.transient(self.root)
        win.grab_set()
        frm = ttk.Frame(win, padding=14)
        frm.pack(fill="both", expand=True)
        ttk.Label(frm, text="Copy the pen offset that already works for you in BambuPlot. "
                            "The printer pauses below are timed: it carries on by itself when the time is up.",
                  foreground="#555", wraplength=640).grid(row=0, column=0, columnspan=3, sticky="w")
        entries, row, section = {}, 1, None
        for line in text.splitlines():
            if m := re.match(r"\[(\w+)\]", line):
                section = m[1]
                ttk.Label(frm, text=SECTIONS.get(section, section.title()), font=("Segoe UI", 10, "bold")).grid(
                    row=row, column=0, sticky="w", pady=(12, 2))
                row += 1
            elif (m := CONFIG_LINE.match(line)) and m["key"] not in MAIN_KEYS:
                label, note = HELP.get(m["key"], (m["key"].replace("_", " "), m["note"] or ""))
                ttk.Label(frm, text=label).grid(row=row, column=0, sticky="nw", pady=2)
                e = ttk.Entry(frm, width=8)
                e.insert(0, m["val"].strip('"'))
                e.grid(row=row, column=1, sticky="nw", padx=8, pady=2)
                ttk.Label(frm, text=note, foreground="#666", wraplength=440, justify="left").grid(
                    row=row, column=2, sticky="nw", pady=2)
                entries[(section, m["key"])] = (e, m["val"].startswith('"'))
                row += 1

        def save():
            vals = {k: f'"{e.get().strip()}"' if quoted else e.get().strip() for k, (e, quoted) in entries.items()}
            new = set_values(text, vals)
            try:
                write.load_config(new)
            except (tomllib.TOMLDecodeError, write.WriteError) as err:
                return messagebox.showerror("Settings", f"That value isn't valid:\n{err}", parent=win)
            CONFIG.write_text(new, encoding="utf-8")
            win.destroy()
            self.preview()

        bar = ttk.Frame(frm)
        bar.grid(row=row, column=0, columnspan=3, sticky="e", pady=(12, 0))
        ttk.Button(bar, text="Cancel", command=win.destroy).pack(side="right")
        ttk.Button(bar, text="Save", command=save).pack(side="right", padx=6)


def main():
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on high-DPI screens
    except (AttributeError, OSError):
        pass
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
