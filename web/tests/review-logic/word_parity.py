"""Runs model.py Hand.word with an RNG that replays engine.js makeRng exactly, so JS and Python words can be
compared stroke by stroke. Writes word_parity.json next to this file."""
import json
import math
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "python"))
import model as M  # noqa: E402

M32 = 0xFFFFFFFF


class Mulberry:
    def __init__(self, seed):
        self.a = int(seed) & M32
        self.spare = None

    def random(self):
        self.a = (self.a + 0x6D2B79F5) & M32
        a = self.a
        t = ((a ^ (a >> 15)) * (1 | a)) & M32
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296

    def normal(self):
        if self.spare is not None:
            z, self.spare = self.spare, None
            return z
        r = math.sqrt(-2 * math.log(1 - self.random()))
        t = 2 * math.pi * self.random()
        self.spare = r * math.sin(t)
        return r * math.cos(t)

    def standard_normal(self, n):
        return [self.normal() for _ in range(n)]

    def choice(self, m, p):
        total = float(sum(float(v) for v in p))
        u = self.random() * total
        acc = 0.0
        for i, v in enumerate(p):
            acc += float(v)
            if u < acc:
                return i
        return max(i for i, v in enumerate(p) if v > 0)


def main():
    cases = json.loads((HERE / "word_cases.json").read_text())
    model = M.Model()
    hands = {}
    out = []
    for c in cases:
        h = hands.get(c["style"]) or hands.setdefault(c["style"], M.Hand(model, c["style"]))
        strokes = h.word(c["word"], Mulberry(c["seed"]), c["bias"])
        out.append({**c, "strokes": [s.tolist() for s in strokes]})
    (HERE / "word_parity.json").write_text(json.dumps(out))
    print(f"{len(out)} words")


if __name__ == "__main__":
    main()
