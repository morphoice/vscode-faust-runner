// FFT and window helpers used by the spectrum analyzer.
//
// This is a compact radix-2 Cooley-Tukey implementation tuned for repeated
// browser-side analysis. It keeps lookup tables and work buffers on the instance
// so analyzer frames do not allocate during steady-state rendering.

export class FFT {
  // N must be a power of two. The constructor precomputes twiddle factors and
  // bit-reversal indexes for all subsequent forward transforms.
  constructor(N) {
    if ((N & (N - 1)) !== 0) throw new Error('FFT size must be power of 2: ' + N);
    this.N = N;
    this.logN = Math.log2(N);
    this.cos = new Float32Array(N / 2);
    this.sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / N);
      this.sin[i] = Math.sin(-2 * Math.PI * i / N);
    }
    this.rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let j = 0, x = i;
      for (let b = 0; b < this.logN; b++) { j = (j << 1) | (x & 1); x >>= 1; }
      this.rev[i] = j;
    }
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
  }

  // Transform a real-valued Float32Array of length N. Results are stored in
  // this.re/this.im for the full complex spectrum.
  forward(input) {
    const N = this.N;
    const re = this.re, im = this.im;
    for (let i = 0; i < N; i++) { re[this.rev[i]] = input[i]; im[i] = 0; }
    for (let i = 0; i < N; i++) im[this.rev[i]] = 0;

    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const k = i + j;
          const l = k + half;
          const tIdx = j * step;
          const c = this.cos[tIdx], s = this.sin[tIdx];
          const xr = re[l] * c - im[l] * s;
          const xi = re[l] * s + im[l] * c;
          re[l] = re[k] - xr;
          im[l] = im[k] - xi;
          re[k] += xr;
          im[k] += xi;
        }
      }
    }
  }

  // Apply an optional window, run the FFT, and write a one-sided dBFS magnitude
  // spectrum into outMagDb. Coherent-gain normalization keeps sine amplitudes
  // readable across different window functions.
  magnitudeDb(input, window, outMagDb, floor = -140) {
    const N = this.N;
    const wIn = new Float32Array(N);
    if (window) {
      let wsum = 0;
      for (let i = 0; i < N; i++) { wIn[i] = input[i] * window[i]; wsum += window[i]; }
      this.forward(wIn);
      // normalize by coherent gain (sum of window) for accurate amplitude
      const norm = 2 / wsum;
      for (let k = 0; k <= N / 2; k++) {
        const r = this.re[k] * norm;
        const i = this.im[k] * norm;
        const mag = Math.sqrt(r * r + i * i);
        outMagDb[k] = mag > 0 ? Math.max(20 * Math.log10(mag), floor) : floor;
      }
    } else {
      this.forward(input);
      const norm = 2 / N;
      for (let k = 0; k <= N / 2; k++) {
        const r = this.re[k] * norm;
        const i = this.im[k] * norm;
        const mag = Math.sqrt(r * r + i * i);
        outMagDb[k] = mag > 0 ? Math.max(20 * Math.log10(mag), floor) : floor;
      }
    }
  }
}

// Window functions for the analyzer. All windows are length N and peak at 1.
export function makeWindow(type, N) {
  const w = new Float32Array(N);
  switch (type) {
    case 'rect':
      w.fill(1); break;
    case 'hann':
      for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      break;
    case 'hamming':
      for (let i = 0; i < N; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));
      break;
    case 'blackman':
      for (let i = 0; i < N; i++) {
        const x = 2 * Math.PI * i / (N - 1);
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      }
      break;
    case 'blackman-harris': {
      const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
      for (let i = 0; i < N; i++) {
        const x = 2 * Math.PI * i / (N - 1);
        w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
      }
      break;
    }
    case 'flat-top': {
      // SR 785 5-term flat-top, accurate amplitude reads
      const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158, a3 = 0.083578947, a4 = 0.006947368;
      for (let i = 0; i < N; i++) {
        const x = 2 * Math.PI * i / (N - 1);
        w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x) + a4 * Math.cos(4 * x);
      }
      break;
    }
    case 'kaiser': {
      // beta = 8.6 (about -90 dB sidelobes)
      const beta = 8.6;
      const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 25; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
      const denom = i0(beta);
      for (let i = 0; i < N; i++) {
        const r = (2 * i) / (N - 1) - 1;
        w[i] = i0(beta * Math.sqrt(1 - r * r)) / denom;
      }
      break;
    }
    default:
      w.fill(1);
  }
  return w;
}
