"""Independent parity review: deterministic reference outputs of model.py -> ref.json (read by check.js).

Run with: python -B gen_ref.py   (from any folder)
"""
import copy
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))
import model as M  # noqa: E402

rng = np.random.default_rng(20261020)
ALPHA = list(M.ALPHABET[1:])


def fl(a):
    return np.asarray(a, np.float64).ravel().tolist()


def rand_text(n):
    return "".join(rng.choice(ALPHA, n))


def walk(T, sx=1.2, sy=1.5, p_eos=0.1, mx=0.4):
    x = np.column_stack([rng.normal(mx, sx, T), rng.normal(0, sy, T), rng.random(T) < p_eos])
    return x.astype(np.float32)


def styles():
    return {n: (np.load(M.STYLES / f"{n}-strokes.npy").astype(np.float32),
                np.load(M.STYLES / f"{n}-chars.npy").tobytes().decode("utf-8", "ignore")) for n in M.list_styles()}


def state_out(st):
    return {k: fl(v) for k, v in st.items()}


def main():
    m = M.Model()
    m64 = copy.copy(m)
    for k in ("k1", "b1", "aw", "ab", "k2", "b2", "k3", "b3", "gw", "gb"):
        setattr(m64, k, getattr(m, k).astype(np.float64))
    S = styles()
    out = {}

    # ---- teacher-forced runs ----
    runs = []

    def tf(inputs, text, st=None, label=""):
        oh = M.one_hot(text)
        st = m.zero_state() if st is None else {k: v.copy() for k, v in st.items()}
        gs, phis = [], []
        for x in inputs:
            g, st, phi = m.step(x, st, oh)
            gs.append(fl(g))
            phis.append(fl(phi))
        runs.append({"label": label, "text": text, "inputs": fl(inputs), "g": gs, "phi": phis, "final": state_out(st)})

    tf(walk(80), rand_text(12), label="random walk, random 12-char text")
    tf(walk(120, p_eos=0.05), rand_text(31), label="random walk, random 31-char text")
    tf(walk(60, sx=8, sy=8, p_eos=0.3, mx=0), M.clean_text("Zebra-like QUIZ: 42?")[0], label="large inputs")
    tf(S["5"][0][200:300], rand_text(18) + " ", label="preset 5 rows 200..300, random text")
    tf(S["11"][0][:100], M.clean_text(S["11"][1])[0] + " ", label="preset 11 rows 0..100, own text")

    # continuation from a primed state, as Hand._sample does
    h3 = M.Hand(m, "3")
    tf(walk(90), h3.prime_text + " minute ", st=h3.state, label="continuation from primed preset 3")
    out["teacher"] = runs

    # ---- priming on every preset ----
    primed = []
    for name, (strokes, chars) in S.items():
        h = M.Hand(m, name)
        st64 = m64.zero_state()
        oh = M.one_hot(h.prime_text + " ")
        for x in strokes:
            _, st64, _ = m64.step(x, st64, oh)
        g = h.state["h3"] @ m.gw + m.gb
        g64 = st64["h3"] @ m64.gw + m64.gb
        primed.append({"name": name, "prime_text": h.prime_text, "xh": float(h.xh), "start_y": float(h.start_y),
                       "k": float(h.k), "steps": len(strokes), "g": fl(g), "state": state_out(h.state),
                       "g_f32_vs_f64": float(np.abs(g - g64).max()),
                       "h3_f32_vs_f64": float(np.abs(h.state["h3"] - st64["h3"]).max()),
                       "kappa_f32_vs_f64": float(np.abs(h.state["kappa"] - st64["kappa"]).max())})
    out["primed"] = primed

    # ---- sampling math with a scripted RNG ----
    class Stub:
        def __init__(self, u, z, upen):
            self.u, self.z, self.upen, self.p, self.k, self.pen_used = u, z, upen, None, None, False

        def choice(self, n, p):
            self.p = np.asarray(p, np.float64)
            total, acc, x = float(self.p.sum()), 0.0, None
            target = self.u * total
            for i, v in enumerate(self.p):
                acc += v
                if target < acc:
                    x = i
                    break
            if x is None:
                x = max(i for i, v in enumerate(self.p) if v > 0)
            self.k = x
            return x

        def standard_normal(self, n):
            return np.array(self.z)

        def random(self):
            self.pen_used = True
            return self.upen

    Mm = m.M

    def logit(p):
        return math.log(p / (1 - p))

    def g_random():
        g = np.concatenate([rng.normal(0, 2, Mm), rng.normal(-1, 1, 2 * Mm), rng.normal(0, 1, Mm),
                            rng.normal(0, 1, 2 * Mm), rng.normal(-2, 2, 1)])
        return g.astype(np.float32)

    def g_with_pis(p, bias):
        g = g_random()
        g[:Mm] = np.log(np.asarray(p)) / (1 + bias)
        return g

    cases = []

    def add(g, bias, u, z, upen, label):
        st = Stub(u, z, upen)
        r = m.sample(np.asarray(g, np.float32), bias, st)
        cases.append({"label": label, "g": fl(np.asarray(g, np.float32)), "bias": bias, "u": u, "z": list(z), "upen": upen,
                      "k": int(st.k), "p": fl(st.p), "out": fl(r), "pen_used": st.pen_used})

    for i in range(60):
        b = [0.0, 0.5, 0.75, 1.5, 3.0, 10.0][i % 6]
        add(g_random(), b, float(rng.random()), rng.normal(0, 1, 2).tolist(), float(rng.random()), f"random g, bias {b}")
    # mixture weights a little above/below the 1% cut-off (after bias scaling)
    for b in (0.0, 0.75, 2.0):
        p = np.full(Mm, 0.0)
        p[:4] = [0.0105, 0.0095, 0.0120, 0.0080]
        p[4:] = (1 - p[:4].sum()) / (Mm - 4)
        for u in (0.0, 0.004, 0.0101, 0.0199, 0.5, 0.99999):
            add(g_with_pis(p, b), b, u, [0.3, -0.7], 0.5, f"pis near 1% cut-off, bias {b}, u {u}")
    # all components but one below the cut-off
    p = np.full(Mm, 0.009 / (Mm - 1))
    p[7] = 0.991
    add(g_with_pis(p, 0.75), 0.75, 0.999, [1.0, 1.0], 0.2, "one dominant component")
    add(np.zeros(6 * Mm + 1, np.float32), 0.75, 0.37, [0.1, 0.2], 0.3, "all-zero g: equal weights")
    # sigma clamp at 1e-4
    for b in (0.0, 0.75, 5.0):
        g = g_random()
        g[Mm:3 * Mm] = -12.0
        add(g, b, 0.42, [1.3, -0.4], 0.6, f"sigma clamp, bias {b}")
        g = g_random()
        g[Mm:3 * Mm] = -9.21 + b  # exp(g - b) ~ 1e-4: right at the clamp
        add(g, b, 0.42, [1.3, -0.4], 0.6, f"sigma at clamp edge, bias {b}")
    # rho clamp
    for r in (20.0, -20.0, 9.0, -9.0, 5.0, 0.0):
        g = g_random()
        g[3 * Mm:4 * Mm] = r
        add(g, 0.75, 0.6, [0.8, 1.7], 0.6, f"rho logit {r}")
    # pen-up probability around the 1% cut-off and the coin flip
    for e, upen in ((0.0099, 0.001), (0.0101, 0.001), (0.0101, 0.5), (0.5, 0.4999), (0.5, 0.5001), (0.999, 0.998), (1e-6, 0.0)):
        g = g_random()
        g[6 * Mm] = logit(e)
        add(g, 0.75, 0.3, [0.0, 0.0], upen, f"e={e}, u_pen={upen}")
    out["sampling"] = cases

    # ---- preprocessing ----
    pre = {"align": [], "denoise": [], "c2o": [], "primer": []}
    for n in range(1, 11):
        for _ in range(3):
            c = np.column_stack([rng.normal(500, 200, n), rng.normal(300, 50, n), rng.random(n) < 0.3])
            pre["align"].append({"label": f"random n={n}", "in": fl(c), "out": fl(M.align(c))})
    for label, c in [("vertical integer x", [[100, 1, 0], [100, 5, 0], [100, 9, 1]]),
                     ("vertical fractional x=0.1", [[0.1, 1, 0], [0.1, 5, 0], [0.1, 9, 1]]),
                     ("vertical fractional x=33.3 n=7", [[33.3, i * 1.7, 0] for i in range(7)]),
                     ("horizontal", [[i * 3.0, 7.5, 0] for i in range(6)]),
                     ("two points", [[1.0, 2.0, 0], [4.0, 9.0, 1]]),
                     ("steep", [[i * 0.01, i * 50.0, 0] for i in range(5)]),
                     ("single point", [[12.5, -3.25, 1]]),
                     ("nearly vertical", [[100 + 1e-9 * i, i * 2.0, 0] for i in range(5)])]:
        c = np.asarray(c, np.float64)
        pre["align"].append({"label": label, "in": fl(c), "out": fl(M.align(c))})

    for L in range(1, 11):
        pats = [np.zeros(L), np.ones(L), (rng.random(L) < 0.35).astype(float), np.eye(1, L, L - 1).ravel()]
        for pi, e in enumerate(pats):
            c = np.column_stack([np.cumsum(rng.normal(1, 2, L)), rng.normal(0, 3, L), e])
            pre["denoise"].append({"label": f"L={L} pattern {pi}", "in": fl(c), "out": fl(M.denoise(c))})
    for n in range(1, 11):
        c = np.column_stack([rng.normal(0, 10, n), rng.normal(0, 10, n), rng.random(n) < 0.4]).astype(np.float64)
        pre["c2o"].append({"in": fl(c), "out": fl(M.coords_to_offsets(c))})

    def stroke(n, x0, y0, step=3.0):
        return np.column_stack([x0 + np.cumsum(rng.normal(step * 0.4, step, n)), y0 + np.cumsum(rng.normal(0, step, n))])

    caps = [
        ("rounding-half lengths 1,3,5,47 (factor exactly 0.5)", [stroke(1, 0, 0), stroke(3, 30, 0), stroke(5, 60, 0), stroke(47, 90, 0)], "a"),
        ("astral emoji + combining accent (4 code points)", [stroke(40, 0, 0), stroke(25, 80, 10)], "a\U0001F600é"),
        ("long text capped at 1150", [stroke(300, 0, 0), stroke(450, 400, 0), stroke(260, 900, 0)], rand_text(60)),
        ("1300 single-point strokes -> truncated to 1200", [stroke(1, 3 * i, 0) for i in range(1300)], rand_text(50)),
        ("single-point strokes with factor > 1", [stroke(1, 0, 0), stroke(20, 10, 0), stroke(1, 50, -20), stroke(2, 60, -20)], "hello"),
        ("one long stroke downsampled", [stroke(2000, 0, 0, 1.0)], "hi"),
        ("upsampling 3x4 points", [stroke(4, 0, 0), stroke(4, 30, 0), stroke(4, 60, 0)], "hello world"),
        ("fractional px coords", [stroke(33, 0.333, 0.667) / 3.0, stroke(17, 20.1, 5.5) / 3.0], "fox"),
        ("text with newline", [stroke(50, 0, 0), stroke(50, 200, 0)], "ab\ncd"),
    ]
    for label, strokes, text in caps:
        strokes = [s.tolist() for s in strokes]
        o = M.prepare_primer(strokes, text)
        pre["primer"].append({"label": label, "strokes": strokes, "text": text, "out": fl(o), "rows": len(o)})
    out["pre"] = pre

    # ---- captured primer -> Hand (save_style into a temp folder, not the project) ----
    cap_strokes = [stroke(60, 0, 0).tolist(), stroke(45, 120, 5).tolist(), stroke(2, 90, -40).tolist(), stroke(70, 200, 0).tolist()]
    cap_text = "quick fox"
    with tempfile.TemporaryDirectory() as tmp:
        M.STYLES = Path(tmp)
        M.save_style("cap", M.prepare_primer(cap_strokes, cap_text), cap_text)
        hc = M.Hand(m, "cap")
        out["captured_hand"] = {"strokes": cap_strokes, "text": cap_text, "xh": float(hc.xh), "start_y": float(hc.start_y),
                                "g": fl(hc.state["h3"] @ m.gw + m.gb), "state": state_out(hc.state)}
        M.STYLES = ROOT / "styles"

    # ---- clean_text ----
    single = [[cp, *(lambda r: [r[0], sorted(r[1])])(M.clean_text(chr(cp)))] for cp in list(range(0, 0x3000)) +
              [0xFEFF, 0xFF21, 0xFF41, 0xFFFD, 0x10000, 0x1D400, 0x1F600, 0x1F468, 0xE0041, 0x10FFFF]]
    multi = ["é", "\U0001F468‍\U0001F469‍\U0001F467", "\ud83d", "\ude00", "a\ud83db", "ǅ", "İı",
             "ﬁ", "\r\n", "Ⅻ", "x​z", "QXZ qxz", "……", "Ångström", "ÅÄÖ åäö",
             "Æ æ Œ œ ß ø", "‚„‹›«»", "′″", "−", "‐‑‒",
             "  ", "\x00abc", "\x85", "a\tb", "naïve café — “quoted” ‘single’ `tick`",
             "    ", "It’s 5 pm…", "\U0001D400\U0001D41A", "Αα Аа", "¨´"]
    out["clean"] = {"single": single, "multi": [[s, *(lambda r: [r[0], sorted(r[1])])(M.clean_text(s))] for s in multi]}

    # ---- Hand._finish on crafted trajectories ----
    def traj_case(rows):
        return [tuple(float(v) for v in r) for r in rows]

    def walkxy(n, x0=0.0, y0=0.0):
        return np.column_stack([x0 + np.cumsum(rng.normal(0.8, 1.0, n)), y0 + np.cumsum(rng.normal(0, 1.5, n)), np.zeros(n)])

    fin_cases = []
    a = walkxy(30)
    a[[9, 19, 29], 2] = 1
    fin_cases.append(("normal 3 strokes", a))
    b = walkxy(25, -30.0, 4.0)
    b[[0, 1, 2, 12], 2] = 1
    fin_cases.append(("3 landing pen-ups", b))
    fin_cases.append(("all pen-up", np.column_stack([walkxy(4)[:, :2], np.ones(4)])))
    fin_cases.append(("single point pen-down", np.array([[3.0, 4.0, 0.0]])))
    sp = np.vstack([np.column_stack([np.array([1.0, 1.2, 1.1]), np.array([0.5, 0.6, 0.55]), [0, 0, 1]]), walkxy(20, 3.0)])
    fin_cases.append(("leading speck", sp))
    sp2 = np.vstack([np.array([[1.0, 0.5, 1.0], [2.0, 0.6, 0.0], [2.1, 0.62, 1.0]]), walkxy(20, 4.0)])
    sp2[-1, 2] = 1
    fin_cases.append(("two leading specks", sp2))
    c = walkxy(18)
    c[[4, 5, 6], 2] = 1
    fin_cases.append(("single-point strokes mid-word, last pen-down", c))
    big = walkxy(15) * 10
    big[:, 2] = 0
    big[[2, 14], 2] = 1
    fin_cases.append(("first stroke 3 points, large", big))
    fin = []
    for name in ("9", "4"):
        h = M.Hand(m, name)
        for label, rows in fin_cases:
            t = traj_case(rows)
            res = h._finish(t)
            fin.append({"style": name, "label": label, "traj": fl(np.asarray(t)), "out": [fl(s) for s in res],
                        "lens": [len(s) for s in res]})
        fin.append({"style": name, "label": "empty", "traj": [], "out": [fl(s) for s in h._finish([])], "lens": []})
    out["finish"] = fin

    (HERE / "ref.json").write_text(json.dumps(out), encoding="utf-8")
    print("wrote ref.json", (HERE / "ref.json").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
