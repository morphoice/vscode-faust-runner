// Spectrum analyzer: choose FFT size & window, log freq axis, dBFS magnitude,
// peak hold with decay, average modes, pre/post overlay (input vs output for
// instant frequency-response visualisation), cursor with parabolic interpolation,
// harmonic markers.

import { FFT, makeWindow } from './fft.js';

export class Analyzer {
  // getOutCapture/getInCapture are accessors instead of direct buffers so the
  // analyzer always reads the latest snapshots posted by capture-worklet.js.
  constructor(canvas, ctlRoot, getOutCapture, getInCapture) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctlRoot = ctlRoot;
    this.getOut = getOutCapture;
    this.getIn  = getInCapture;
    this.opts = {
      fftSize: 4096,
      window: 'blackman-harris',
      avg: 'exp',        // 'none'|'exp'|'max'
      avgFactor: 0.6,    // exponential smoothing
      peakHold: true,
      peakDecayDbPerSec: 12,
      dbMin: -120,
      dbMax: 0,
      overlay: false,    // pre/post overlay
      response: false,   // show transfer function out/in
      cursorHz: null,
      harmonicHz: null,
    };
    this.fft = new FFT(this.opts.fftSize);
    this.win = makeWindow(this.opts.window, this.opts.fftSize);
    this.specOut = new Float32Array(this.opts.fftSize / 2 + 1);
    this.specIn  = new Float32Array(this.opts.fftSize / 2 + 1);
    this.avgOut  = new Float32Array(this.specOut.length).fill(this.opts.dbMin);
    this.avgIn   = new Float32Array(this.specIn.length).fill(this.opts.dbMin);
    this.peakOut = new Float32Array(this.specOut.length).fill(this.opts.dbMin);
    this.lastFrame = performance.now();
    this.buildCtl();
    this.installCursor();
    this.run = true;
    requestAnimationFrame((t) => this.tick(t));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Keep the backing canvas in device pixels while CSS controls layout size.
  resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.max(200, Math.round(w * dpr));
    this.canvas.height = Math.max(120, Math.round(h * dpr));
  }

  // Rebuild all FFT-dependent buffers when the user changes FFT size.
  setFFTSize(n) {
    if (n === this.opts.fftSize) return;
    this.opts.fftSize = n;
    this.fft = new FFT(n);
    this.win = makeWindow(this.opts.window, n);
    this.specOut = new Float32Array(n / 2 + 1);
    this.specIn  = new Float32Array(n / 2 + 1);
    this.avgOut  = new Float32Array(this.specOut.length).fill(this.opts.dbMin);
    this.avgIn   = new Float32Array(this.specIn.length).fill(this.opts.dbMin);
    this.peakOut = new Float32Array(this.specOut.length).fill(this.opts.dbMin);
  }

  // Swap the analysis window without touching FFT size or smoothing state.
  setWindow(name) {
    this.opts.window = name;
    this.win = makeWindow(name, this.opts.fftSize);
  }

  // Build the compact overlay toolbar shown when the analyzer pane is hovered.
  buildCtl() {
    const root = this.ctlRoot;
    root.innerHTML = '';
    const mk = (html) => { const d = document.createElement('span'); d.innerHTML = html; return d.firstElementChild; };

    const sizes = [512, 1024, 2048, 4096, 8192, 16384];
    const sizeSel = mk(`<select title="FFT size">${sizes.map(s => `<option value="${s}"${s===this.opts.fftSize?' selected':''}>${s}</option>`).join('')}</select>`);
    sizeSel.addEventListener('change', () => this.setFFTSize(parseInt(sizeSel.value, 10)));

    const wins = ['rect','hann','hamming','blackman','blackman-harris','flat-top','kaiser'];
    const winSel = mk(`<select title="window">${wins.map(w => `<option value="${w}"${w===this.opts.window?' selected':''}>${w}</option>`).join('')}</select>`);
    winSel.addEventListener('change', () => this.setWindow(winSel.value));

    const avgSel = mk(`<select title="averaging">
      <option value="none" ${this.opts.avg==='none'?'selected':''}>no avg</option>
      <option value="exp"  ${this.opts.avg==='exp'?'selected':''}>exp avg</option>
      <option value="max"  ${this.opts.avg==='max'?'selected':''}>max</option>
    </select>`);
    avgSel.addEventListener('change', () => { this.opts.avg = avgSel.value; this.avgOut.fill(this.opts.dbMin); this.avgIn.fill(this.opts.dbMin); });

    const peakBtn = mk(`<button class="${this.opts.peakHold?'on':''}" title="peak hold">peak</button>`);
    peakBtn.addEventListener('click', () => { this.opts.peakHold = !this.opts.peakHold; peakBtn.classList.toggle('on'); if (!this.opts.peakHold) this.peakOut.fill(this.opts.dbMin); });

    const ovBtn = mk(`<button class="${this.opts.overlay?'on':''}" title="overlay input spectrum">in+out</button>`);
    ovBtn.addEventListener('click', () => { this.opts.overlay = !this.opts.overlay; ovBtn.classList.toggle('on'); if (this.opts.overlay) this.opts.response = false, respBtn.classList.remove('on'); });

    const respBtn = mk(`<button class="${this.opts.response?'on':''}" title="frequency response (out/in)">resp</button>`);
    respBtn.addEventListener('click', () => { this.opts.response = !this.opts.response; respBtn.classList.toggle('on'); if (this.opts.response) this.opts.overlay = false, ovBtn.classList.remove('on'); });

    const dbMinNum = mk(`<input type="number" value="${this.opts.dbMin}" min="-180" max="-20" step="6" title="dB floor" style="width:54px">`);
    dbMinNum.addEventListener('input', () => { const v = parseFloat(dbMinNum.value); if (isFinite(v)) this.opts.dbMin = v; });

    root.append(
      sizeSel, winSel, avgSel, peakBtn, ovBtn, respBtn,
      Object.assign(document.createElement('label'), { textContent: 'dB floor ' }), dbMinNum
    );
  }

  // Mouse move shows a frequency readout; click toggles harmonic markers at the
  // clicked fundamental.
  installCursor() {
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      this.opts.cursorHz = this.xToHz(x / r.width * this.canvas.width);
      this.opts.cursorY  = y / r.height * this.canvas.height;
    });
    this.canvas.addEventListener('mouseleave', () => { this.opts.cursorHz = null; this.opts.cursorY = null; });
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const hz = this.xToHz(x / r.width * this.canvas.width);
      this.opts.harmonicHz = (this.opts.harmonicHz && Math.abs(this.opts.harmonicHz - hz) / hz < 0.05) ? null : hz;
    });
  }

  // Frequency axis is logarithmic and clamped to the visible audio band.
  hzToX(hz, W) {
    const f0 = 20, f1 = 22000;
    const t = (Math.log(Math.max(1, hz)) - Math.log(f0)) / (Math.log(f1) - Math.log(f0));
    return Math.max(0, Math.min(W, t * W));
  }

  // Convert canvas X position back into frequency for cursor interaction.
  xToHz(x) {
    const W = this.canvas.width;
    const f0 = 20, f1 = 22000;
    const t = x / W;
    return Math.exp(Math.log(f0) + t * (Math.log(f1) - Math.log(f0)));
  }

  // Map dB values into canvas Y coordinates using the configured display range.
  dbToY(db, H) {
    const t = (db - this.opts.dbMin) / (this.opts.dbMax - this.opts.dbMin);
    return H - Math.max(0, Math.min(1, t)) * H;
  }

  // Analyze the newest FFT-size window from a capture buffer.
  computeSpectrum(buf, out) {
    if (!buf) return false;
    const N = this.opts.fftSize;
    if (buf.length < N) return false;
    const slice = buf.subarray(buf.length - N);
    this.fft.magnitudeDb(slice, this.win, out, this.opts.dbMin);
    return true;
  }

  // Animation loop: read capture buffers, compute spectra, update smoothing and
  // peak hold, then render the current frame.
  tick(t) {
    if (!this.run) return;
    requestAnimationFrame((t2) => this.tick(t2));
    const dtSec = Math.max(0.001, (t - this.lastFrame) / 1000);
    this.lastFrame = t;

    const outCap = this.getOut();
    const inCap  = this.getIn();
    let okOut = false, okIn = false;
    if (outCap) okOut = this.computeSpectrum(outCap.l, this.specOut);
    if (inCap && (this.opts.overlay || this.opts.response)) okIn = this.computeSpectrum(inCap.l, this.specIn);
    if (!okOut) return;

    // Averaging modes:
    // - exp: smooths frame-to-frame motion,
    // - max: accumulates maximum observed level,
    // - none: displays the latest spectrum directly.
    if (this.opts.avg === 'exp') {
      const a = this.opts.avgFactor;
      for (let k = 0; k < this.specOut.length; k++) this.avgOut[k] = a * this.avgOut[k] + (1 - a) * this.specOut[k];
      if (okIn) for (let k = 0; k < this.specIn.length; k++) this.avgIn[k] = a * this.avgIn[k] + (1 - a) * this.specIn[k];
    } else if (this.opts.avg === 'max') {
      for (let k = 0; k < this.specOut.length; k++) this.avgOut[k] = Math.max(this.avgOut[k], this.specOut[k]);
      if (okIn) for (let k = 0; k < this.specIn.length; k++) this.avgIn[k] = Math.max(this.avgIn[k], this.specIn[k]);
    } else {
      this.avgOut.set(this.specOut);
      if (okIn) this.avgIn.set(this.specIn);
    }
    // Peak hold decays in dB/sec so it behaves consistently across frame rates.
    if (this.opts.peakHold) {
      const dec = this.opts.peakDecayDbPerSec * dtSec;
      for (let k = 0; k < this.peakOut.length; k++) {
        this.peakOut[k] = Math.max(this.specOut[k], this.peakOut[k] - dec);
      }
    }

    this.draw(outCap.sr);
  }

  // Draw the complete analyzer frame: grid, main trace, optional input/response
  // overlays, cursor readout, and harmonic markers.
  draw(sr) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = '#160E1A'; c.fillRect(0, 0, W, H);

    // Log-frequency grid with dB horizontal lines.
    c.strokeStyle = '#1f1f1f'; c.lineWidth = 1; c.beginPath();
    const decades = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    c.font = `${10 * (window.devicePixelRatio||1)}px ui-monospace,Menlo,monospace`;
    c.fillStyle = '#444';
    for (const f of decades) {
      const x = this.hzToX(f, W);
      c.moveTo(x, 0); c.lineTo(x, H);
      c.fillText(f >= 1000 ? (f/1000)+'k' : f+'', x + 2, H - 2);
    }
    for (let db = this.opts.dbMin; db <= this.opts.dbMax; db += 12) {
      const y = this.dbToY(db, H);
      c.moveTo(0, y); c.lineTo(W, y);
      c.fillText(db + 'dB', 2, y - 2);
    }
    c.stroke();

    const N = this.specOut.length;
    const binHz = (sr / 2) / (N - 1);

    const cs = getComputedStyle(document.body);
    const colOut  = cs.getPropertyValue('--trace-a').trim()    || '#C568CC';
    const colIn   = cs.getPropertyValue('--trace-b').trim()    || '#B692C2';
    const colPeak = cs.getPropertyValue('--trace-peak').trim() || '#8F66C6';
    if (this.opts.response) {
      // Frequency response is displayed as out/in in dB.
      c.strokeStyle = cs.getPropertyValue('--ok').trim() || '#9fd75f'; c.lineWidth = 1.5; c.beginPath();
      let first = true;
      for (let k = 1; k < N; k++) {
        const hz = k * binHz;
        if (hz < 20 || hz > 22000) continue;
        const resp = this.avgOut[k] - this.avgIn[k];
        const x = this.hzToX(hz, W);
        const y = this.dbToY(resp, H);
        if (first) { c.moveTo(x, y); first = false; } else c.lineTo(x, y);
      }
      c.stroke();
    } else {
      // Vertical pink-to-purple gradient for the main output trace
      const grad = c.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0.00, '#FF66D8'); // vibrant pink at top (loud)
      grad.addColorStop(0.35, '#D26AD0');
      grad.addColorStop(0.70, '#8F66C6'); // purple mid-low
      grad.addColorStop(1.00, '#4A3270'); // deep purple at bottom (quiet)
      this.drawTraceGlow(this.avgOut, sr, grad, '#FF66D8', 1.4);
      if (this.opts.peakHold) this.drawTrace(this.peakOut, sr, colPeak + '88', 1);
      if (this.opts.overlay) this.drawTrace(this.avgIn, sr, colIn + 'aa', 1.2);
    }

    // Cursor readout uses parabolic interpolation around the nearest FFT bin for
    // a more useful frequency/amplitude estimate than raw bin snapping.
    if (this.opts.cursorHz != null) {
      const x = this.hzToX(this.opts.cursorHz, W);
      c.strokeStyle = '#888'; c.setLineDash([2,3]); c.beginPath(); c.moveTo(x,0); c.lineTo(x,H); c.stroke(); c.setLineDash([]);
      const k = Math.round(this.opts.cursorHz / binHz);
      if (k >= 1 && k < N - 1) {
        const a = this.avgOut[k-1], b = this.avgOut[k], cc = this.avgOut[k+1];
        const denom = (a - 2*b + cc);
        const dk = denom !== 0 ? 0.5 * (a - cc) / denom : 0;
        const peakDb = b - 0.25 * (a - cc) * dk;
        const peakHz = (k + dk) * binHz;
        const text = `${peakHz.toFixed(1)} Hz · ${peakDb.toFixed(1)} dB`;
        const dpr = window.devicePixelRatio || 1;
        const fontSize = 11 * dpr;
        c.font = `${fontSize}px ui-monospace,Menlo,monospace`;
        const padX = 6 * dpr, padY = 3 * dpr;
        const tw = c.measureText(text).width;
        const boxW = tw + padX * 2;
        const boxH = fontSize + padY * 2;
        // Anchor next to the cursor's actual Y position; flip side if too close to right edge
        let tx = x + 8 * dpr;
        let ty = (this.opts.cursorY != null ? this.opts.cursorY : H / 2) - boxH / 2;
        if (tx + boxW > W - 4 * dpr) tx = x - boxW - 8 * dpr;
        ty = Math.max(4 * dpr, Math.min(H - boxH - 4 * dpr, ty));
        c.fillStyle = 'rgba(20,16,28,0.85)';
        c.fillRect(tx, ty, boxW, boxH);
        c.strokeStyle = '#3A2A45'; c.lineWidth = 1; c.strokeRect(tx + 0.5, ty + 0.5, boxW - 1, boxH - 1);
        c.fillStyle = '#E7DCF0';
        c.textBaseline = 'middle';
        c.fillText(text, tx + padX, ty + boxH / 2);
        c.textBaseline = 'alphabetic';
      }
    }

    // Harmonic markers are based on the last clicked fundamental frequency.
    // Low fundamentals can produce many nearby harmonics on the log axis, so
    // draw every tick but only label markers that have enough horizontal room.
    if (this.opts.harmonicHz != null) {
      const dpr = window.devicePixelRatio || 1;
      const markerCol = '#c89048';
      const labelPadX = 4 * dpr;
      const labelPadY = 2 * dpr;
      const labelGap = 8 * dpr;
      const labelY = H - 16 * dpr;
      let lastLabelRight = -Infinity;
      c.font = `${10 * dpr}px ui-monospace,Menlo,monospace`;
      c.textBaseline = 'middle';
      c.strokeStyle = markerCol;
      c.lineWidth = 1;
      for (let n = 1; n < 32; n++) {
        const hz = this.opts.harmonicHz * n;
        if (hz > 22000) break;
        const x = this.hzToX(hz, W);
        c.globalAlpha = n === 1 ? 0.95 : 0.55;
        c.beginPath();
        c.moveTo(x, H - 10 * dpr);
        c.lineTo(x, H);
        c.stroke();
        const k = Math.round(hz / binHz);
        const dbv = (k >= 0 && k < N) ? this.avgOut[k] : this.opts.dbMin;
        const text = `h${n} ${dbv.toFixed(0)}`;
        const textW = c.measureText(text).width;
        const tx = Math.min(W - textW - labelPadX * 2, Math.max(0, x + 2 * dpr));
        const labelLeft = tx;
        const labelRight = tx + textW + labelPadX * 2;
        if (n === 1 || labelLeft > lastLabelRight + labelGap) {
          c.globalAlpha = 1;
          c.fillStyle = 'rgba(20,16,28,0.82)';
          c.fillRect(tx, labelY - 5 * dpr - labelPadY, textW + labelPadX * 2, 10 * dpr + labelPadY * 2);
          c.strokeStyle = 'rgba(200,144,72,0.45)';
          c.strokeRect(tx + 0.5, labelY - 5 * dpr - labelPadY + 0.5, textW + labelPadX * 2 - 1, 10 * dpr + labelPadY * 2 - 1);
          c.fillStyle = markerCol;
          c.fillText(text, tx + labelPadX, labelY);
          c.strokeStyle = markerCol;
          lastLabelRight = labelRight;
        }
      }
      c.globalAlpha = 1;
      c.textBaseline = 'alphabetic';
    }
  }

  // Draw a plain spectrum trace with logarithmic X and dB Y mapping.
  drawTrace(spec, sr, color, lineWidth = 1.4) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const N = spec.length;
    const binHz = (sr / 2) / (N - 1);
    c.strokeStyle = color; c.lineWidth = lineWidth; c.beginPath();
    let first = true;
    for (let k = 1; k < N; k++) {
      const hz = k * binHz;
      if (hz < 20 || hz > 22000) continue;
      const x = this.hzToX(hz, W);
      const y = this.dbToY(spec[k], H);
      if (first) { c.moveTo(x, y); first = false; } else c.lineTo(x, y);
    }
    c.stroke();
  }

  // Draw a brighter output trace by layering translucent strokes before the
  // final sharp core stroke.
  drawTraceGlow(spec, sr, color, glowColor, lineWidth = 1.4) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const N = spec.length;
    const binHz = (sr / 2) / (N - 1);
    const dpr = window.devicePixelRatio || 1;
    const trace = () => {
      c.beginPath();
      let first = true;
      for (let k = 1; k < N; k++) {
        const hz = k * binHz;
        if (hz < 20 || hz > 22000) continue;
        const x = this.hzToX(hz, W);
        const y = this.dbToY(spec[k], H);
        if (first) { c.moveTo(x, y); first = false; } else c.lineTo(x, y);
      }
    };
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = color;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineWidth = 3.75 * dpr; c.globalAlpha = 0.10; trace(); c.stroke();
    c.lineWidth = 2.1 * dpr;  c.globalAlpha = 0.18; trace(); c.stroke();
    c.lineWidth = 1.2 * dpr;  c.globalAlpha = 0.45; trace(); c.stroke();
    c.restore();
    c.globalAlpha = 1; c.lineWidth = lineWidth * dpr * 0.56; trace(); c.stroke();
  }
}
