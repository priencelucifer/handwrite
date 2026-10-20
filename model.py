"""Graves RNN handwriting synthesis, NumPy-only inference.

Weights: sjvasquez/handwriting-synthesis (trained on IAM-OnDB), as the f16 blob from
tibordp/kurvengefahr. Forward pass and word-sampling tricks are ported from kurvengefahr
(GPL-2.0): tools/reference.py and crate/src/model.rs. Stroke preprocessing mirrors
sjvasquez drawing.py, so a primer captured from you looks like the training data.
"""
import struct
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
STYLES = HERE / "styles"
ALPHABET = "\x00 !\"#'(),-.0123456789:;?ABCDEFGHIJKLMNOPRSTUVWYabcdefghijklmnopqrstuvwxyz"
IDX = {c: i for i, c in enumerate(ALPHABET)}
SPACE = IDX[" "]
MAX_STROKE_LEN = 1200
POINTS_PER_CHAR = 28  # median density of the 13 bundled IAM styles; captures are resampled to it

# Word-sampling knobs from kurvengefahr model.rs, in model units of style 9 (its calibration style,
# x-height 9.85 by Hand's estimate). Scaled to each style's own x-height (see Hand.k).
CALIBRATION_XH = 9.85
TRAIL_MAX_STEPS = 48  # keep sampling this long after the word ends, for t-bars and i-dots
TRAIL_MARGIN_LEFT, TRAIL_MARGIN_RIGHT, TRAIL_MARGIN_Y = 6.0, 12.0, 7.0
TRAIL_BAR_SPAN, TRAIL_BAR_OVERLAP, TRAIL_DOT_OVERLAP = 4.5, 2.0, 4.0
TRAIL_MIN_Y = 0.3  # in x-heights above baseline: t-bars and i-dots ride high, a next word's start doesn't
TRAIL_PUNCT_SIZE = 0.7  # in x-heights: a final '.' or ',' is a small mark just right of the word
WORD_ATTEMPTS = 4
MIN_REL_DWELL = 0.45  # resample a word if attention skipped one of its letters

# Characters the model never saw, mapped to ones it did (from kurvengefahr compose.rs).
SUBST = {"Q": "q", "X": "x", "Z": "z", "‘": "'", "’": "'", "`": "'", "“": '"',
         "”": '"', "–": "-", "—": "-", "…": "...", " ": " "}
for _plain, _accented in {"a": "áàâäãå", "e": "éèêë", "i": "íìîï", "o": "óòôöõ", "u": "úùûü",
                          "n": "ñ", "c": "ç"}.items():
    SUBST.update(dict.fromkeys(_accented, _plain))


def clean_text(text):
    """Map text into the model alphabet. Returns (clean, set of dropped chars)."""
    out, dropped = [], set()
    for c in text:
        c = " " if c.isspace() and c != "\n" else SUBST.get(c, c)  # tabs etc. still separate words
        if all(ch in IDX and ch != "\x00" for ch in c) or c == "\n":
            out.append(c)
        else:
            dropped.add(c)
    return "".join(out), dropped


def one_hot(text):
    """Text (already clean) + NUL terminator, one-hot [U, A]."""
    idx = [IDX[c] for c in text] + [0]
    oh = np.zeros((len(idx), len(ALPHABET)), np.float32)
    oh[np.arange(len(idx)), idx] = 1.0
    return oh


# ---- stroke preprocessing (sjvasquez drawing.py) ----

def align(coords):
    """Remove global slant/offset with a least-squares line fit."""
    coords = np.copy(coords)
    X = np.column_stack([np.ones(len(coords)), coords[:, 0]])
    offset, slope = np.linalg.lstsq(X, coords[:, 1], rcond=None)[0]
    t = np.arctan(slope)
    rot = np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]])
    coords[:, :2] = coords[:, :2] @ rot - offset
    return coords


_SAVGOL_7_3 = np.array([-2, 3, 6, 7, 6, 3, -2], np.float64) / 21  # == scipy savgol_filter(x, 7, 3, mode='nearest')


def smooth(xy):
    return np.column_stack([np.convolve(np.pad(xy[:, i], 3, mode="edge"), _SAVGOL_7_3, "valid") for i in (0, 1)])


def denoise(coords):
    """Savitzky-Golay smoothing per stroke; coords [N,3] with eos=1 on each stroke's last point."""
    parts = np.split(coords, np.where(coords[:, 2] == 1)[0] + 1)
    return np.vstack([np.column_stack([smooth(p[:, :2]), p[:, 2]]) for p in parts if len(p)])


def coords_to_offsets(coords):
    offsets = np.concatenate([coords[1:, :2] - coords[:-1, :2], coords[1:, 2:3]], axis=1)
    return np.concatenate([[[0.0, 0.0, 1.0]], offsets])


def prepare_primer(strokes, text):
    """Your captured strokes -> model primer offsets [T,3].

    strokes: list of strokes, each a list of (x, y) screen points (y down) in time order.
    """
    lengths = np.array([len(s) for s in strokes], float)
    target = min(POINTS_PER_CHAR * len(text), MAX_STROKE_LEN - 50)
    factor = target / lengths.sum()
    coords = []
    for s in strokes:
        s = np.asarray(s, float)
        n = max(1, round(len(s) * factor))
        t = np.linspace(0, len(s) - 1, n)
        pts = np.column_stack([np.interp(t, np.arange(len(s)), s[:, i]) for i in (0, 1)])
        eos = np.zeros((n, 1))
        eos[-1] = 1
        coords.append(np.hstack([pts, eos]))
    coords = np.vstack(coords)
    coords[:, 1] *= -1  # screen y down -> model y up
    offsets = coords_to_offsets(denoise(align(coords)))
    offsets[:, :2] /= np.median(np.linalg.norm(offsets[:, :2], axis=1))
    return offsets[:MAX_STROKE_LEN].astype(np.float32)


# ---- network ----

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def softplus(x):
    return np.log1p(np.exp(-np.abs(x))) + np.maximum(x, 0.0)


class Model:
    def __init__(self, path=HERE / "model.f16.bin"):
        raw = Path(path).read_bytes()
        assert raw[:4] == b"KGM1", "bad weight file"
        _, A, H, K, M = struct.unpack_from("<5I", raw, 4)
        assert A == len(ALPHABET)
        self.H, self.K, self.M = H, K, M
        data = np.frombuffer(raw, np.float16, offset=24).astype(np.float32)
        pos = 0

        def take(*shape):
            nonlocal pos
            n = int(np.prod(shape))
            block = data[pos:pos + n].reshape(shape)
            pos += n
            return block

        U = 6 * M + 1
        self.k1, self.b1 = take(A + 3 + H, 4 * H), take(4 * H)
        self.aw, self.ab = take(A + 3 + H, 3 * K), take(3 * K)
        self.k2, self.b2 = take(3 + H + A + H, 4 * H), take(4 * H)
        self.k3, self.b3 = take(3 + H + A + H, 4 * H), take(4 * H)
        self.gw, self.gb = take(H, U), take(U)
        assert pos == data.size

    def lstm(self, kernel, bias, x, h, c):
        H = self.H
        z = np.concatenate([x, h]) @ kernel + bias
        c = sigmoid(z[2 * H:3 * H] + 1.0) * c + sigmoid(z[:H]) * np.tanh(z[H:2 * H])  # forget_bias 1.0
        return sigmoid(z[3 * H:]) * np.tanh(c), c

    def zero_state(self):
        z = np.zeros(self.H, np.float32)
        return dict(h1=z, c1=z, h2=z, c2=z, h3=z, c3=z, kappa=np.zeros(self.K, np.float32),
                    w=np.zeros(len(ALPHABET), np.float32))

    def step(self, x, st, oh):
        """One timestep. x = [dx, dy, eos]. Returns (mdn params, new state, attention phi)."""
        K = self.K
        h1, c1 = self.lstm(self.k1, self.b1, np.concatenate([st["w"], x]), st["h1"], st["c1"])
        p = softplus(np.concatenate([st["w"], x, h1]) @ self.aw + self.ab)
        alpha, beta, kappa = p[:K], np.maximum(p[K:2 * K], 0.01), st["kappa"] + p[2 * K:] / 25.0
        u = np.arange(len(oh), dtype=np.float32)
        phi = (alpha[:, None] * np.exp(-((kappa[:, None] - u) ** 2) / beta[:, None])).sum(0)
        w = phi @ oh
        h2, c2 = self.lstm(self.k2, self.b2, np.concatenate([x, h1, w]), st["h2"], st["c2"])
        h3, c3 = self.lstm(self.k3, self.b3, np.concatenate([x, h2, w]), st["h3"], st["c3"])
        st = dict(h1=h1, c1=c1, h2=h2, c2=c2, h3=h3, c3=c3, kappa=kappa, w=w)
        return h3 @ self.gw + self.gb, st, phi

    def sample(self, g, bias, rng):
        """Sample one (dx, dy, pen_up) like sjvasquez rnn_cell, incl. its <1% cut-offs."""
        M = self.M
        logits = g[:M] * (1 + bias)
        pis = np.exp(logits - logits.max())
        pis /= pis.sum()
        pis[pis < 0.01] = 0
        k = rng.choice(M, p=pis / pis.sum())
        s1, s2 = max(np.exp(g[M + k] - bias), 1e-4), max(np.exp(g[2 * M + k] - bias), 1e-4)
        rho = np.clip(np.tanh(g[3 * M + k]), -1 + 1e-8, 1 - 1e-8)
        z1, z2 = rng.standard_normal(2)
        dx = g[4 * M + k] + s1 * z1
        dy = g[5 * M + k] + s2 * (rho * z1 + np.sqrt(1 - rho ** 2) * z2)
        e = sigmoid(g[6 * M])
        return np.array([dx, dy, float(e >= 0.01 and rng.random() < e)], np.float32)


def list_styles():
    return sorted({p.name[:-len("-strokes.npy")] for p in STYLES.glob("*-strokes.npy")},
                  key=lambda s: (not s.isdigit(), int(s) if s.isdigit() else s))


def save_style(name, offsets, text):
    STYLES.mkdir(exist_ok=True)
    np.save(STYLES / f"{name}-strokes.npy", offsets.astype(np.float32))
    np.save(STYLES / f"{name}-chars.npy", np.frombuffer(text.encode(), np.uint8))


def _box(traj):
    a = np.asarray(traj)
    return a[:, 0].min(), a[:, 0].max(), a[:, 1].min(), a[:, 1].max()


class Hand:
    """One handwriting style: the model primed on a sample line, writing word by word."""

    def __init__(self, model, style):
        self.m = model
        strokes = np.load(STYLES / f"{style}-strokes.npy").astype(np.float32)
        chars = np.load(STYLES / f"{style}-chars.npy").tobytes().decode("utf-8", "ignore")
        self.prime_text = clean_text(chars)[0].replace("\n", " ")
        oh = one_hot(self.prime_text + " ")
        st = model.zero_state()
        for x in strokes:
            _, st, _ = model.step(x, st, oh)
        self.state = st  # attention now sits at the primer/space boundary; reused for every word

        y = np.cumsum(strokes[:, 1])
        base = np.percentile(y, 20)
        self.xh = np.percentile(y, 75) - base  # x-height in model units (~7 for IAM writers)
        self.start_y = y[-1] - base  # word frames start where the primer ended, measured from baseline
        self.k = self.xh / CALIBRATION_XH

    def word(self, word, rng, bias=0.75):
        """Write one word (no spaces). Returns strokes as [N,2] arrays in x-height units:
        baseline y=0, x-height y=1, y up, x starting at 0."""
        n = len(word)
        full = one_hot(self.prime_text + " " + word + " ")
        start = len(self.prime_text) + 1
        best = None
        for _ in range(WORD_ATTEMPTS):
            traj, dwell, finished = self._sample(full, start, n, rng, bias, word[-1] in ".,;:")
            d = np.sort(dwell)
            score = d[0] / max(d[len(d) // 2], 1e-6)
            if traj and _box(traj)[1] - _box(traj)[0] < 0.3 * n * self.xh:
                score = 0.0  # far too narrow: letters were dropped
            if not finished:
                score = -1.0  # ran out of steps before the end of the word: prefer any attempt that finished
            if best is None or score > best[0]:
                best = (score, traj)
            if score >= MIN_REL_DWELL:
                break
        return self._finish(best[1], keep_lead=word[0] in ".:;'\"")

    def _sample(self, oh, start, n, rng, bias, ends_with_punct=False):
        m, k = self.m, self.k
        st = self.state
        x = m.sample(st["h3"] @ m.gw + m.gb, bias, rng)
        max_steps = min(40 * n + 40, MAX_STROKE_LEN)  # +40: one- and two-letter words need room to finish
        U = len(oh)
        cx, cy = 0.0, self.start_y
        traj, dwell = [], np.zeros(n, np.float32)
        phi, cut, box, trail = None, None, None, 0
        while len(traj) < max_steps + TRAIL_MAX_STEPS:
            cx, cy = cx + x[0], cy + x[1]
            traj.append((cx, cy, x[2]))
            done = phi is not None and phi.argmax() >= U - 2  # attention reached the trailing space
            if cut is None:
                if done and x[2]:
                    cut, box = len(traj), _box(traj)
                elif len(traj) >= max_steps:
                    break
            else:
                trail += 1
                if not (box[0] - TRAIL_MARGIN_LEFT * k <= cx <= box[1] + TRAIL_MARGIN_RIGHT * k
                        and box[2] - TRAIL_MARGIN_Y * k <= cy <= box[3] + TRAIL_MARGIN_Y * k):
                    break  # wandered off: the model started an imagined next word
                if x[2]:
                    s = _box(traj[cut:])
                    bar = s[1] - s[0] >= TRAIL_BAR_SPAN * k and s[0] <= box[1] - TRAIL_BAR_OVERLAP * k
                    dot = s[0] <= box[1] - TRAIL_DOT_OVERLAP * k
                    punct = (ends_with_punct and max(s[1] - s[0], s[3] - s[2]) <= TRAIL_PUNCT_SIZE * self.xh
                             and s[0] <= box[1] + self.xh and s[3] <= 0.5 * self.xh)
                    if punct:
                        ends_with_punct = False  # only one
                    elif s[2] < TRAIL_MIN_Y * self.xh or not (bar or dot):
                        break
                    cut = len(traj)  # adopt the t-bar / i-dot
                if trail >= TRAIL_MAX_STEPS:
                    break
            g, st, phi = m.step(x, st, oh)
            x = m.sample(g, bias, rng)
            dwell += phi[start:start + n]
        return (traj[:cut] if cut else traj), dwell, cut is not None

    def _finish(self, traj, keep_lead=False):
        while len(traj) > 1 and traj[0][2]:
            traj = traj[1:]  # landing points after the jump from the primer: would plot as stray dots
        if not traj:
            return []
        a = np.asarray(traj, np.float64)
        a[:, 2] = 0
        ends = [i for i, (_, _, e) in enumerate(traj) if e]
        a[ends, 2] = 1
        a[-1, 2] = 1
        a = denoise(a)
        a[:, :2] /= self.xh
        strokes = [p[:, :2] for p in np.split(a, np.where(a[:, 2] == 1)[0] + 1) if len(p)]
        while not keep_lead and len(strokes) > 1 and np.ptp(strokes[0], axis=0).max() < 0.15:
            strokes.pop(0)  # a speck before the first letter is landing jitter; a word never starts with a dot
        x0 = min(s[:, 0].min() for s in strokes)
        return [s - [x0, 0] for s in strokes]
