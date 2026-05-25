// Orchestrator: load @grame/faustwasm, compile current .dsp, build audio graph:
//   source -> captureIn -> faustNode -> captureOut -> destination
// Wire MIDI events into the poly node (or directly to freq/gain/gate for mono).
// Hot-reload on save messages from the extension host.

import { Scope } from './scope.js';
import { Analyzer } from './analyzer.js';
import { MidiHub } from './midi.js';
import {
  makeNoise, makeSine, makeSweep, makeImpulse, makeClickTrain,
  makeMic, makeFile, decodeBytes, disposeSource
} from './signals.js';

const FAUST_CDN  = 'https://cdn.jsdelivr.net/npm/@grame/faustwasm@0.16.2';
const FAUSTUI_CDN = 'https://cdn.jsdelivr.net/npm/@shren/faust-ui@1';

const vscode = acquireVsCodeApi();

const ui = {
  play: document.getElementById('play'),
  panic: document.getElementById('panic'),
  recompile: document.getElementById('recompile'),
  svgToggle: document.getElementById('svgToggle'),
  svgPanel: document.getElementById('svgPanel'),
  svgSelect: document.getElementById('svgSelect'),
  svgZoomOut: document.getElementById('svgZoomOut'),
  svgZoomReset: document.getElementById('svgZoomReset'),
  svgZoomIn: document.getElementById('svgZoomIn'),
  svgRefresh: document.getElementById('svgRefresh'),
  svgClose: document.getElementById('svgClose'),
  svgCanvas: document.getElementById('svgCanvas'),
  svgEmpty: document.getElementById('svgEmpty'),
  srcKind: document.getElementById('srcKind'),
  srcFile: document.getElementById('srcFile'),
  srcLoop: document.getElementById('srcLoop'),
  srcLoopLbl: document.getElementById('srcLoopLbl'),
  srcDevice: document.getElementById('srcDevice'),
  srcDeviceRefresh: document.getElementById('srcDeviceRefresh'),
  polyOn: document.getElementById('polyOn'),
  midiOn: document.getElementById('midiOn'),
  midiPort: document.getElementById('midiPort'),
  status: document.getElementById('status'),
  faustUi: document.getElementById('faust-ui'),
  kbd: document.getElementById('kbd'),
  log: document.getElementById('log'),
  errBar: document.getElementById('errBar'),
  scope: document.getElementById('scope'),
  scopeCtl: document.getElementById('scopeCtl'),
  analyzer: document.getElementById('analyzer'),
  anaCtl: document.getElementById('anaCtl'),
};

const state = {
  ctx: null,
  faustModule: null,
  compiler: null,
  faustNode: null,
  faustUi: null,
  srcNode: null,
  captureIn: null,
  captureOut: null,
  latestIn: null,
  latestOut: null,
  outGain: null,
  midi: new MidiHub(),
  decodedFile: null,
  decodedFileName: null,
  dspCode: '',
  dspName: 'untitled',
  dspPath: '',
  svgMap: null,
  svgCodeKey: '',
  svgCurrent: '',
  svgZoom: 1,
  svgDragged: false,
  svgPointerLink: null,
  polyphonic: false,
  playing: false,
  sourceEnabled: true,
};

function log(msg, cls = '') {
  // Devtools console always; UI error bar only for crucial errors.
  if (cls === 'err') console.error('[faust] ' + msg);
  else if (cls === 'wrn') console.warn('[faust] ' + msg);
  else console.log('[faust] ' + msg);
  if (cls === 'err' && ui.log && ui.errBar) {
    const span = document.createElement('span');
    span.className = 'err';
    span.textContent = msg + '\n';
    ui.log.appendChild(span);
    ui.errBar.style.display = 'flex';
    if (ui.log.childNodes.length > 20) ui.log.removeChild(ui.log.firstChild);
    // Also surface critical errors in the extension's status bar
    try { vscode.postMessage({ type: 'info', text: msg, severity: 'err' }); } catch (e) {}
  }
}
function postInfo(msg, severity = '') {
  try { vscode.postMessage({ type: 'info', text: msg, severity }); } catch (e) {}
}
document.getElementById('errDismiss')?.addEventListener('click', () => {
  if (ui.log) ui.log.innerHTML = '';
  if (ui.errBar) ui.errBar.style.display = 'none';
});
function setStatus(text, cls = '') { ui.status.textContent = text; ui.status.className = 'status ' + cls; }

window.addEventListener('error', (e) => log('JS error: ' + e.message, 'err'));
window.addEventListener('unhandledrejection', (e) => log('Promise rejected: ' + (e.reason?.message || e.reason), 'err'));

const scope = new Scope(ui.scope, ui.scopeCtl, () => state.latestOut);
const analyzer = new Analyzer(ui.analyzer, ui.anaCtl, () => state.latestOut, () => state.latestIn);

state.midi.renderKbd(ui.kbd);

const midiRefreshBtn = document.getElementById('midiRefresh');
const hideHwMidi = (reason) => {
  if (ui.midiPort) ui.midiPort.style.display = 'none';
  if (midiRefreshBtn) midiRefreshBtn.style.display = 'none';
  if (reason) console.log('[faust] hw MIDI hidden: ' + reason + ' (QWERTY keyboard still works)');
};
// Hide the hardware-MIDI dropdown by default; only populate it when the user enables MIDI in
hideHwMidi();

let _midiInitialized = false;
function initMidiIfNeeded() {
  if (_midiInitialized) return;
  _midiInitialized = true;
  state.midi.init(ui.midiPort, (ev) => {
    if (!ui.midiOn.checked || !state.faustNode) return;
    routeMidi(ev);
  }, (avail, reason) => {
    if (avail) { ui.midiPort.style.display = ''; if (midiRefreshBtn) midiRefreshBtn.style.display = ''; }
    else hideHwMidi(reason);
  });
}

const kbdRow = document.getElementById('kbdRow');
const midiRefresh = document.getElementById('midiRefresh');
const POLY_KEY = 'faust-polyOn';
ui.polyOn.checked = localStorage.getItem(POLY_KEY) === '1';
ui.polyOn?.addEventListener('change', async () => {
  localStorage.setItem(POLY_KEY, ui.polyOn.checked ? '1' : '0');
  if (state.ctx && state.dspCode) await compileAndAttach({ recompileOnly: true });
});
const applyMidiUI = () => {
  kbdRow.style.display = ui.midiOn.checked ? 'block' : 'none';
  if (ui.midiOn.checked) initMidiIfNeeded();
};
ui.midiOn.addEventListener('change', applyMidiUI);
applyMidiUI();

midiRefresh?.addEventListener('click', () => { _midiInitialized = false; initMidiIfNeeded(); });

function routeMidi(ev) {
  const n = state.faustNode;
  if (!n) return;
  try {
    if (ev.type === 'noteon') {
      if (state.polyphonic && n.keyOn) n.keyOn(0, ev.midi, Math.round(ev.velocity * 127));
      else {
        trySet(n, 'freq', 440 * Math.pow(2, (ev.midi - 69) / 12));
        trySet(n, 'gain', ev.velocity);
        trySet(n, 'gate', 1);
      }
    } else if (ev.type === 'noteoff') {
      if (state.polyphonic && n.keyOff) n.keyOff(0, ev.midi, 0);
      else { trySet(n, 'gate', 0); }
    } else if (ev.type === 'cc') {
      n.ctrlChange && n.ctrlChange(0, ev.cc, Math.round(ev.value * 127));
    } else if (ev.type === 'bend') {
      n.pitchWheel && n.pitchWheel(0, Math.round((ev.value + 1) * 8192));
    }
  } catch (e) { log('midi route err: ' + e.message, 'wrn'); }
}

function trySet(n, paramSuffix, value) {
  const paths = (n.getParams ? n.getParams() : []) || [];
  const suffix = '/' + paramSuffix.toLowerCase();
  const match = paths.find(p => {
    const clean = p.toLowerCase().replace(/\[[^\]]*\]/g, '').trim();
    return clean.endsWith(suffix);
  });
  if (!match) return false;
  n.setParamValue(match, value);
  return true;
}

function flattenUiItems(items, out = []) {
  for (const item of items || []) {
    if (item.items) flattenUiItems(item.items, out);
    else out.push(item);
  }
  return out;
}

function cleanAddressTail(address) {
  return String(address || '').split('/').pop().replace(/\[[^\]]*\]/g, '').trim().toLowerCase();
}

function hasPolyVoiceControls(uiDescriptor) {
  const tails = new Set(flattenUiItems(uiDescriptor).map(item => cleanAddressTail(item.address)));
  return tails.has('freq') && tails.has('gate');
}

function getNvoices(meta) {
  const entries = Array.isArray(meta?.meta) ? meta.meta : [];
  for (const entry of entries) {
    const options = entry?.options;
    if (typeof options !== 'string') continue;
    const match = options.match(/\[nvoices:(\d+)\]/);
    if (match) return Math.max(1, parseInt(match[1], 10));
  }
  return -1;
}

function silenceCurrentNode() {
  const n = state.faustNode;
  if (!n) return;
  try {
    if (state.polyphonic && n.keyOff) {
      for (const midi of state.midi.activeNotes) n.keyOff(0, midi, 0);
    }
    if (n.allNotesOff) n.allNotesOff();
    trySet(n, 'gate', 0);
  } catch (e) {
    log('panic before recompile failed: ' + (e.message || e), 'wrn');
  }
  state.midi.clearActiveState();
}

// ---------- Faust ----------

async function ensureFaust() {
  if (state.compiler) return;
  setStatus('loading libfaust…');
  const mod = await import(`${FAUST_CDN}/dist/esm-bundle/index.js`);
  const { instantiateFaustModuleFromFile, LibFaust, FaustCompiler } = mod;
  const faustModule = await instantiateFaustModuleFromFile(`${FAUST_CDN}/libfaust-wasm/libfaust-wasm.js`);
  const libFaust = new LibFaust(faustModule);
  state.faustModule = mod;
  state.compiler = new FaustCompiler(libFaust);
  setStatus('libfaust ready', 'ok');
  log('libfaust loaded');
}

async function ensureCtx() {
  if (state.ctx) return;
  state.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

  const workletUrl = new URL('./capture-worklet.js', import.meta.url).toString();
  const attempts = [];

  // 1) direct URL
  try {
    await state.ctx.audioWorklet.addModule(workletUrl);
    log('worklet loaded (direct)');
  } catch (e1) {
    attempts.push('direct: ' + (e1.message || e1));
    // 2) fetch + blob URL
    try {
      const text = await fetch(workletUrl).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.text(); });
      const blob = new Blob([text], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try { await state.ctx.audioWorklet.addModule(blobUrl); log('worklet loaded (blob)'); }
      finally { URL.revokeObjectURL(blobUrl); }
    } catch (e2) {
      attempts.push('blob: ' + (e2.message || e2));
      // 3) inline data: URL
      try {
        const text = await fetch(workletUrl).then(r => r.text());
        const dataUrl = 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(text)));
        await state.ctx.audioWorklet.addModule(dataUrl);
        log('worklet loaded (data:)');
      } catch (e3) {
        attempts.push('data: ' + (e3.message || e3));
        throw new Error('addModule failed all paths — ' + attempts.join(' | '));
      }
    }
  }

  state.captureIn  = makeCapture(state.ctx, 'in');
  state.captureOut = makeCapture(state.ctx, 'out');
  state.captureOut.connect(state.ctx.destination);
  log(`audio context @ ${state.ctx.sampleRate} Hz`);
}

function makeCapture(ctx, tag) {
  const node = new AudioWorkletNode(ctx, 'faust-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { tag, size: 16384, passThrough: true, postIntervalSec: 0.033 },
  });
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.tag === 'in')  state.latestIn  = { l: d.l, r: d.r, sr: d.sr };
    if (d.tag === 'out') state.latestOut = { l: d.l, r: d.r, sr: d.sr };
  };
  return node;
}

// ---------- SVG block diagrams ----------

function setSvgVisible(visible) {
  if (!ui.svgPanel) return;
  ui.svgPanel.style.display = visible ? 'flex' : 'none';
}

function svgCodeKey() {
  return `${state.dspName}\n${state.dspCode}`;
}

function orderedSvgNames(svgMap) {
  return Object.keys(svgMap || {}).sort((a, b) => {
    if (a === 'process.svg') return -1;
    if (b === 'process.svg') return 1;
    return a.localeCompare(b);
  });
}

function normalizeSvgName(href) {
  if (!href) return '';
  const noHash = String(href).split('#')[0];
  const file = noHash.slice(noHash.lastIndexOf('/') + 1);
  try { return decodeURIComponent(file); }
  catch (e) { return file; }
}

function findSvgName(href) {
  const name = normalizeSvgName(href);
  if (!name || !state.svgMap) return '';
  if (state.svgMap[name]) return name;
  const match = Object.keys(state.svgMap).find(k => normalizeSvgName(k) === name);
  return match || '';
}

function getSvgLinkHref(link) {
  if (!link) return '';
  return link.getAttribute('href')
    || link.getAttribute('xlink:href')
    || link.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    || link.href?.baseVal
    || '';
}

function applySvgZoom() {
  const svg = ui.svgCanvas?.querySelector('svg');
  if (!svg) return;
  svg.style.width = `${Math.round(state.svgZoom * 100)}%`;
  svg.style.maxWidth = 'none';
  svg.style.height = 'auto';
}

function renderSvgDiagram(name) {
  const svg = state.svgMap && state.svgMap[name];
  if (!svg) {
    if (ui.svgCanvas) ui.svgCanvas.innerHTML = '';
    if (ui.svgEmpty) ui.svgEmpty.style.display = 'flex';
    return;
  }
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.documentElement;
  if (!svgEl || svgEl.nodeName.toLowerCase() !== 'svg') {
    log(`svg: ${name} did not contain an SVG root`, 'wrn');
    return;
  }
  ui.svgCanvas.innerHTML = '';
  ui.svgCanvas.appendChild(document.importNode(svgEl, true));
  state.svgCurrent = name;
  if (ui.svgSelect && ui.svgSelect.value !== name) ui.svgSelect.value = name;
  applySvgZoom();
  if (ui.svgEmpty) ui.svgEmpty.style.display = 'none';
}

function populateSvgSelect(names) {
  ui.svgSelect.innerHTML = '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    ui.svgSelect.appendChild(opt);
  }
}

async function generateSvgDiagrams({ force = false } = {}) {
  if (!state.dspCode) {
    log('svg: no DSP code loaded', 'wrn');
    return;
  }
  const key = svgCodeKey();
  if (!force && state.svgMap && state.svgCodeKey === key) return;

  await ensureFaust();
  const SvgDiagrams = state.faustModule.FaustSvgDiagrams;
  if (!SvgDiagrams) throw new Error('FaustSvgDiagrams is not available in this faustwasm build');

  setStatus('generating SVG...');
  const svgDiagrams = new SvgDiagrams(state.compiler);
  const rawSvgs = svgDiagrams.from(state.dspName, state.dspCode, '-I libraries/');
  const svgs = rawSvgs instanceof Map ? Object.fromEntries(rawSvgs) : rawSvgs;
  const names = orderedSvgNames(svgs);
  if (!names.length) throw new Error('no SVG diagrams were generated');

  state.svgMap = svgs;
  state.svgCodeKey = key;
  populateSvgSelect(names);
  ui.svgSelect.value = names.includes('process.svg') ? 'process.svg' : names[0];
  renderSvgDiagram(ui.svgSelect.value);
  setStatus(`SVG ${names.length} diagram${names.length > 1 ? 's' : ''}`, 'ok');
  log(`generated SVG diagrams: ${names.join(', ')}`);
}

async function compileAndAttach({ recompileOnly = false } = {}) {
  if (!state.dspCode) { log('no DSP code yet', 'wrn'); return; }
  await ensureFaust();
  await ensureCtx();

  setStatus('compiling…');
  try {
    const { FaustMonoDspGenerator, FaustPolyDspGenerator } = state.faustModule;
    let gen = new FaustMonoDspGenerator();
    await gen.compile(state.compiler, state.dspName, state.dspCode, '-I libraries/');
    let descriptor = [];
    try { descriptor = gen.getUI ? gen.getUI() : []; } catch (e) {}
    let meta = null;
    try { meta = gen.getMeta ? gen.getMeta() : null; } catch (e) {}
    const configuredVoices = Math.max(1, Number(window.__faustInit?.voices || 8));
    const declaredVoices = getNvoices(meta);
    const voices = declaredVoices > 0 ? declaredVoices : configuredVoices;
    // [nvoices:1] is HISE's "monophonic + MIDI" hint, not a poly request — only force poly for N>1.
    const usePoly = declaredVoices > 1 || (!!ui.polyOn?.checked && voices > 1 && hasPolyVoiceControls(descriptor));

    if (usePoly) {
      gen = new FaustPolyDspGenerator();
      await gen.compile(state.compiler, state.dspName, state.dspCode, '-I libraries/');
    }

    const newNode = usePoly ? await gen.createNode(state.ctx, voices) : await gen.createNode(state.ctx);
    if (!newNode) throw new Error('createNode returned null (compile probably failed silently)');

    // disconnect old
    if (state.faustNode) {
      silenceCurrentNode();
      try { state.captureIn.disconnect(); } catch (e) {}
      try { state.faustNode.disconnect(); } catch (e) {}
      state.faustNode = null;
    }
    state.faustNode = newNode;
    state.polyphonic = usePoly;

    // wire: src -> captureIn -> faust -> captureOut
    rewireSource();

    // build UI
    await buildFaustUI(newNode);
    if (ui.svgPanel && ui.svgPanel.style.display !== 'none') {
      try { await generateSvgDiagrams({ force: true }); } catch (e) { log('svg failed: ' + (e.message || e), 'err'); }
    }

    setStatus(recompileOnly ? 'recompiled ✓' : 'compiled ✓', 'ok');
    const mode = usePoly ? `poly ${voices} voices` : 'mono';
    log(`compiled "${state.dspName}" (${newNode.getNumInputs()}→${newNode.getNumOutputs()}) [${mode}]`, 'ok');
    postInfo(`Faust: ${recompileOnly ? 'recompiled' : 'compiled'} ${state.dspName} (${newNode.getNumInputs()}→${newNode.getNumOutputs()}, ${mode})`, 'ok');
  } catch (e) {
    setStatus('compile error', 'err');
    log('compile failed: ' + (e.message || e), 'err');
    postInfo('Faust: compile failed — ' + (e.message || e), 'err');
    // try to pull diagnostics
    try {
      const diag = state.compiler.getErrorMessage && state.compiler.getErrorMessage();
      if (diag) log(diag, 'err');
    } catch (e2) {}
  }
}

async function buildFaustUI(node) {
  ui.faustUi.innerHTML = '';
  state.meterUpdaters = [];

  // node.getUI() returns the Faust UI descriptor (array of root items)
  let descriptor = [];
  try {
    descriptor = node.getUI ? node.getUI() : [];
    if (descriptor && !Array.isArray(descriptor) && descriptor.ui) descriptor = descriptor.ui;
  } catch (e) { log('getUI failed: ' + e.message, 'wrn'); }

  if (!descriptor.length) {
    ui.faustUi.innerHTML = '<span style="color:var(--mut)">no parameters</span>';
    return;
  }

  for (const item of descriptor) renderUiItem(item, ui.faustUi, node);

  if (state.meterUpdaters.length) {
    if (state.meterInterval) clearInterval(state.meterInterval);
    state.meterInterval = setInterval(() => {
      for (const f of state.meterUpdaters) f();
    }, 50);
  }
}

function cleanLabel(label) {
  if (!label) return '';
  return label.replace(/\[[^\]]*\]/g, '').trim() || label;
}

function renderUiItem(item, parent, node) {
  const type = item.type;
  if (type === 'vgroup' || type === 'hgroup' || type === 'tgroup') {
    // Flatten groups entirely — render their contents straight into the parent (no label, no wrapper)
    for (const child of (item.items || [])) renderUiItem(child, parent, node);
    return;
  }
  if (type === 'hslider' || type === 'vslider') {
    parent.appendChild(makeKnob(item, node));
  } else if (type === 'nentry') {
    parent.appendChild(makeNentry(item, node));
  } else if (type === 'button') {
    parent.appendChild(makeButton(item, node));
  } else if (type === 'checkbox') {
    parent.appendChild(makeCheckbox(item, node));
  } else if (type === 'hbargraph' || type === 'vbargraph') {
    parent.appendChild(makeMeter(item, node));
  }
}

function makeKnob(item, node) {
  const wrap = document.createElement('div');
  wrap.className = 'fui-ctl fui-knob';
  const path = item.address;
  const init = +item.init, min = +item.min, max = +item.max;
  const step = +item.step || (max - min) / 1000;
  const isLog = /\[scale:log\]/i.test(item.label || '') && min > 0 && max > 0;

  const toNorm   = (v) => isLog ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min);
  const fromNorm = (n) => isLog ? Math.exp(Math.log(min) + n * (Math.log(max) - Math.log(min))) : min + n * (max - min);
  const decs = step >= 1 ? 0 : Math.min(4, Math.max(0, -Math.floor(Math.log10(step))));
  const fmt = (v) => (+v).toFixed(decs);

  const head = document.createElement('div'); head.className = 'fui-head';
  const lbl = document.createElement('span'); lbl.className = 'fui-lbl';
  lbl.textContent = cleanLabel(item.label);
  const val = document.createElement('span'); val.className = 'fui-val';
  head.append(lbl, val);

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const SIZE = 58;
  const knob = document.createElement('canvas');
  knob.width = SIZE * dpr; knob.height = SIZE * dpr;
  knob.style.width = SIZE + 'px'; knob.style.height = SIZE + 'px';
  knob.className = 'fui-knob-canvas';
  knob.tabIndex = 0;

  let current = init;
  const draw = () => {
    const ctx = knob.getContext('2d');
    const W = knob.width, H = knob.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 6 * dpr;
    const start = Math.PI * 0.75, end = Math.PI * 2.25;
    const n = Math.max(0, Math.min(1, toNorm(current)));
    const va = start + n * (end - start);
    const cs = getComputedStyle(document.body);
    const trackCol = cs.getPropertyValue('--m-track').trim() || '#3A2A45';
    const arcCol   = cs.getPropertyValue('--m-acc').trim()   || '#C568CC';
    const indCol   = cs.getPropertyValue('--m-fg').trim()    || '#E7DCF0';
    // track
    ctx.strokeStyle = trackCol; ctx.lineWidth = 5 * dpr; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r, start, end); ctx.stroke();
    // value arc
    ctx.strokeStyle = arcCol;
    ctx.beginPath(); ctx.arc(cx, cy, r, start, va); ctx.stroke();
    // indicator
    ctx.strokeStyle = indCol; ctx.lineWidth = 3.5 * dpr; ctx.lineCap = 'round';
    const inR = r - 11 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(va) * inR, cy + Math.sin(va) * inR);
    ctx.lineTo(cx + Math.cos(va) * (r - 1 * dpr), cy + Math.sin(va) * (r - 1 * dpr));
    ctx.stroke();
  };

  const apply = (v) => {
    current = Math.max(min, Math.min(max, +v));
    try { node.setParamValue(path, current); } catch (e) { log('setParam failed: ' + e.message, 'err'); }
    val.textContent = fmt(current);
    draw();
  };

  let dragY = null, dragValue = 0;
  knob.addEventListener('pointerdown', (e) => {
    dragY = e.clientY; dragValue = current;
    knob.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  knob.addEventListener('pointermove', (e) => {
    if (dragY == null) return;
    const dy = dragY - e.clientY;                 // up = increase
    const sens = e.shiftKey ? 0.0015 : 0.0075;    // per pixel of normalized range
    const newNorm = toNorm(dragValue) + dy * sens;
    apply(fromNorm(Math.max(0, Math.min(1, newNorm))));
  });
  const release = (e) => { dragY = null; try { knob.releasePointerCapture(e.pointerId); } catch (_) {} };
  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', release);
  knob.addEventListener('lostpointercapture', () => { dragY = null; });
  knob.addEventListener('dblclick', () => apply(init));
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sens = e.shiftKey ? 0.0008 : 0.004;
    const newNorm = toNorm(current) + (-e.deltaY) * sens;
    apply(fromNorm(Math.max(0, Math.min(1, newNorm))));
  }, { passive: false });

  // initial value from live node
  try {
    const live = node.getParamValue ? node.getParamValue(path) : init;
    apply(typeof live === 'number' && !Number.isNaN(live) ? live : init);
  } catch (e) { apply(init); }

  lbl.title = `${cleanLabel(item.label)} — default ${fmt(init)} · range ${fmt(min)}..${fmt(max)}${isLog ? ' · log' : ''}\ndrag↑↓ / wheel · shift = fine · dblclick = reset`;
  knob.title = lbl.title;

  wrap.append(head, knob);
  return wrap;
}

function makeNentry(item, node) {
  const wrap = document.createElement('div');
  wrap.className = 'fui-ctl fui-nentry';
  const init = +item.init, min = +item.min, max = +item.max, step = +item.step || 1;
  const head = document.createElement('div'); head.className = 'fui-head';
  const lbl = document.createElement('span'); lbl.className = 'fui-lbl'; lbl.textContent = cleanLabel(item.label);
  head.appendChild(lbl);
  const num = document.createElement('input');
  num.type = 'number'; num.min = min; num.max = max; num.step = step;
  num.value = (() => { try { return node.getParamValue(item.address); } catch (e) { return init; } })();
  num.className = 'fui-nentry-input';
  num.addEventListener('input', () => { try { node.setParamValue(item.address, +num.value); } catch (e) {} });
  num.addEventListener('dblclick', () => { num.value = init; node.setParamValue(item.address, init); });
  wrap.append(head, num);
  return wrap;
}

function makeButton(item, node) {
  const wrap = document.createElement('div');
  wrap.className = 'fui-ctl fui-button';
  const b = document.createElement('button');
  b.textContent = cleanLabel(item.label);
  const press   = () => { try { node.setParamValue(item.address, 1); } catch (e) {} b.classList.add('on'); };
  const release = () => { try { node.setParamValue(item.address, 0); } catch (e) {} b.classList.remove('on'); };
  b.addEventListener('pointerdown', press);
  b.addEventListener('pointerup', release);
  b.addEventListener('pointerleave', () => b.classList.contains('on') && release());
  wrap.appendChild(b);
  return wrap;
}

function makeCheckbox(item, node) {
  const wrap = document.createElement('label');
  wrap.className = 'fui-ctl fui-checkbox';
  const c = document.createElement('input'); c.type = 'checkbox';
  c.checked = !!(+item.init);
  c.addEventListener('change', () => { try { node.setParamValue(item.address, c.checked ? 1 : 0); } catch (e) {} });
  wrap.appendChild(c);
  wrap.appendChild(document.createTextNode(' ' + cleanLabel(item.label)));
  return wrap;
}

function makeMeter(item, node) {
  const wrap = document.createElement('div');
  wrap.className = 'fui-ctl fui-meter';
  const head = document.createElement('div'); head.className = 'fui-head';
  const lbl = document.createElement('span'); lbl.className = 'fui-lbl'; lbl.textContent = cleanLabel(item.label);
  const val = document.createElement('span'); val.className = 'fui-val';
  head.append(lbl, val);
  const bar = document.createElement('div'); bar.className = 'fui-bar';
  const fill = document.createElement('div'); fill.className = 'fui-bar-fill';
  bar.appendChild(fill);
  wrap.append(head, bar);
  const min = +item.min, max = +item.max;
  state.meterUpdaters.push(() => {
    try {
      const v = node.getParamValue(item.address);
      const t = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
      fill.style.width = (t * 100).toFixed(1) + '%';
      val.textContent = (+v).toFixed(2);
    } catch (e) {}
  });
  return wrap;
}

// ---------- Source switching ----------

function rewireSource() {
  // tear down old
  if (state.srcNode) { try { state.srcNode.disconnect(); } catch (e) {} disposeSource(state.srcNode); state.srcNode = null; }
  try { state.captureIn.disconnect(); } catch (e) {}

  const kind = ui.srcKind.value;
  const numInputs = state.faustNode ? state.faustNode.getNumInputs() : 0;

  const buildAndWire = (node) => {
    state.srcNode = node;
    if (state.sourceEnabled) try { node.connect(state.captureIn); } catch (e) {}
    if (numInputs > 0 && state.faustNode) {
      state.captureIn.connect(state.faustNode);
      state.faustNode.connect(state.captureOut);
    } else if (state.faustNode) {
      // synth-style: faustNode is the source, ignore input source for capture-in too
      state.faustNode.connect(state.captureOut);
    }
  };

  // If DSP has no audio inputs (synth), still set up captureIn from source for analyzer overlay,
  // but don't connect into the faust node.
  const noSrcRequired = (kind === 'silence');
  if (noSrcRequired) {
    if (state.faustNode && numInputs > 0) {
      // need silence
      const sil = state.ctx.createConstantSource(); sil.offset.value = 0; sil.start();
      buildAndWire(sil);
    } else if (state.faustNode) {
      state.faustNode.connect(state.captureOut);
    }
    return;
  }

  const finish = (node) => buildAndWire(node);
  switch (kind) {
    case 'noise-white': finish(makeNoise(state.ctx, 'white')); break;
    case 'noise-pink':  finish(makeNoise(state.ctx, 'pink')); break;
    case 'sine':        finish(makeSine(state.ctx, 440)); break;
    case 'sweep':       finish(makeSweep(state.ctx, 20, 20000, 4)); break;
    case 'impulse':     finish(makeImpulse(state.ctx, 1)); break;
    case 'click':       finish(makeClickTrain(state.ctx, 10)); break;
    case 'mic':
      makeMic(state.ctx, ui.srcDevice.value || undefined)
        .then(finish)
        .catch(e => log('mic: ' + e.message, 'err'));
      break;
    case 'file':
      if (state.decodedFile) {
        makeFile(state.ctx, state.decodedFile, !!ui.srcLoop.checked).then((src) => {
          src.onended = () => {
            if (state.srcNode !== src) return;
            if (!ui.srcLoop.checked) {
              // File finished playing — source feed effectively stops, master keeps rendering.
              state.sourceEnabled = false;
              syncPanelButton();
              setStatus('source ended');
              postInfo('Faust: source ended');
            }
          };
          finish(src);
        });
      } else {
        vscode.postMessage({ type: 'pickFile' });
      }
      break;
  }
  const browseBtn = document.getElementById('srcFilePick');
  if (browseBtn) browseBtn.style.display = (kind === 'file') ? '' : 'none';
  if (ui.srcLoopLbl) ui.srcLoopLbl.style.display = (kind === 'file') ? '' : 'none';
  if (ui.srcDevice) ui.srcDevice.style.display = (kind === 'mic') ? '' : 'none';
  if (ui.srcDeviceRefresh) ui.srcDeviceRefresh.style.display = (kind === 'mic') ? '' : 'none';
  if (kind === 'mic' && !state._devicesEnumerated) enumerateInputDevices();
}

const SRC_DEVICE_KEY = 'faust-srcDevice';
async function enumerateInputDevices() {
  try {
    // First call getUserMedia to obtain permission so device labels are populated
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    ui.srcDevice.innerHTML = '';
    if (!inputs.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'no inputs found';
      ui.srcDevice.appendChild(opt); ui.srcDevice.disabled = true;
      return;
    }
    ui.srcDevice.disabled = false;
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${d.deviceId.slice(0, 6)}`;
      ui.srcDevice.appendChild(opt);
    }
    const saved = localStorage.getItem(SRC_DEVICE_KEY);
    if (saved && inputs.some(d => d.deviceId === saved)) ui.srcDevice.value = saved;
    state._devicesEnumerated = true;
  } catch (e) {
    ui.srcDevice.innerHTML = '<option>permission denied / no input</option>';
    ui.srcDevice.disabled = true;
    log('input enumeration failed: ' + (e.message || e), 'wrn');
  }
}
ui.srcDevice?.addEventListener('change', () => {
  localStorage.setItem(SRC_DEVICE_KEY, ui.srcDevice.value);
  if (state.ctx && ui.srcKind.value === 'mic') rewireSource();
});
ui.srcDeviceRefresh?.addEventListener('click', () => { state._devicesEnumerated = false; enumerateInputDevices(); });

// Restore the saved source kind from a previous session
const SRC_KIND_KEY = 'faust-srcKind';
const savedKind = localStorage.getItem(SRC_KIND_KEY);
if (savedKind && [...ui.srcKind.options].some(o => o.value === savedKind)) {
  ui.srcKind.value = savedKind;
  if (savedKind === 'file') vscode.postMessage({ type: 'requestLastAudio' });
  if (savedKind === 'mic') {
    if (ui.srcDevice) ui.srcDevice.style.display = '';
    if (ui.srcDeviceRefresh) ui.srcDeviceRefresh.style.display = '';
    // Defer enumeration to the first user gesture so we don't auto-prompt for mic permission on reload
  }
}

let _wasFileBeforeOpen = false;
ui.srcKind.addEventListener('pointerdown', () => { _wasFileBeforeOpen = (ui.srcKind.value === 'file'); });
ui.srcKind.addEventListener('mousedown',   () => { _wasFileBeforeOpen = (ui.srcKind.value === 'file'); });
ui.srcKind.addEventListener('change', () => {
  _wasFileBeforeOpen = false;
  localStorage.setItem(SRC_KIND_KEY, ui.srcKind.value);
  if (state.ctx) rewireSource();
});
// Native <select> doesn't fire change when the same option is reselected;
// detect that case via focusout and re-trigger the picker.
ui.srcKind.addEventListener('focusout', () => {
  if (_wasFileBeforeOpen && ui.srcKind.value === 'file') {
    _wasFileBeforeOpen = false;
    vscode.postMessage({ type: 'pickFile' });
  }
});
const browseBtn = document.getElementById('srcFilePick');
if (browseBtn) browseBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickFile' }));
ui.recompile.addEventListener('click', () => compileAndAttach({ recompileOnly: true }));
ui.svgToggle?.addEventListener('click', async () => {
  const visible = ui.svgPanel && ui.svgPanel.style.display !== 'none';
  setSvgVisible(!visible);
  if (!visible) {
    try { await generateSvgDiagrams(); } catch (e) { log('svg failed: ' + (e.message || e), 'err'); }
  }
});
ui.svgClose?.addEventListener('click', () => setSvgVisible(false));
ui.svgRefresh?.addEventListener('click', async () => {
  try { await generateSvgDiagrams({ force: true }); } catch (e) { log('svg failed: ' + (e.message || e), 'err'); }
});
ui.svgSelect?.addEventListener('change', () => renderSvgDiagram(ui.svgSelect.value));
ui.svgZoomOut?.addEventListener('click', () => {
  state.svgZoom = Math.max(0.25, state.svgZoom / 1.25);
  applySvgZoom();
});
ui.svgZoomReset?.addEventListener('click', () => {
  state.svgZoom = 1;
  applySvgZoom();
});
ui.svgZoomIn?.addEventListener('click', () => {
  state.svgZoom = Math.min(8, state.svgZoom * 1.25);
  applySvgZoom();
});
ui.svgCanvas?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const viewport = ui.svgCanvas.parentElement;
  if (!viewport) return;
  state.svgDragged = false;
  state.svgPointerLink = e.target.closest && e.target.closest('a');
  ui.svgCanvas.classList.add('dragging');
  const startX = e.clientX, startY = e.clientY;
  const startLeft = viewport.scrollLeft, startTop = viewport.scrollTop;
  const move = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) state.svgDragged = true;
    viewport.scrollLeft = startLeft - dx;
    viewport.scrollTop = startTop - dy;
  };
  const up = (ev) => {
    ui.svgCanvas.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!state.svgDragged && state.svgPointerLink) {
      const href = getSvgLinkHref(state.svgPointerLink);
      const name = findSvgName(href);
      if (name) renderSvgDiagram(name);
      else log(`svg: missing linked diagram ${normalizeSvgName(href) || href}`, 'wrn');
      try { state.svgPointerLink.blur(); } catch (e) {}
    }
    state.svgPointerLink = null;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
ui.svgCanvas?.parentElement?.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  state.svgZoom = Math.max(0.25, Math.min(8, state.svgZoom * (e.deltaY > 0 ? 0.8 : 1.25)));
  applySvgZoom();
}, { passive: false });
ui.srcLoop.addEventListener('change', () => { if (state.ctx && ui.srcKind.value === 'file') rewireSource(); });
ui.panic.addEventListener('click', () => {
  state.midi.allNotesOff();
  if (state.faustNode && state.faustNode.allNotesOff) state.faustNode.allNotesOff();
});

// Master play/stop — invoked by the editor title-bar ▶/⏹ command and by autoplay.
async function startPlayback() {
  await ensureCtx();
  if (state.ctx.state === 'suspended') {
    try { await Promise.race([state.ctx.resume(), new Promise(r => setTimeout(r, 500))]); } catch (e) {}
  }
  if (!state.faustNode) await compileAndAttach();
  // For audio file source, every play press restarts the buffer from 0 (BufferSource is one-shot)
  if (ui.srcKind.value === 'file' && state.decodedFile) rewireSource();
  state.playing = true;
  setStatus('playing', 'ok');
  syncPanelButton();
  vscode.postMessage({ type: 'state', playing: true });
}
async function stopPlayback() {
  if (state.ctx) try { await state.ctx.suspend(); } catch (e) {}
  state.playing = false;
  setStatus('stopped');
  syncPanelButton();
  vscode.postMessage({ type: 'state', playing: false });
}

// Panel button — toggles the SOURCE feed into Faust only.
// Faust keeps rendering; for synth DSPs the panel button is mostly cosmetic.
function syncPanelButton() {
  const audible = state.playing && state.sourceEnabled;
  ui.play.classList.toggle('on', audible);
  ui.play.textContent = audible ? 'Stop' : 'Play';
  ui.play.title = state.playing
    ? 'Toggle the source feeding into Faust (Faust keeps running). Use editor ▶/⏹ to start/stop everything.'
    : 'Start the runner with the editor ▶ button first';
}
function toggleSource() {
  // If master isn't running yet, this button should NOT start it — the editor ▶ button does that.
  // Just toggle the source-enabled flag and reflect it in the UI.
  if (!state.playing) {
    state.sourceEnabled = !state.sourceEnabled;
    syncPanelButton();
    return;
  }
  state.sourceEnabled = !state.sourceEnabled;
  if (state.srcNode && state.captureIn) {
    try {
      if (state.sourceEnabled) state.srcNode.connect(state.captureIn);
      else state.srcNode.disconnect(state.captureIn);
    } catch (e) {}
  }
  syncPanelButton();
}
ui.play.addEventListener('click', toggleSource);
syncPanelButton();

// ---------- Message bus ----------

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg.type === 'dspCode') {
    state.dspCode = msg.code;
    state.dspName = (msg.name || 'untitled').replace(/[^A-Za-z0-9_]/g, '_');
    state.dspPath = msg.path || '';
    state.svgMap = null;
    state.svgCodeKey = '';
    log(`loaded ${msg.name}${msg.reload ? ' (reload)' : ''}`);
    if (msg.autoplay) {
      // Editor ▶ pressed — always go through startPlayback to ensure ctx + resume + compile.
      // Reset stale playing state so we don't skip the resume on a kept-alive webview.
      if (state.playing && state.ctx && state.ctx.state === 'suspended') {
        state.playing = false;
      }
      await startPlayback();
      // If we kept the existing faust node, recompile with the latest source
      if (state.faustNode && state.dspCode) {
        try { await compileAndAttach({ recompileOnly: true }); } catch (e) {}
      }
    } else if (msg.reload && state.playing) {
      await compileAndAttach({ recompileOnly: true });
    } else if (state.playing) {
      await compileAndAttach();
    }
  } else if (msg.type === 'editorStop') {
    await stopPlayback();
  } else if (msg.type === 'editorPlay') {
    await startPlayback();
  } else if (msg.type === 'audioFile') {
    try {
      await ensureCtx();
      const ab = await decodeBytes(state.ctx, new Uint8Array(msg.bytes));
      state.decodedFile = ab;
      state.decodedFileName = msg.name;
      log(`decoded ${msg.name} (${ab.duration.toFixed(2)}s, ${ab.numberOfChannels}ch)`);
      if (!msg.silent) postInfo(`Faust: loaded ${msg.name} (${ab.duration.toFixed(2)}s)`);
      ui.srcKind.value = 'file';
      localStorage.setItem(SRC_KIND_KEY, 'file');
      rewireSource();
    } catch (e) { log('decode failed: ' + e.message, 'err'); }
  } else if (msg.type === 'log') {
    log(msg.text);
  }
});

// File drop into the panel for input audio
['dragover','dragenter'].forEach(t => window.addEventListener(t, (e) => e.preventDefault()));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files?.[0]; if (!f) return;
  const buf = await f.arrayBuffer();
  await ensureCtx();
  try {
    state.decodedFile = await state.ctx.decodeAudioData(buf);
    state.decodedFileName = f.name;
    log(`dropped ${f.name} (${state.decodedFile.duration.toFixed(2)}s)`);
    ui.srcKind.value = 'file';
    rewireSource();
  } catch (err) { log('drop decode: ' + err.message, 'err'); }
});

// Ask extension to send current DSP source
// Draggable splitter between params and scope/analyzer
const vresizer = document.getElementById('vresizer');
const hresizer = document.getElementById('hresizer');
const grid = document.getElementById('grid');
const PARAMS_KEY = 'faust-paramH';
const savedH = parseInt(localStorage.getItem(PARAMS_KEY) || '', 10);
if (!Number.isNaN(savedH) && savedH > 28) grid.style.setProperty('--paramH', savedH + 'px');
if (vresizer) {
  vresizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    vresizer.setPointerCapture(e.pointerId);
    vresizer.classList.add('dragging');
    const gridRect = grid.getBoundingClientRect();
    const move = (ev) => {
      const h = Math.max(28, Math.min(gridRect.height - 60, ev.clientY - gridRect.top));
      grid.style.setProperty('--paramH', h + 'px');
    };
    const up = (ev) => {
      vresizer.releasePointerCapture(ev.pointerId);
      vresizer.classList.remove('dragging');
      vresizer.removeEventListener('pointermove', move);
      vresizer.removeEventListener('pointerup', up);
      const h = parseInt(getComputedStyle(grid).getPropertyValue('--paramH'), 10);
      if (!Number.isNaN(h)) localStorage.setItem(PARAMS_KEY, String(h));
    };
    vresizer.addEventListener('pointermove', move);
    vresizer.addEventListener('pointerup', up);
  });
}

const SCOPE_W_KEY = 'faust-scopeW';
const savedScopeW = parseFloat(localStorage.getItem(SCOPE_W_KEY) || '');
if (!Number.isNaN(savedScopeW) && savedScopeW > 0.15 && savedScopeW < 0.85) {
  grid.style.setProperty('--scopeW', (savedScopeW * 100).toFixed(2) + '%');
}
if (hresizer) {
  hresizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hresizer.setPointerCapture(e.pointerId);
    hresizer.classList.add('dragging');
    const move = (ev) => {
      const gridRect = grid.getBoundingClientRect();
      const ratio = Math.max(0.18, Math.min(0.82, (ev.clientX - gridRect.left) / gridRect.width));
      grid.style.setProperty('--scopeW', (ratio * 100).toFixed(2) + '%');
    };
    const up = (ev) => {
      hresizer.releasePointerCapture(ev.pointerId);
      hresizer.classList.remove('dragging');
      hresizer.removeEventListener('pointermove', move);
      hresizer.removeEventListener('pointerup', up);
      const gridRect = grid.getBoundingClientRect();
      const left = hresizer.getBoundingClientRect().left - gridRect.left;
      const ratio = Math.max(0.18, Math.min(0.82, left / gridRect.width));
      localStorage.setItem(SCOPE_W_KEY, ratio.toFixed(4));
    };
    hresizer.addEventListener('pointermove', move);
    hresizer.addEventListener('pointerup', up);
  });
}

// Silently resume the audio context on any user gesture inside the panel
const _silentResume = () => { if (state.ctx && state.ctx.state === 'suspended') state.ctx.resume().catch(() => {}); };
document.addEventListener('pointerdown', _silentResume, true);
document.addEventListener('keydown', _silentResume, true);

vscode.postMessage({ type: 'requestDsp' });
setStatus('ready');
log('runner ready');
