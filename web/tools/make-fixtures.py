"""Writes web/tests/fixtures.json: reference outputs of ../python/model.py that engine.test.js checks the JS port against.

Usage (dev only): python web/tools/make-fixtures.py
"""
import copy
import json
import sys
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True  # importing model.py must not drop a __pycache__ into the app folder
WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB.parent / "python"))
import model as M  # noqa: E402

WEIGHT_NAMES = ("k1", "b1", "aw", "ab", "k2", "b2", "k3", "b3", "gw", "gb")
SANITY_WORDS = ["hello", "the", "quick", "brown", "jumps", "Lazy", "dog.", "it's", "minimum", "Tuesday,",
                "write", "pen", "plotter", "Away", "fox!", "number", "42", "office", "sky", "wavy"]


def num(a):
    return [float(f"{v:.8g}") for v in np.asarray(a, np.float64).ravel()]


def load_style(name):
    strokes = np.load(M.STYLES / f"{name}-strokes.npy").astype(np.float32)
    chars = np.load(M.STYLES / f"{name}-chars.npy").tobytes().decode("utf-8", "ignore")
    return strokes, chars


def teacher_forced(model, inputs, text):
    """Step from a zero state on fixed inputs; per-step MDN params and attention phi."""
    oh = M.one_hot(text)
    st = model.zero_state()
    gs, phis = [], []
    for x in inputs:
        g, st, phi = model.step(x, st, oh)
        gs.append(num(g))
        phis.append(num(phi))
    return {"text": text, "inputs": num(inputs), "g": gs, "phi": phis}


def prime(model, strokes, chars):
    """Same priming as Hand.__init__, on any model (used for the float64 twin)."""
    text = M.clean_text(chars)[0].replace("\n", " ")
    oh = M.one_hot(text + " ")
    st = model.zero_state()
    for x in strokes:
        _, st, _ = model.step(x, st, oh)
    return st


def main():
    model = M.Model()
    # float64 twin: how far float32 rounding alone moves the reference after a long primer.
    model64 = copy.copy(model)
    for name in WEIGHT_NAMES:
        setattr(model64, name, getattr(model, name).astype(np.float64))

    s0, c0 = load_style("0")
    s9, _ = load_style("9")
    t = np.arange(40)
    synthetic = np.column_stack([2 * np.sin(t / 3), 1.5 * np.cos(t / 4), (t % 10 == 9)]).astype(np.float32)
    teacher = [
        teacher_forced(model, s0[:40], M.clean_text(c0)[0] + " "),
        teacher_forced(model, s9[:40], "Hello, world. "),
        teacher_forced(model, synthetic, "quick brown fox "),
    ]

    hands = {name: M.Hand(model, name) for name in M.list_styles()}
    primed = []
    for name in ("9", "0"):
        hand = hands[name]
        st, st64 = hand.state, prime(model64, *load_style(name))
        g, g64 = st["h3"] @ model.gw + model.gb, st64["h3"] @ model64.gw + model64.gb
        primed.append({"style": name, "steps": len(load_style(name)[0]), "xh": float(hand.xh), "start_y": float(hand.start_y),
                       "g": num(g), "h3": num(st["h3"]), "kappa": num(st["kappa"]),
                       "g_f32_vs_f64": float(np.abs(g - g64).max()), "h3_f32_vs_f64": float(np.abs(st["h3"] - st64["h3"]).max())})

    clean_cases = ["Hello, World!", "Quiz: XYZ 100% sure?", "naïve café — “quoted” ‘single’ `tick` …",
                   "tab\there\r\nline two", "emoji 😀 and @$&*", "Ångström ÀÉÎ ñ ç", "non breaking", ""]
    clean = [{"text": s, "clean": c, "dropped": sorted(d)} for s in clean_cases for c, d in [M.clean_text(s)]]

    # Deterministic "captures" in screen px (y down): one upsampled (few points for the text), one downsampled.
    i = np.arange(60)
    loop = np.column_stack([100 + 2 * i + 12 * np.sin(i / 4), 200 + 25 * np.cos(i / 3) + 0.2 * i])
    j = np.arange(25)
    bar = np.column_stack([150 + 3 * j, 180 - 0.3 * j])
    k = np.arange(400)
    long = np.column_stack([50 + 0.9 * k + 6 * np.sin(k / 7), 300 + 18 * np.sin(k / 5) + 0.05 * k])
    captures = [([loop.tolist(), bar.tolist(), [[170.0, 160.0]], [[175.0, 150.0], [176.0, 149.0]]], "hello"),
                ([long[:250].tolist(), long[250:].tolist()], "hi")]
    primers = [{"strokes": s, "text": text, "offsets": num(M.prepare_primer(s, text))} for s, text in captures]

    rng = np.random.default_rng(7)
    slanted = np.column_stack([np.arange(12) * 3.0, 5 + 0.4 * np.arange(12) * 3.0 + rng.normal(0, 0.5, 12), np.zeros(12)])
    noisy = np.column_stack([np.cumsum(rng.normal(1, 0.5, 15)), rng.normal(0, 1, 15), np.zeros(15)])
    noisy[[4, 5, 14], 2] = 1  # strokes of 5, 1 and 9 points
    arrays = {"align_in": num(slanted), "align_out": num(M.align(slanted)),
              "denoise_in": num(noisy), "denoise_out": num(M.denoise(noisy))}

    # The RNGs differ, so word() is compared by distribution: model.py's width per char on the same (style, word) pairs.
    words = []
    for n, (name, hand) in enumerate(hands.items()):
        for j in range(5):
            w = SANITY_WORDS[(5 * n + j) % len(SANITY_WORDS)]
            words.append({"style": name, "word": w, "py_width_per_char": [
                float(np.vstack(hand.word(w, np.random.default_rng(seed)))[:, 0].max() / len(w)) for seed in range(2)]})

    out = {"teacher": teacher, "primed": primed, "clean": clean, "primers": primers, "arrays": arrays, "words": words,
           "styles": {name: {"xh": float(h.xh), "start_y": float(h.start_y)} for name, h in hands.items()}}
    path = WEB / "tests" / "fixtures.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes)")
    for p in primed:
        print(f"style {p['style']}: {p['steps']} primer steps, float32 vs float64 reference: "
              f"max |dg| {p['g_f32_vs_f64']:.2e}, max |dh3| {p['h3_f32_vs_f64']:.2e}")


if __name__ == "__main__":
    main()
