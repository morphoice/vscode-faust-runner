// Source signal generators for the runner's "Src" selector.
//
// Each builder returns a started AudioNode that main.js can connect to the input
// capture worklet. Synthetic sources are mono; downstream Web Audio nodes
// duplicate or split channels as needed.

// Looping white or pink noise buffer. Pink noise uses Paul Kellett's lightweight
// filter approximation, good enough for voicing and transfer-response checks.
export function makeNoise(ctx, type) {
  const sr = ctx.sampleRate;
  const bufLen = sr * 2;
  const buf = ctx.createBuffer(1, bufLen, sr);
  const d = buf.getChannelData(0);
  if (type === 'white') {
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
  } else {
    // Paul Kellett pink noise
    let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
    for (let i = 0; i < bufLen; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true; src.start();
  return src;
}

// Simple oscillator source for quick level and filter checks.
export function makeSine(ctx, hz = 440) {
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.value = hz; o.start();
  return o;
}

// Looping logarithmic sweep. The waveform is generated into a buffer so it can
// be treated like every other finite Web Audio source.
export function makeSweep(ctx, fStart = 20, fEnd = 20000, durSec = 4) {
  const sr = ctx.sampleRate;
  const N = Math.floor(sr * durSec);
  const buf = ctx.createBuffer(1, N, sr);
  const d = buf.getChannelData(0);
  const k = Math.log(fEnd / fStart);
  let phase = 0;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const f = fStart * Math.exp(k * t / durSec);
    phase += 2 * Math.PI * f / sr;
    d[i] = Math.sin(phase) * 0.95;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true; src.start();
  return src;
}

// One-sample impulse repeated at a fixed rate, useful for envelope and impulse
// response inspection in the scope/analyzer.
export function makeImpulse(ctx, perSec = 1) {
  const sr = ctx.sampleRate;
  const N = Math.floor(sr / perSec);
  const buf = ctx.createBuffer(1, N, sr);
  buf.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true; src.start();
  return src;
}

// Short shaped click train. The half-sine click avoids a hard discontinuity at
// the end of the pulse while still being easy to trigger from.
export function makeClickTrain(ctx, perSec = 10, widthMs = 0.5) {
  const sr = ctx.sampleRate;
  const N = Math.floor(sr / perSec);
  const wN = Math.max(1, Math.floor(sr * widthMs / 1000));
  const buf = ctx.createBuffer(1, N, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < wN; i++) d[i] = Math.sin(Math.PI * i / wN);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true; src.start();
  return src;
}

// Microphone/input-device source with processing disabled so measurements are
// not distorted by browser echo cancellation or automatic gain.
export async function makeMic(ctx, deviceId) {
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const node = ctx.createMediaStreamSource(stream);
  node._stream = stream;
  return node;
}

// BufferSource helper for decoded audio files. BufferSource nodes are one-shot,
// so main.js recreates them whenever playback restarts.
export async function makeFile(ctx, audioBuffer, loop = true) {
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.loop = loop;
  src.start();
  return src;
}

// Decode bytes received from the extension host or file drop into an AudioBuffer.
export async function decodeBytes(ctx, bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return ctx.decodeAudioData(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

// Stop, disconnect, and release any backing MediaStream tracks for a source.
export function disposeSource(node) {
  if (!node) return;
  try { node.stop && node.stop(); } catch (e) {}
  try { node.disconnect(); } catch (e) {}
  if (node._stream) for (const t of node._stream.getTracks()) t.stop();
}
