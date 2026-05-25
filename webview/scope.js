// Sophisticated oscilloscope.
// Features: triggered (rising/falling/both/auto) with adjustable level and hysteresis,
// time/div, channel select (L, R, both, X/Y/Lissajous), persistence (afterglow),
// cursors with dt/dV readouts, single-shot mode, capture-to-wav of visible window.

export class Scope {
  // getCapture is an accessor returning the latest post-Faust capture snapshot
  // from main.js. The scope keeps only UI state and optional single-shot data.
  constructor(canvas, ctlRoot, getCapture) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctlRoot = ctlRoot;
    this.getCapture = getCapture; // () => {l, r, sr}
    this.opts = {
      timeDivMs: 5,
      trigger: 'rising', // 'rising' | 'falling' | 'auto' | 'free'
      level: 0.0,
      hysteresis: 0.01,
      holdoffSamples: 64,
      channel: 'both', // 'L'|'R'|'both'|'xy'
      persistence: 0,  // 0..1
      single: false,
      armed: true,
      cursorA: null,   // x sample offset
      cursorB: null,
    };
    this.persistImg = null;
    this.buildCtl();
    this.installCursors();
    this.run = true;
    this.lastFrame = 0;
    this.captured = null;
    this.singleHeld = false;
    requestAnimationFrame((t) => this.tick(t));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Match the backing canvas to the rendered size and device pixel ratio.
  resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(200, Math.round(w * dpr));
    this.canvas.height = Math.max(120, Math.round(h * dpr));
    this.persistImg = null;
  }

  // Build the compact overlay toolbar for timebase, trigger mode, channel mode,
  // persistence, single-shot capture, and WAV export.
  buildCtl() {
    const root = this.ctlRoot;
    root.innerHTML = '';
    const mk = (html) => { const d = document.createElement('span'); d.innerHTML = html; return d.firstElementChild; };

    const tdSel = mk(`<select title="ms / division">
      ${[0.05,0.1,0.2,0.5,1,2,5,10,20,50,100].map(v=>`<option value="${v}"${v===this.opts.timeDivMs?' selected':''}>${v} ms/div</option>`).join('')}
    </select>`);
    tdSel.addEventListener('change', () => { this.opts.timeDivMs = parseFloat(tdSel.value); });

    const trigSel = mk(`<select title="trigger">
      <option value="rising"  ${this.opts.trigger==='rising'?'selected':''}>↑ rising</option>
      <option value="falling" ${this.opts.trigger==='falling'?'selected':''}>↓ falling</option>
      <option value="auto"    ${this.opts.trigger==='auto'?'selected':''}>auto</option>
      <option value="free"    ${this.opts.trigger==='free'?'selected':''}>free</option>
    </select>`);
    trigSel.addEventListener('change', () => { this.opts.trigger = trigSel.value; });

    const lvl = mk(`<input type="number" step="0.01" min="-1" max="1" value="${this.opts.level}" title="trigger level" style="width:54px">`);
    lvl.addEventListener('input', () => { this.opts.level = parseFloat(lvl.value) || 0; });

    const chSel = mk(`<select title="channel">
      <option value="L"    ${this.opts.channel==='L'?'selected':''}>L</option>
      <option value="R"    ${this.opts.channel==='R'?'selected':''}>R</option>
      <option value="both" ${this.opts.channel==='both'?'selected':''}>L+R</option>
      <option value="xy"   ${this.opts.channel==='xy'?'selected':''}>X/Y</option>
    </select>`);
    chSel.addEventListener('change', () => { this.opts.channel = chSel.value; });

    const persist = mk(`<input type="range" min="0" max="0.99" step="0.01" value="${this.opts.persistence}" title="persistence" style="width:60px">`);
    persist.addEventListener('input', () => { this.opts.persistence = parseFloat(persist.value); if (!this.opts.persistence) this.persistImg = null; });

    const singleBtn = mk(`<button title="Single-shot capture">single</button>`);
    singleBtn.addEventListener('click', () => { this.opts.single = true; this.opts.armed = true; this.singleHeld = false; singleBtn.classList.add('on'); });

    const dlBtn = mk(`<button title="Capture window to wav">⤓ wav</button>`);
    dlBtn.addEventListener('click', () => this.exportWav());

    root.append(
      mk('<label></label>').appendChild(tdSel) ? tdSel : tdSel,
    );
    root.append(
      tdSel, trigSel,
      Object.assign(document.createElement('label'), { textContent: 'lvl ' }), lvl,
      chSel,
      Object.assign(document.createElement('label'), { textContent: 'persist ' }), persist,
      singleBtn, dlBtn
    );
    this.singleBtn = singleBtn;
  }

  // Cursors are placed by clicking/shift-clicking and dragged in sample units so
  // their readout stays stable when the canvas is resized.
  installCursors() {
    let dragging = null;
    this.canvas.addEventListener('mousedown', (e) => {
      const x = (e.offsetX / this.canvas.clientWidth) * this.viewSamples();
      if (e.shiftKey) { this.opts.cursorB = x; dragging = 'B'; }
      else { this.opts.cursorA = x; dragging = 'A'; }
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      if (px < 0 || px > r.width) return;
      const x = (px / r.width) * this.viewSamples();
      this.opts[dragging === 'A' ? 'cursorA' : 'cursorB'] = x;
    });
    window.addEventListener('mouseup', () => { dragging = null; });
    this.canvas.addEventListener('dblclick', () => { this.opts.cursorA = this.opts.cursorB = null; });
  }

  // Convert the selected time/div setting into the number of samples visible
  // across the 10 horizontal divisions.
  viewSamples() {
    const cap = this.getCapture();
    if (!cap) return 1024;
    const samples = Math.floor((this.opts.timeDivMs / 1000) * cap.sr * 10); // 10 divisions
    return Math.max(64, Math.min(samples, cap.l.length));
  }

  // Find the first hysteresis-qualified threshold crossing after holdoff.
  findTrigger(buf, want, hyst, level, holdoff) {
    const N = buf.length;
    let state = 0; // 0=below, 1=above (after hysteresis)
    for (let i = holdoff; i < N - 1; i++) {
      const v = buf[i];
      if (state === 0 && v > level + hyst) {
        if (want === 'rising') return i;
        state = 1;
      } else if (state === 1 && v < level - hyst) {
        if (want === 'falling') return i;
        state = 0;
      }
    }
    return -1;
  }

  // Animation loop: choose a window from the rolling capture buffer, honor
  // trigger/single-shot state, then draw the visible samples.
  tick(t) {
    if (!this.run) return;
    requestAnimationFrame((t2) => this.tick(t2));
    const cap = this.getCapture();
    if (!cap) return;

    const view = this.viewSamples();
    const total = cap.l.length;
    let start = total - view;
    let trigSample = -1;

    if (this.opts.trigger !== 'free' && this.opts.trigger !== 'auto') {
      const trigBuf = this.opts.channel === 'R' ? cap.r : cap.l;
      const sub = trigBuf.subarray(Math.max(0, total - view * 2), total);
      const idx = this.findTrigger(sub, this.opts.trigger, this.opts.hysteresis, this.opts.level, this.opts.holdoffSamples);
      if (idx >= 0) {
        trigSample = Math.max(0, total - view * 2) + idx;
        start = Math.max(0, Math.min(total - view, trigSample - Math.floor(view / 2)));
      } else if (this.opts.single) {
        return; // wait for trigger
      }
    } else if (this.opts.trigger === 'auto') {
      const trigBuf = this.opts.channel === 'R' ? cap.r : cap.l;
      const sub = trigBuf.subarray(Math.max(0, total - view * 2), total);
      const idx = this.findTrigger(sub, 'rising', this.opts.hysteresis, this.opts.level, this.opts.holdoffSamples);
      if (idx >= 0) { trigSample = Math.max(0, total - view * 2) + idx; start = Math.max(0, Math.min(total - view, trigSample - Math.floor(view / 2))); }
    }

    // Single-shot freezes the first triggered window until the user arms again.
    if (this.opts.single && trigSample >= 0) {
      this.singleHeld = true;
      this.captured = { l: cap.l.slice(start, start + view), r: cap.r.slice(start, start + view), sr: cap.sr, start };
      this.opts.single = false;
      this.singleBtn && this.singleBtn.classList.remove('on');
    }

    const drawL = this.singleHeld && this.captured ? this.captured.l : cap.l.subarray(start, start + view);
    const drawR = this.singleHeld && this.captured ? this.captured.r : cap.r.subarray(start, start + view);
    this.draw(drawL, drawR, cap.sr);
  }

  // Draw oscilloscope grid, traces, cursors, and status text for the selected
  // channel mode. X/Y mode plots L against R instead of time.
  draw(L, R, sr) {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (this.opts.persistence > 0 && this.persistImg) {
      c.globalAlpha = this.opts.persistence;
      c.drawImage(this.persistImg, 0, 0);
      c.globalAlpha = 1;
      // fade prior frame
      c.fillStyle = `rgba(12,12,12,${1 - this.opts.persistence * 0.85})`;
      c.fillRect(0, 0, W, H);
    } else {
      c.fillStyle = '#160E1A';
      c.fillRect(0, 0, W, H);
    }
    // Scope graticule: 10 horizontal divisions and 8 vertical divisions.
    c.strokeStyle = '#222'; c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 10; i++) { const x = (W * i) / 10; c.moveTo(x, 0); c.lineTo(x, H); }
    for (let i = 1; i < 8; i++)  { const y = (H * i) / 8;  c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
    // Zero line plus trigger threshold.
    c.strokeStyle = '#333';
    c.beginPath(); c.moveTo(0, H/2); c.lineTo(W, H/2); c.stroke();
    c.strokeStyle = '#5a4630';
    const ly = (1 - (this.opts.level + 1) / 2) * H;
    c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, ly); c.lineTo(W, ly); c.stroke(); c.setLineDash([]);

    if (this.opts.channel === 'xy') {
      const xyGrad = c.createRadialGradient(W/2, H/2, Math.min(W,H)*0.05, W/2, H/2, Math.min(W,H)*0.5);
      xyGrad.addColorStop(0, '#4A3270');
      xyGrad.addColorStop(0.6, '#C568CC');
      xyGrad.addColorStop(1, '#FF66D8');
      c.strokeStyle = xyGrad; c.lineWidth = 1; c.beginPath();
      const N = L.length;
      for (let i = 0; i < N; i++) {
        const x = (L[i] + 1) / 2 * W;
        const y = (1 - (R[i] + 1) / 2) * H;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    } else {
      const dpr = window.devicePixelRatio || 1;
      const drawTrace = (buf, color) => {
        const trace = () => {
          c.beginPath();
          const N = buf.length;
          for (let i = 0; i < N; i++) {
            const x = (i / (N - 1)) * W;
            const y = (1 - (buf[i] + 1) / 2) * H;
            if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
          }
        };
        c.lineJoin = 'round'; c.lineCap = 'round';
        c.strokeStyle = color;
        c.save();
        // Additive halo using the SAME gradient as the trace — so glow and curve always match
        c.globalCompositeOperation = 'lighter';
        c.lineWidth = 3.4 * dpr; c.globalAlpha = 0.10; trace(); c.stroke();
        c.lineWidth = 1.9 * dpr; c.globalAlpha = 0.18; trace(); c.stroke();
        c.lineWidth = 1.05 * dpr; c.globalAlpha = 0.45; trace(); c.stroke();
        c.restore();
        // Sharp core
        c.globalAlpha = 1; c.lineWidth = 0.75 * dpr; trace(); c.stroke();
      };
      // Vertical pink↔purple gradient: pink at amplitude extremes (top & bottom),
      // purple near the zero line — so "loud" samples render pink, near-silence purple.
      const grad = c.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0.00, '#FF66D8');
      grad.addColorStop(0.30, '#C568CC');
      grad.addColorStop(0.50, '#4A3270');
      grad.addColorStop(0.70, '#C568CC');
      grad.addColorStop(1.00, '#FF66D8');
      const cs = getComputedStyle(document.body);
      const colR = cs.getPropertyValue('--trace-b').trim() || '#B692C2';
      if (this.opts.channel === 'L' || this.opts.channel === 'both') drawTrace(L, grad);
      if (this.opts.channel === 'R' || this.opts.channel === 'both') drawTrace(R, colR);
    }

    // Cursors display absolute time from the left edge; when both are present,
    // the bottom readout shows delta time and reciprocal frequency.
    const drawCursor = (s, color, label) => {
      if (s == null) return;
      const x = (s / L.length) * W;
      c.strokeStyle = color; c.lineWidth = 1; c.setLineDash([2,3]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); c.setLineDash([]);
      const tMs = (s / sr * 1000).toFixed(3);
      c.fillStyle = color; c.font = `${10 * (window.devicePixelRatio||1)}px ui-monospace,Menlo,monospace`;
      c.fillText(`${label} ${tMs}ms`, x + 4, 12 * (window.devicePixelRatio||1));
    };
    drawCursor(this.opts.cursorA, '#9fd75f', 'A');
    drawCursor(this.opts.cursorB, '#d75f9f', 'B');
    if (this.opts.cursorA != null && this.opts.cursorB != null) {
      const dt = Math.abs(this.opts.cursorB - this.opts.cursorA) / sr;
      const f  = dt > 0 ? 1 / dt : 0;
      c.fillStyle = '#ddd';
      c.fillText(`Δt ${(dt*1000).toFixed(3)} ms  (${f.toFixed(2)} Hz)`, 8, H - 8);
    }

    // Status text keeps current timebase/channel/trigger visible inside canvas.
    c.fillStyle = '#888'; c.font = `${10 * (window.devicePixelRatio||1)}px ui-monospace,Menlo,monospace`;
    c.fillText(`${this.opts.timeDivMs} ms/div · ${this.opts.channel} · ${this.opts.trigger}${this.singleHeld ? ' · HOLD' : ''}`, 8, 12 * (window.devicePixelRatio||1));

    if (this.opts.persistence > 0) {
      // snapshot for next frame
      try {
        this.persistImg = this.persistImg || document.createElement('canvas');
        this.persistImg.width = W; this.persistImg.height = H;
        this.persistImg.getContext('2d').drawImage(this.canvas, 0, 0);
      } catch (e) {}
    }
  }

  // Export the frozen single-shot window when present, otherwise the current
  // rolling capture buffer, as a stereo 16-bit PCM WAV.
  exportWav() {
    const data = this.singleHeld && this.captured ? this.captured : this.getCapture();
    if (!data) return;
    const wav = encodeWav([data.l, data.r], data.sr);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `scope-${Date.now()}.wav`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Minimal WAV encoder for Float32 [-1, 1] channel arrays.
function encodeWav(channels, sr) {
  const N = channels[0].length;
  const numCh = channels.length;
  const bytesPerSample = 2;
  const buf = new ArrayBuffer(44 + N * numCh * bytesPerSample);
  const dv = new DataView(buf);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + N * numCh * bytesPerSample, true);
  wstr(8, 'WAVE'); wstr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * numCh * bytesPerSample, true);
  dv.setUint16(32, numCh * bytesPerSample, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, N * numCh * bytesPerSample, true);
  let off = 44;
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}
