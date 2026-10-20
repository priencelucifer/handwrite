"""Quick end-to-end check: python selfcheck.py"""
import re
import shutil
import tempfile
import tomllib
from pathlib import Path

import numpy as np

import capture_server
import model
import write

tmp = Path(tempfile.mkdtemp())
real_styles = model.STYLES
model.STYLES = tmp  # keep test styles out of styles/
shutil.copy(real_styles / "9-strokes.npy", tmp)
shutil.copy(real_styles / "9-chars.npy", tmp)

# 1. A capture (preset 9 replayed as dense screen-space pointer points) becomes a usable style.
offs = np.load(real_styles / "9-strokes.npy")
text = np.load(real_styles / "9-chars.npy").tobytes().decode()
xy = np.cumsum(offs[:, :2], 0) * [4, -4]  # model y-up units -> screen px, y down
ends = np.where(offs[:, 2] == 1)[0] + 1
strokes = [np.repeat(s, 3, axis=0).tolist() for s in np.split(xy, ends) if len(s)]
assert capture_server.save_capture({"name": "selftest", "text": text, "strokes": strokes}) == "selftest"
primer = np.load(tmp / "selftest-strokes.npy")
assert len(primer) <= model.MAX_STROKE_LEN
assert abs(np.median(np.linalg.norm(primer[1:, :2], axis=1)) - 1) < 0.1
ink = model.Hand(model.Model(), "selftest").word("hello", np.random.default_rng(0))
assert ink and np.vstack(ink)[:, 0].max() > 1.5, "captured style should write a full word"
for bad in ({"name": "../x", "text": text, "strokes": strokes}, {"name": "ok", "text": "@@@", "strokes": strokes}):
    try:
        capture_server.save_capture(bad)
        raise AssertionError("bad capture accepted")
    except ValueError:
        pass

# 2. G-code: travel only with the pen up; every pen-down point is on the bed and on the paper
#    where the paper is during that pass; pauses come in the expected order.
import app  # noqa: E402

src = (model.HERE / "config.toml").read_text()


def check_gcode(gcode, cfg):
    """Returns (pause seconds in order, number of passes)."""
    pr, p = cfg["printer"], cfg["paper"]
    cmds = [ln for ln in gcode.splitlines() if not ln.startswith(";")]
    i = cmds.index("G28")
    start = [c.split(" F")[0] for c in cmds[i:i + 8]]
    zd, zl = pr["z_draw"], pr["z_lift"]
    assert start[1] == f"G1 Z{zd + write.CLEARANCE:.2f}" and start[2].startswith("G0 X"), start
    assert start[3:7] == [f"G4 S{pr['paper_pause_s']}", f"G1 Z{zd:.2f}", f"G4 S{pr['pen_pause_s']}", f"G1 Z{zl:.2f}"], start
    z, drawn, shift, passes, pauses = None, 0, 0, 0, []
    xy, last_ink, expect_hover = None, None, None
    for line in gcode.splitlines():
        if m := re.match(r"; PASS \d+ of \d+: paper slid (-?\d+) mm", line):
            if passes:
                expect_hover = (last_ink[0], last_ink[1] + int(m[1]) - shift)  # same ink, slid toward the back
            shift, passes = int(m[1]), passes + 1
        if line.startswith(";"):
            continue
        if m := re.match(r"G4 S(\d+)", line):
            pauses.append(int(m[1]))
        v = {k: float(n) for k, n in re.findall(r"([XYZ])(-?[\d.]+)", line)}
        z = v.get("Z", z)
        if "X" in v:
            xy = (v["X"], v["Y"])
            assert 0 <= xy[0] <= pr["bed_x"] and 0 <= xy[1] <= pr["bed_y"], f"nozzle off the bed: {line}"
            pen_x, pen_y = xy[0] + pr["offset_x"], xy[1] + pr["offset_y"]
            assert 0 <= pen_x <= pr["bed_x"] and 0 <= pen_y <= pr["bed_y"], f"pen off the plate: {line}"
            py = p["y"] + shift
            assert p["x"] <= pen_x <= p["x"] + p["width"] and py <= pen_y <= py + p["height"], f"off the paper: {line}"
        if line.startswith("G0"):
            assert z >= zl, f"travel with pen down: {line}"
            if expect_hover:
                assert abs(xy[0] - expect_hover[0]) < 0.02 and abs(xy[1] - expect_hover[1]) < 0.02, (xy, expect_hover)
                expect_hover = None
        if line.startswith("G1") and "X" in v:
            assert z == zd, line
            drawn += 1
        if z == zd and xy:
            last_ink = xy
    assert drawn > 50 and z > zl and expect_hover is None
    return pauses, passes


cfg = write.load_config(src)
pr = cfg["printer"]
out = tmp / "t.gcode"
write.main(["--text", "Hello there, quick test.\nSecond line", "--style", "9", "--seed", "1", "-o", str(out)])
assert check_gcode(out.read_text(), cfg) == ([pr["paper_pause_s"], pr["pen_pause_s"]], 1)  # one pass: no slide pause
assert "ONLY for Bambu Lab A1 " in out.read_text()
assert out.with_suffix(".svg").read_text().startswith("<svg")

lines = "\n".join(["line"] * 30)
for setup, txt, n_passes in [
    # A4 is longer than the A1 bed. Centred, it hangs 20 mm over front and back: the text that fits goes on.
    ({("paper", "size"): '"A4"', ("paper", "x"): "23", ("paper", "y"): "-20"}, lines, 1),
    # A4 with its top at the back edge of the plate: the bottom lines need a second pass.
    ({("paper", "size"): '"A4"', ("paper", "x"): "23", ("paper", "y"): "-41"}, "\n".join(["typing"] * 32), 2),
    # A5 with only 60 mm on the plate: one slide brings the rest on.
    ({("paper", "x"): "54", ("paper", "y"): "-150"}, lines[:5 * 20], 2),
    # A 600 mm strip, top at the back edge: three passes.
    ({("paper", "size"): '"Custom"', ("paper", "height"): "600", ("paper", "x"): "54", ("paper", "y"): "-344"},
     "\n".join(["typing"] * 70), 3),
    ({("printer", "model"): '"Bambu Lab A1 mini"', ("paper", "x"): "16", ("paper", "y"): "-15"}, lines[:5 * 20], 1),
    ({("paper", "orientation"): '"landscape"', ("paper", "x"): "23", ("paper", "y"): "54"}, "Hello there", 1),
]:
    cfg = write.load_config(app.set_values(src, setup))
    plan = write.plan_passes(write.render(txt, cfg, 1)[0], cfg)
    pauses, passes = check_gcode(write.to_gcode(plan, cfg, write.describe(cfg, 1)), cfg)
    assert passes == len(plan) == n_passes, (setup, passes)
    assert pauses == [pr["paper_pause_s"], pr["pen_pause_s"]] + [pr["shift_pause_s"]] * (passes - 1), pauses
assert cfg["paper"]["width"] > cfg["paper"]["height"]  # landscape

# Handwriting placed for the A1 must be refused for the smaller A1 mini.
lines_a1, _ = write.render("Hello there", write.load_config(src), 1)
try:
    write.plan_passes(lines_a1, write.load_config(app.set_values(src, {("printer", "model"): '"Bambu Lab A1 mini"'})))
    raise AssertionError("A1 G-code accepted for the A1 mini")
except write.WriteError:
    pass

# Paper dragged almost off the plate: refused instead of writing in the air.
try:
    write.render("Hello", write.load_config(app.set_values(src, {("paper", "x"): "240"})), 1)
    raise AssertionError("paper off the plate accepted")
except write.WriteError:
    pass

# Line wobble: 0 gives a ruler-straight left edge; the default gives a human, ragged one that stays in the area.
starts = {}
for k in (0, 1, 2):
    cfg = write.load_config(src)
    cfg["writing"]["wobble"] = k
    page, _ = write.render("\n".join(["a few words on each line"] * 12), cfg, 5)
    starts[k] = np.array([min(s[:, 0].min() for s in line) for line in page])
    l, t, r, b = write.writing_area(cfg)
    pts = np.vstack([s for line in page for s in line])
    assert pts[:, 0].min() >= l - 1e-6 and pts[:, 0].max() <= r and pts[:, 1].min() >= t - 1e-6, k
assert np.ptp(starts[0]) < 1e-6 and np.ptp(starts[1]) > 0.5, (np.ptp(starts[0]), np.ptp(starts[1]))
# ...and strays both left and right of the usual margin, not only one way.
cfg = write.load_config(src)
home = write.writing_area(cfg)[0] + cfg["writing"]["x_height"]  # usual margin at wobble 1
offsets = np.concatenate([[min(s[:, 0].min() for s in line) - home
                           for line in write.render("\n".join(["a few words"] * 12), cfg, seed)[0]]
                          for seed in range(6)])
assert 0.25 < (offsets < 0).mean() < 0.75, (offsets < 0).mean()

# 3. Too much text is refused instead of running off the page.
try:
    write.main(["--text", "word " * 3000, "--seed", "1", "-o", str(out)])
    raise AssertionError("overflow accepted")
except SystemExit as e:
    assert "doesn't fit" in str(e.code)

# 4. The app's settings editor changes only the value, keeping comments, and adds keys older configs lack.
edited = app.set_values(src, {("printer", "z_draw"): "0.8", ("writing", "style"): '"mine-1"'})
assert tomllib.loads(edited)["printer"]["z_draw"] == 0.8 and tomllib.loads(edited)["writing"]["style"] == "mine-1"
assert edited.count("#") == src.count("#")
newer_keys = ("model", "size", "orientation", "paper_pause_s", "pen_pause_s", "shift_pause_s")
old = "\n".join(line for line in src.splitlines() if not line.startswith(newer_keys))
assert write.load_config(old)["printer"]["model"] == "Custom"
assert write.load_config(old)["printer"]["shift_pause_s"] == 45
added = app.set_values(old, {("printer", "model"): '"Bambu Lab A1 mini"', ("paper", "size"): '"A6"'})
cfg = write.load_config(added)
assert cfg["printer"]["bed_x"] == 180 and cfg["paper"]["width"] == 105

shutil.rmtree(tmp)
print("selfcheck OK")

# 5. Safety audit regressions: every unsafe setting is refused before any G-code exists.
model.STYLES = real_styles
bad = {
    ("printer", "z_draw"): ["0", "-5", "0.3", "false", "-inf", "nan", '"10"'],  # nozzle onto/into the plate, or garbage
    ("printer", "z_lift"): ["10.004", "10.5"],                                 # pen would drag on every travel
    ("printer", "draw_feed"): ["0", "-1500"], ("printer", "paper_pause_s"): ["0", "-30", "1e9"],
    ("printer", "offset_x"): ["inf"],
    ("paper", "orientation"): ['"sideways"'], ("paper", "margin"): ["-5"],
    ("writing", "line_spacing"): ["0", "2"], ("writing", "x_height"): ["0", "-1"],
    ("printer", "pen_pause_s"): ['"30\nG28"'],                                # command injection via a string
}
for key, values in bad.items():
    for v in values:
        try:
            write.load_config(app.set_values(src, {key: v}))
            raise AssertionError(f"accepted {key} = {v}")
        except write.WriteError:
            pass
# Z ceiling per printer: A1 mini is 180 mm tall.
try:
    write.load_config(app.set_values(src, {("printer", "model"): '"Bambu Lab A1 mini"', ("printer", "z_draw"): "170",
                                           ("printer", "z_lift"): "172"}))
    raise AssertionError("Z above the A1 mini's height accepted")
except write.WriteError:
    pass
# NaN in strokes fails closed instead of disabling the bounds check.
ok = write.load_config(src)
try:
    write.check_bounds([np.array([[10.0, 10.0], [np.nan, 5.0], [9999.0, 9999.0]])], ok)
    raise AssertionError("NaN slipped past check_bounds")
except write.WriteError:
    pass
# P1/X1 filament-cutter corner: the nozzle may never go there.
p1 = write.load_config(app.set_values(src, {("printer", "model"): '"Bambu Lab P1P / P1S"', ("paper", "x"): "0",
                                             ("paper", "y"): "0", ("paper", "size"): '"A6"'}))
corner = [(0, [np.array([[5.0, p1["paper"]["height"] - 5.0], [6.0, p1["paper"]["height"] - 5.0]])], None)]
try:
    write.to_gcode(corner, p1, ["t"])
    raise AssertionError("move into the P1 cutter corner accepted")
except write.WriteError:
    pass
# Text edge cases: overlong words are refused; tabs separate words; '...' keeps its dots.
for txt in ["x" * 26, "W" * 30]:
    try:
        write.render(txt, ok, 1)
        raise AssertionError(f"overlong word accepted: {txt[:5]}")
    except write.WriteError:
        pass
assert model.clean_text("a\tb c")[0] == "a b c"
dots = model.Hand(model.Model(), "9").word("...", np.random.default_rng(0))
assert len(dots) >= 3, len(dots)
# Every file tells the user to remove the pen before homing, and lifts the pen higher for the paper slide.
a4 = write.load_config(app.set_values(src, {("paper", "size"): '"A4"', ("paper", "x"): "23", ("paper", "y"): "-40"}))
two = write.plan_passes(write.render("\n".join(["line"] * 33), a4, 1)[0], a4)
assert len(two) == 2, len(two)
g = write.to_gcode(two, a4, ["t"])
assert "G28" in g and "take the pen out" in g and f"G1 Z{max(a4['printer']['z_lift'], a4['printer']['z_draw'] + write.SLIDE_HOVER):.2f}" in g
print("safety regressions OK")
