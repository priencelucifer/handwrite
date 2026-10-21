# Handwrite: Python version

This is the original version of Handwrite. It's a Windows desktop app and a command-line tool built on the NumPy
model in [`model.py`](model.py). The [web app](../README.md) replaced it and has more features, but `model.py` is still the
reference that the web engine is tested against.

Run every command below from this folder.

## Setup (once)

```bash
pip install -r requirements.txt
```

Then edit `config.toml`: set your printer `model`, the paper `size` and position, and the pen (tool) offset.

## Desktop app

To build it and install it into the Start menu and onto the desktop (run it again after changing the code; your
settings and saved handwriting are kept):

```bash
powershell -ExecutionPolicy Bypass -File build.ps1
```

Pick a printer and paper, drag the paper on the plate, type your text, pick a handwriting, and click **Save G-code…**.

## Command line

```bash
python write.py sample.txt -o note.gcode
```

This writes `note.gcode` and a preview, `note.svg`. Open the SVG in a browser first.
Options: `--style 0..12` (presets) or `--style mine-1`, `--bias` (neatness), `--x-height` (letter size in mm),
`--seed` (the same seed gives the same writing).

## Teach it your handwriting

```bash
python capture_server.py
```

Open the address it prints on your phone or tablet (on the same Wi-Fi). Write each sentence on one line and press Save.
Each save becomes a style (`mine-1`, `mine-2`, ...).

## Check it

```bash
python selfcheck.py
```

This runs a quick end-to-end test, including the G-code safety checks.
