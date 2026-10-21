HANDWRITE - real-looking handwriting with a 3D printer and a pen holder
=======================================================================

Nothing to install. Unzip the folder, then double-click Handwrite.html. Guide.html shows how to use it, with pictures.
It opens in your web browser (Edge, Chrome, Firefox or Safari) and works offline.
Keep all the files together in one folder.

1. Type your text and pick a handwriting style.
2. Choose your printer and paper. Drag the paper on the build plate to where it will sit.
3. Open "Printer settings" once and enter your pen offset (the BambuPlot "tool offset"), or measure it:
   "Save offset test G-code", push A4 paper into the top-left (far-left) corner of the plate, run the file, then type in how far
   the long line is below the paper's top edge and the short mark from its left edge (the offset fills in), and click Save.
   A wrong offset makes the last lines run off the front of the plate.
4. Click "Save G-code" and send the file to the printer the same way as other plain .gcode files.

Long text: it continues on page 2, 3, ... (up to 50). Use the arrows above the preview to look at each page.
"Save page N" saves the page on screen; "Save all pages" downloads handwriting-pages.zip (1_page.gcode, 2_page.gcode, ...)
to your Downloads folder. Open it, copy the files onto the SD card, and print them in order with a fresh sheet each time.

Running the file:
- Take the pen OUT of the holder before starting. The printer homes first, and homing touches the
  nozzle to the plate.
- Pause 1: the head stops over the first letter. Put the paper where the preview showed it and tape it down.
- Pause 2: the head lowers. Slide the pen down until it touches the paper, then clamp it.
- Long pages (for example A4 on an A1): writing stops where the pen would leave the plate and the text
  continues on the next page. With "Slide the paper" ticked it pauses instead: the pen stops over the last
  thing it wrote; slide the paper toward the back until that mark is under the pen tip.
- Do a dry run first, and stay with the printer the first time.

Your own handwriting: "My handwriting" > write a sentence > Save style. Styles are kept in this browser
only; use Export/Import to move them to another computer.

Safety: every setting is range-checked, and every move in the file is checked against the chosen printer's
bed (and the P1/X1 filament-cutter corner) before the file is written. If something is unsafe, the app
refuses to save and says why. The G-code is only for the printer named at the top of the file.

Credits: handwriting model weights from sjvasquez/handwriting-synthesis (trained on IAM-OnDB, academic-use
data); inference ported from tibordp/kurvengefahr (GPL-2.0). Fine for personal use; check both licenses
before redistributing.
