try {
  importScripts("../../engine.js", "../../weights.js", "../../styles.js");
  const model = HWEngine.loadModel(HWEngine.b64ToBytes(HW_WEIGHTS_B64));
  const ink = new HWEngine.Hand(model, HWEngine.decodePreset(HW_PRESETS[9])).word("hello", 42);
  postMessage("ok, simd " + model.simd + ", strokes " + ink.length + ", sum x " + ink.flat().reduce((s, p) => s + p[0], 0));
} catch (e) { postMessage("ERROR " + e); }
