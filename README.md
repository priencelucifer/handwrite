# handwrite

**Main app: [`web/`](web/)** — the no-install web app (open `web/index.html`; see [`web/README.txt`](web/README.txt)).
Tests: `node --test web/tests/gcode.test.js web/tests/engine.test.js`. The Python app below is the older version.

Turns text into real-looking handwriting G-code for a Bambu Lab printer with a pen holder.
A neural network (Graves' handwriting model) writes each word stroke by stroke, so letters join,
vary and lift like a person's, unlike a font. Give it a few lines of your own writing and it writes in your hand.

## The app

Double-click **Handwrite** on the desktop (or find it in the Start menu).

1. Pick your **Printer** and **Paper** (A4, A5, A6, US Letter, 4x6 card, or Custom; tick Landscape to turn it).
   The preview shows the build plate from above, front edge at the bottom. The orange dashed line is the plate edge.
2. Drag the paper to where it will sit on the plate. Paper longer than the plate (A4 on an A1) can hang over the
   front edge: the app writes the part over the plate first, then pauses so you can slide the paper toward the
   back, and writes the rest. A red line on the paper shows where each pass starts and how far to slide.
3. Type your text, pick a handwriting, set neatness and letter size, then click **Save G-code…**.

The G-code only fits the printer you picked: every pen move is checked against that printer's bed and the paper
before the file is saved, and the file's first lines say which printer it is for. **Add my handwriting…** opens the
writing page, and **Printer & paper settings…** holds the pen offset, pen heights, speeds and Custom sizes.

To build and install it (or update it after changing the code), run this. It keeps your settings and saved handwriting:

```bash
powershell -ExecutionPolicy Bypass -File build.ps1
```

The rest of this file covers the command-line version.

## Setup (once)

```bash
pip install -r requirements.txt
```

Then edit `config.toml`: set your printer `model` and paper `size` and position, and copy the tool offset that
already works for you in BambuPlot.

## Write something

```bash
python write.py note.txt -o note.gcode
```

This writes `note.gcode` and a preview `note.svg`. Open the SVG in a browser first.
Useful options: `--style 0..12` (presets) or `--style mine-1`, `--bias` (neatness),
`--x-height` (letter size in mm), `--seed` (same seed = same writing; change it to re-roll a word you dislike).

## Teach it your handwriting

```bash
python capture_server.py
```

Open the address it prints on your phone or tablet (same Wi-Fi). Write each sentence on one line and press Save.
Each save is a style (`mine-1`, `mine-2`, ...). Try each with `--style` and keep whichever looks most like you.

## Printing

Start the G-code on the printer the same way you sent BambuPlot's files, **without the pen in the holder**.

1. The printer homes, raises the head and stops over the spot where the first letter goes.
   Place the paper (tape it down) within `paper_pause_s` seconds.
2. The head lowers to `z_draw` (the nozzle height while writing). Slide the pen down until it just touches the
   paper and clamp it, within `pen_pause_s` seconds. This sets the pen length, so no other calibration is needed.
3. It writes.
4. Long pages only: when the pen stops over the writing, slide the paper toward the back of the printer (the app
   and the G-code comments say how many mm) until the last mark written is right under the pen tip. You have
   `shift_pause_s` seconds.

Change the pause lengths and heights in **Printer & paper settings…** (or `config.toml`). The first time, watch the
whole run with a hand near the printer's stop button.

## Limits

- The model knows letters, digits and `! " # ' ( ) , - . : ; ?`. Other characters are skipped (it tells you which).
  Capital Q, X and Z are written lowercase.
- A word occasionally comes out garbled: re-run with another `--seed`, or raise `--bias`.

`python selfcheck.py` runs a quick end-to-end test.

Credits: model weights from sjvasquez/handwriting-synthesis (trained on IAM-OnDB, academic-use data).
Inference is ported from tibordp/kurvengefahr (GPL-2.0). Fine for personal use; check both licenses before sharing it further.
