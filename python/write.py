"""Text -> handwritten G-code for a Bambu Lab printer with a pen holder, plus an SVG preview.

    python write.py note.txt -o note.gcode
    python write.py --text "Hello there" --style mine-1 --bias 0.5 -o hello.gcode
"""
import argparse
import copy
import secrets
import sys
import tomllib
from pathlib import Path

import numpy as np

import model


class WriteError(Exception):
    """A problem the user can fix: too much text, paper off the bed, ..."""


# (bed_x, bed_y, max Z, nozzle keep-out (x0, y0, x1, y1) or None), mm. Unlisted printers: Custom + settings.
# P1/X1: in the front-left corner the toolhead presses the filament-cutter lever against the frame.
CUTTER = (0, 0, 18, 28)
PRINTERS = {
    "Bambu Lab A1": (256, 256, 256, None),
    "Bambu Lab A1 mini": (180, 180, 180, None),
    "Bambu Lab P1P / P1S": (256, 256, 250, CUTTER),
    "Bambu Lab P2S": (256, 256, 256, None),
    "Bambu Lab X1 Carbon / X1E": (256, 256, 250, CUTTER),
    "Custom": None,
}
PAPERS = {"A4": (210, 297), "A5": (148, 210), "A6": (105, 148), "US Letter": (215.9, 279.4),
          "Card 4x6 in": (101.6, 152.4), "Custom": None}
BED_INSET = 3  # mm; text stays this far inside the plate edges
MAX_WORD = 25  # letters; keeps every word well inside the model's 1200-step limit, so none gets cut off
CLEARANCE = 15  # mm above z_draw while placing the paper
# Keys older config files lack, with safe values. Custom keeps an old file's own bed and paper size.
DEFAULTS = {("printer", "model"): "Custom", ("paper", "size"): "Custom", ("paper", "orientation"): "portrait",
            ("printer", "paper_pause_s"): 30, ("printer", "pen_pause_s"): 30, ("printer", "shift_pause_s"): 45,
            ("writing", "wobble"): 1.0, ("printer", "bed_z"): 150}
# Every number that reaches the G-code: (min, max). Values must be real, finite numbers (not true/false/text).
LIMITS = {
    ("printer", "bed_x"): (50, 400), ("printer", "bed_y"): (50, 400), ("printer", "bed_z"): (50, 400),
    ("printer", "offset_x"): (-100, 100), ("printer", "offset_y"): (-100, 100),
    ("printer", "z_draw"): (2, 200), ("printer", "z_lift"): (3, 200),
    ("printer", "z_feed"): (60, 1200), ("printer", "draw_feed"): (60, 12000),
    ("printer", "travel_feed"): (600, 12000),
    ("printer", "paper_pause_s"): (5, 600), ("printer", "pen_pause_s"): (5, 600),
    ("printer", "shift_pause_s"): (5, 600), ("printer", "settle_ms"): (0, 2000),
    ("paper", "x"): (-600, 600), ("paper", "y"): (-600, 600),
    ("paper", "width"): (30, 600), ("paper", "height"): (30, 600), ("paper", "margin"): (0, 50),
    ("writing", "bias"): (0, 2), ("writing", "wobble"): (0, 2), ("writing", "x_height"): (1, 20),
    ("writing", "line_spacing"): (1, 100), ("writing", "word_spacing"): (0.2, 5),
}
MIN_PEN_LIFT = 1.0  # mm between writing height and pen-up height
SLIDE_HOVER = 5  # mm above z_draw while the user slides the paper under the pen


def validate(cfg):
    """Refuse any setting that could put an unsafe or garbled command into the G-code (raises WriteError)."""
    for (section, key), (lo, hi) in LIMITS.items():
        v = cfg[section][key]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) or not lo <= v <= hi:
            raise WriteError(f"Setting {key.replace('_', ' ')} = {v!r} must be a number from {lo} to {hi}.")
    pr, w = cfg["printer"], cfg["writing"]
    if cfg["paper"]["orientation"] not in ("portrait", "landscape") or not isinstance(w["style"], str):
        raise WriteError("Paper orientation must be portrait or landscape, and style a name.")
    if round(pr["z_lift"], 2) - round(pr["z_draw"], 2) < MIN_PEN_LIFT:
        raise WriteError(f"Pen-up height must be at least {MIN_PEN_LIFT:g} mm above the writing height.")
    if max(pr["z_draw"] + CLEARANCE, pr["z_lift"] + 10) > pr["bed_z"]:
        raise WriteError(f"Writing height is too high for this printer (max Z {pr['bed_z']:g} mm).")
    if w["line_spacing"] < 1.5 * w["x_height"]:
        raise WriteError("Line spacing is too small for the letter size: lines would write over each other.")


def load_config(text):
    """Parse config.toml and fill in bed and paper sizes from the chosen printer and paper."""
    try:
        cfg = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise WriteError(f"The settings file is damaged: {e}") from e
    for (section, key), val in DEFAULTS.items():
        cfg[section].setdefault(key, val)
    pr, p = cfg["printer"], cfg["paper"]
    if pr["model"] not in PRINTERS or p["size"] not in PAPERS:
        raise WriteError(f"Unknown printer {pr['model']!r} or paper {p['size']!r}")
    pr["keepout"] = None
    if PRINTERS[pr["model"]]:
        pr["bed_x"], pr["bed_y"], pr["bed_z"], pr["keepout"] = PRINTERS[pr["model"]]
    if PAPERS[p["size"]]:
        p["width"], p["height"] = PAPERS[p["size"]]
    short, long_ = sorted((p["width"], p["height"]))
    p["width"], p["height"] = (long_, short) if p["orientation"] == "landscape" else (short, long_)
    validate(cfg)
    return cfg


def reach(cfg, inset=0.0):
    """Page rectangle (left, top, right, bottom; mm) where the pen tip is over the plate
    and the nozzle is inside its travel limits. pen = nozzle + offset."""
    pr, p = cfg["printer"], cfg["paper"]
    x0 = max(0, pr["offset_x"]) + inset
    x1 = min(pr["bed_x"], pr["bed_x"] + pr["offset_x"]) - inset
    y0 = max(0, pr["offset_y"]) + inset
    y1 = min(pr["bed_y"], pr["bed_y"] + pr["offset_y"]) - inset
    top = p["y"] + p["height"]  # paper's back edge in bed Y
    return x0 - p["x"], top - y1, x1 - p["x"], top - y0


def writing_area(cfg):
    """Where text goes: inside the paper margins, across the part the pen reaches, from the plate's back
    edge down to the bottom margin. Lines below the plate's front edge go in later passes (plan_passes)."""
    p, m = cfg["paper"], cfg["paper"]["margin"]
    l, t, r, _ = reach(cfg, BED_INSET)
    return max(l, m), max(t, m), min(r, p["width"] - m), p["height"] - m


def shifted(cfg, shift):
    """cfg with the paper slid `shift` mm toward the back of the printer."""
    c = copy.deepcopy(cfg)
    c["paper"]["y"] += shift
    return c


def plan_passes(lines, cfg):
    """Split lines (each a list of page strokes) into passes for paper longer than the plate.
    Pass k is written with the paper slid shift_k mm toward the back. Before it, the pen hovers over
    where the last mark of the previous pass lands after the slide, so the user can line the paper up.
    Returns [(shift_mm, strokes, hover point or None)]; raises WriteError if any point is out of reach."""
    _, t0, _, b0 = reach(cfg, BED_INSET)
    xh = cfg["writing"]["x_height"]
    last_bottom = max(s[:, 1].max() for line in lines for s in line)
    passes = [(0, [], None)]
    for line in lines:
        pts = np.vstack(line)
        top, bottom = pts[:, 1].min(), pts[:, 1].max()
        shift = passes[-1][0]
        if bottom > b0 + shift:
            prev = passes[-1][1]
            if not prev:
                raise WriteError("The writing starts below the front edge of the plate, or a line is taller than "
                                 "the plate: drag the paper toward the back or use smaller letters.")
            hover = prev[-1][-1]  # last mark written
            # Slide only as far as the rest of the page needs (less paper hanging off the back),
            # but never so far that this line or the hover mark leaves the reachable area.
            shift = min(int(np.ceil(last_bottom - b0)), int(np.floor(min(hover[1] - xh, top) - t0)))
            if shift <= passes[-1][0] or bottom > b0 + shift:
                raise WriteError("The paper can't be split into passes here: use smaller letters or drag the "
                                 "paper so more of it is over the plate.")
            passes.append((shift, [], hover))
        passes[-1][1].extend(line)
    for shift, strokes, hover in passes:
        check_bounds(strokes + ([hover[None]] if hover is not None else []), shifted(cfg, shift))
    return passes


def render(text, cfg, seed):
    """Text -> (lines of page strokes in mm, set of skipped characters). Raises WriteError."""
    w, pr = cfg["writing"], cfg["printer"]
    style = str(w["style"])
    if style not in model.list_styles():
        raise WriteError(f"Unknown style {style!r}. Available: {', '.join(model.list_styles())}")
    validate(cfg)  # again: the app and command line override some values after load_config
    text, dropped = model.clean_text(text)
    lines = layout(text, model.Hand(model.Model(), style), cfg, np.random.default_rng(seed), w["bias"])
    if not lines:
        raise WriteError("Nothing to write.")
    plan_passes(lines, cfg)
    return lines, dropped


def layout(text, hand, cfg, rng, bias):
    """Place words on the page. Returns lines, each a list of strokes as [N,2] arrays in page mm
    (origin top-left, y down)."""
    w = cfg["writing"]
    xh, ls = w["x_height"], w["line_spacing"]
    area_left, top, right, bottom = writing_area(cfg)
    if right - area_left < 8 * xh or min(bottom, reach(cfg, BED_INSET)[3]) - top < 4 * xh:
        raise WriteError("Too little of the paper is on the build plate: drag the paper onto the plate.")
    # How a person writes on blank paper: the whole page leans a little, the left margin creeps
    # sideways down the page, each line starts, slopes, bows and ends a little differently, the gaps
    # between lines vary and the writing grows or shrinks a bit. All scaled by `wobble` (0 = none).
    k = w["wobble"]
    page_tilt = rng.normal(0, 0.008) * k                  # radians
    margin_creep = rng.normal(0, 0.008) * k               # mm sideways per mm down the page, either way
    room = 1.0 * xh * k  # line starts stray up to this far either side of the writer's usual margin
    walk, scale = 0.0, 1.0
    lines = []
    y = top + 2 * xh  # first baseline, leaving room for capitals and ascenders
    for para in text.split("\n"):
        words = para.split()
        while True:
            # Mean-reverting wander: lines drift left and right of the margin and get pulled back.
            walk = 0.7 * walk + rng.normal(0, 0.3 * xh) * k
            stray = np.clip(margin_creep * (y - top) + walk + rng.normal(0, 0.15 * xh) * k, -room, room)
            left = area_left + room + stray
            line_right = right - abs(rng.normal(0, 1.2 * xh)) * k  # sometimes a word goes to the next line early
            tilt = float(np.clip(page_tilt + rng.normal(0, 0.006) * k, -0.025, 0.025))
            bow = rng.normal(0, 0.12 * xh) * k                  # mm the line sags (+) or arches (-) mid-way
            scale = float(np.clip(scale + rng.normal(0, 0.02) * k, 0.92, 1.08))
            lxh, span = xh * scale, max(line_right - left, 1.0)
            if y + 1.3 * lxh + abs(tilt) * span + abs(bow) > bottom and words:  # + descenders and slope
                raise WriteError("Text doesn't fit on the page: use smaller letters or less text.")

            def baseline(px):
                u = np.clip((px - left) / span, 0, 1)
                return y + tilt * (px - left) + bow * 4 * u * (1 - u)

            x, drift, strokes = left, 0.0, []
            while words:
                if len(words[0]) > MAX_WORD:
                    raise WriteError(f'The word "{words[0][:20]}..." is too long ({MAX_WORD} letters at most).')
                ink = hand.word(words[0], rng, bias)
                width = max((s[:, 0].max() for s in ink), default=0) * lxh
                if width > line_right - left:
                    raise WriteError(f'The word "{words[0]}" is wider than a line: use smaller letters.')
                if x + width > line_right and x > left:
                    break  # wrap; the word is regenerated on the next line
                words.pop(0)
                drift = np.clip(drift + rng.normal(0, 0.04) * k, -0.25, 0.25)
                for s in ink:
                    px = x + s[:, 0] * lxh
                    strokes.append(np.column_stack([px, baseline(px) + drift * xh - s[:, 1] * lxh]))
                x += width + max(0.4, w["word_spacing"] * (1 + rng.normal(0, 0.15) * k)) * lxh
            if strokes and max(s[:, 1].max() for s in strokes) > bottom:
                raise WriteError("Text doesn't fit on the page: use smaller letters or less text.")
            if strokes:
                rise = top - min(s[:, 1].min() for s in strokes)
                if rise > 0:  # a line sloping up must not climb out of the writing area
                    strokes = [s + [0, rise] for s in strokes]
                    y += rise
                lines.append(strokes)
            y += ls * float(np.clip(1 + rng.normal(0, 0.06) * k, 0.85, 1.2))
            if not words:
                break
    return lines


def check_bounds(strokes, cfg):
    """Last guard before G-code: every pen-down point is on the paper and inside this printer's bed."""
    p = cfg["paper"]
    l, t, r, b = reach(cfg)
    l, t, r, b = max(l, 0), max(t, 0), min(r, p["width"]), min(b, p["height"])
    pts = np.vstack(strokes)
    xs, ys = pts[:, 0], pts[:, 1]
    # Written so NaN/inf anywhere fails the check instead of slipping past it.
    if not (np.isfinite(pts).all() and l <= xs.min() and xs.max() <= r and t <= ys.min() and ys.max() <= b):
        raise WriteError("Some writing would land off the paper or outside this printer's bed. "
                         "Check the printer, paper position and pen offset.")


def to_gcode(passes, cfg, header):
    """BambuPlot-style G-code (plain .gcode, known to run on the A1), with pauses: place the paper,
    attach the pen, and slide the paper between passes. Only G4 pauses, which BambuPlot has proven."""
    p, pr = cfg["paper"], cfg["printer"]
    feed = round(pr["z_feed"])  # pauses and feeds as whole numbers

    ko = pr["keepout"]

    def xy(pt, shift):  # page mm (y down from top edge) -> nozzle position on the bed (Y up from front)
        x = p["x"] + pt[0] - pr["offset_x"]
        y = p["y"] + shift + p["height"] - pt[1] - pr["offset_y"]
        # Final guard on the exact numbers written: inside the bed, outside any keep-out (NaN fails too).
        if not (0 <= x <= pr["bed_x"] and 0 <= y <= pr["bed_y"]) or (ko and ko[0] <= x <= ko[2] and ko[1] <= y <= ko[3]):
            raise WriteError(f"Refusing a move to X{x:.2f} Y{y:.2f}: outside this printer's safe area. "
                             "Move the paper or check the pen offset.")
        return f"X{x:.2f} Y{y:.2f}"

    up = f"G1 Z{pr['z_lift']:.2f} F{feed}"
    down = f"G1 Z{pr['z_draw']:.2f} F{feed}"
    settle = [f"G4 P{round(pr['settle_ms'])}"] if pr["settle_ms"] >= 1 else []
    out = [f"; {line}" for line in header]
    out.append("; BEFORE STARTING: take the pen out of the holder. Homing touches the nozzle to the plate.")
    out += ["G90", "G21", "G28"]  # always home: every move after this assumes a known position
    out += [f"G1 Z{pr['z_draw'] + CLEARANCE:.2f} F{feed}",
            f"G0 {xy(passes[0][1][0][0], 0)} F{round(pr['travel_feed'])}",
            "; place the paper: the first letter goes right under the pen holder",
            f"G4 S{round(pr['paper_pause_s'])}",
            down,
            "; attach the pen: slide it down until it touches the paper, then clamp it",
            f"G4 S{round(pr['pen_pause_s'])}",
            up]
    for k, (shift, strokes, hover) in enumerate(passes):
        out.append(f"; PASS {k + 1} of {len(passes)}: paper slid {shift} mm toward the back")
        if hover is not None:
            out += [f"G1 Z{max(pr['z_lift'], pr['z_draw'] + SLIDE_HOVER):.2f} F{feed}",  # clear of wet ink while paper is handled
                    f"G0 {xy(hover, shift)} F{round(pr['travel_feed'])}",
                    f"; slide the paper {shift - passes[k - 1][0]} mm toward the back until the last mark "
                    "written is right under the pen",
                    f"G4 S{round(pr['shift_pause_s'])}", up]
        for s in strokes:
            out.append(f"G0 {xy(s[0], shift)} F{round(pr['travel_feed'])}")
            out += [down, *settle]
            out += [f"G1 {xy(pt, shift)} F{round(pr['draw_feed'])}" if i == 0 else f"G1 {xy(pt, shift)}"
                    for i, pt in enumerate(s[1:])]
            out += [up, *settle]
    out.append(f"G1 Z{pr['z_lift'] + 10:.2f} F{feed}")
    return "\n".join(out) + "\n"


def pass_note(passes):
    """What to do between passes, for the user."""
    moves = ", then ".join(f"{b[0] - a[0]} mm" for a, b in zip(passes, passes[1:]))
    return (f"{len(passes)} passes. Each time the pen stops over the writing, slide the paper toward the back "
            f"of the printer ({moves}) until the last mark written is right under the pen tip.")


def describe(cfg, seed):
    """G-code header lines."""
    w, pr, p = cfg["writing"], cfg["printer"], cfg["paper"]
    return [f"handwrite: style={w['style']} bias={w['bias']} wobble={w['wobble']} x_height={w['x_height']} seed={seed}",
            f"ONLY for {pr['model']} (bed {pr['bed_x']} x {pr['bed_y']} mm), pen offset {pr['offset_x']},{pr['offset_y']}",
            f"paper {p['size']} {p['orientation']}, front-left corner at X{p['x']} Y{p['y']}"]


def to_svg(strokes, cfg):
    W, H = cfg["paper"]["width"], cfg["paper"]["height"]
    d = " ".join("M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in (s if len(s) > 1 else [s[0], s[0] + [0.01, 0]]))
                 for s in strokes)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}mm" height="{H}mm" viewBox="0 0 {W} {H}">'
            f'<rect width="{W}" height="{H}" fill="#fff" stroke="#bbb" stroke-width="0.3"/>'
            f'<path d="{d}" fill="none" stroke="#1b2a6b" stroke-width="0.5" '
            f'stroke-linecap="round" stroke-linejoin="round"/></svg>\n')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="text file to write")
    ap.add_argument("--text", help="text to write (instead of a file)")
    ap.add_argument("-o", "--out", default="out.gcode")
    ap.add_argument("--config", default=str(model.HERE / "config.toml"))
    ap.add_argument("--style", help=f"one of: {', '.join(model.list_styles())}")
    ap.add_argument("--bias", type=float, help="neatness: 0 = messy, 1 = normal, 2 = very neat")
    ap.add_argument("--wobble", type=float, help="line wobble: 0 = perfectly aligned lines, 1 = natural, 2 = messy")
    ap.add_argument("--x-height", type=float, help="height of small letters in mm")
    ap.add_argument("--seed", type=int, help="same seed + same settings = same handwriting")
    a = ap.parse_args(argv)

    if (a.file is None) == (a.text is None):
        ap.error("give either a text file or --text")
    text = a.text if a.text is not None else Path(a.file).read_text(encoding="utf-8-sig")
    seed = a.seed if a.seed is not None else secrets.randbelow(1_000_000)
    try:
        cfg = load_config(Path(a.config).read_text(encoding="utf-8-sig"))
        for key, val in (("style", a.style), ("bias", a.bias), ("wobble", a.wobble), ("x_height", a.x_height)):
            if val is not None:
                cfg["writing"][key] = val
        lines, dropped = render(text, cfg, seed)
        passes = plan_passes(lines, cfg)
    except WriteError as e:
        sys.exit(str(e))
    if dropped:
        print(f"Skipped characters the model can't write: {' '.join(sorted(dropped))}")
    if len(passes) > 1:
        print(pass_note(passes))

    strokes = [s for line in lines for s in line]
    out = Path(a.out)
    out.write_text(to_gcode(passes, cfg, describe(cfg, seed)), encoding="utf-8")
    out.with_suffix(".svg").write_text(to_svg(strokes, cfg), encoding="utf-8")
    draw_mm = sum(np.linalg.norm(np.diff(s, axis=0), axis=1).sum() for s in strokes)
    print(f"Wrote {out} and {out.with_suffix('.svg')}  ({len(strokes)} strokes, {draw_mm / 1000:.1f} m of ink, seed {seed})")


if __name__ == "__main__":
    main()
