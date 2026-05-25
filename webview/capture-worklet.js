// AudioWorklet used as a tap in the runner graph.
//
// Each instance stores stereo audio in a rolling buffer, optionally passes the
// signal through, and posts an unwrapped snapshot to the UI thread about 30
// times per second. main.js uses one instance before Faust and one after Faust
// so the scope/analyzer can inspect both sides of the DSP.

class CaptureProcessor extends AudioWorkletProcessor {
  // processorOptions:
  // - tag: "in" or "out", echoed back with posted buffers,
  // - size: rolling buffer length in samples,
  // - passThrough: whether audio should continue through this worklet,
  // - postIntervalSec: UI update cadence.
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.tag = o.tag || 'cap';
    this.size = o.size || 16384;
    this.passThrough = o.passThrough !== false;
    this.postIntervalSec = o.postIntervalSec || 0.033;
    this.left  = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.writePos = 0;
    this.samplesSincePost = 0;
    this.intervalSamples = Math.floor(this.postIntervalSec * sampleRate);
  }

  // Copy the current render quantum into the ring buffer, mirror the signal to
  // the output if requested, and periodically post an ordered copy where the
  // newest sample lands at the end of the arrays.
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const L = input[0];
    const R = input[1] || input[0];
    const len = L.length;

    if (this.passThrough && output && output.length) {
      const oL = output[0], oR = output[1] || output[0];
      for (let i = 0; i < len; i++) { oL[i] = L[i]; if (oR !== oL) oR[i] = R[i]; }
    }

    let wp = this.writePos;
    const sz = this.size;
    for (let i = 0; i < len; i++) {
      this.left[wp]  = L[i];
      this.right[wp] = R[i];
      wp++; if (wp >= sz) wp = 0;
    }
    this.writePos = wp;

    this.samplesSincePost += len;
    if (this.samplesSincePost >= this.intervalSamples) {
      this.samplesSincePost = 0;
      const l = new Float32Array(sz), r = new Float32Array(sz);
      // unwrap so newest sample is at index sz-1
      const head = wp;
      l.set(this.left.subarray(head), 0);
      l.set(this.left.subarray(0, head), sz - head);
      r.set(this.right.subarray(head), 0);
      r.set(this.right.subarray(0, head), sz - head);
      this.port.postMessage({ tag: this.tag, sr: sampleRate, l, r, writeHead: sz }, [l.buffer, r.buffer]);
    }
    return true;
  }
}

registerProcessor('faust-capture', CaptureProcessor);
