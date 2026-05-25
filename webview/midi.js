// MIDI input (WebMIDI) + on-screen QWERTY keyboard.
// All note events are dispatched to `onEvent({type:'noteon'|'noteoff'|'cc'|'bend', ...})`.

export class MidiHub {
  constructor() {
    this.onEvent = null;
    this.access = null;
    this.activeInput = null;
    this.activeNotes = new Set();
    this.noteHolds = new Map();
    this.heldQwerty = new Map();
    this.pointerHolds = new Map();
    this.baseOctave = 2;
    this.numOctaves = 5;
    this.qwertyMap = {
      'a':0, 'w':1, 's':2, 'e':3, 'd':4, 'f':5, 't':6, 'g':7, 'y':8, 'h':9, 'u':10, 'j':11,
      'k':12, 'o':13, 'l':14, 'p':15, ';':16, "'":17
    };
    this.qwertyCodeMap = {
      KeyA:0, KeyW:1, KeyS:2, KeyE:3, KeyD:4, KeyF:5, KeyT:6, KeyG:7, KeyY:8, KeyH:9, KeyU:10, KeyJ:11,
      KeyK:12, KeyO:13, KeyL:14, KeyP:15, Semicolon:16, Quote:17
    };
    document.addEventListener('keydown', (e) => this.onKey(e, true));
    document.addEventListener('keyup',   (e) => this.onKey(e, false));
  }

  async init(selectEl, onEvent, onAvailability) {
    this.onEvent = onEvent;
    const notify = (avail, reason) => onAvailability && onAvailability(avail, reason);
    if (!navigator.requestMIDIAccess) {
      notify(false, 'WebMIDI not available in this webview');
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      notify(false, 'MIDI permission denied');
      return;
    }
    notify(true, '');
    const refresh = () => {
      const inputs = [...this.access.inputs.values()];
      selectEl.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = inputs.length ? '— select MIDI in —' : 'no MIDI devices (use QWERTY)';
      selectEl.appendChild(noneOpt);
      for (const inp of inputs) {
        const opt = document.createElement('option');
        opt.value = inp.id; opt.textContent = inp.name;
        selectEl.appendChild(opt);
      }
      if (this.activeInput && [...this.access.inputs.values()].some(i => i.id === this.activeInput.id)) {
        selectEl.value = this.activeInput.id;
      }
    };
    this.access.onstatechange = refresh;
    refresh();
    selectEl.addEventListener('change', () => this.selectInput(selectEl.value));
  }

  selectInput(id) {
    if (this.activeInput) this.activeInput.onmidimessage = null;
    this.activeInput = null;
    if (!id || !this.access) return;
    const inp = this.access.inputs.get(id);
    if (!inp) return;
    this.activeInput = inp;
    inp.onmidimessage = (e) => this.handleRaw(e.data);
  }

  handleRaw(data) {
    if (!this.onEvent) return;
    const status = data[0] & 0xf0;
    if (this.handleHardwareNote(status, data[1], data[2])) return;
    if (status === 0xb0) this.onEvent({ type:'cc', cc:data[1], value:data[2] / 127 });
    else if (status === 0xe0) {
      const bend = ((data[2] << 7) | data[1]) - 8192;
      this.onEvent({ type:'bend', value: bend / 8192 });
    }
  }

  handleHardwareNote(status, midi, velocity) {
    if (status === 0x90 && velocity > 0) {
      this.fireOn(midi, velocity / 127, 'hardware');
      return true;
    }
    // MIDI devices commonly encode note-off as note-on with zero velocity.
    if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      this.fireOff(midi, 'hardware');
      return true;
    }
    return false;
  }

  fireOn(midi, vel = 0.8, source = 'external') {
    let holds = this.noteHolds.get(midi);
    if (!holds) {
      holds = new Set();
      this.noteHolds.set(midi, holds);
    }
    if (holds.has(source)) return;
    const wasActive = holds.size > 0;
    holds.add(source);
    this.activeNotes.add(midi);
    if (!wasActive) this.onEvent && this.onEvent({ type:'noteon', midi, velocity: vel });
    this.refreshKbd();
  }
  fireOff(midi, source = 'external') {
    const holds = this.noteHolds.get(midi);
    if (holds) {
      if (source === 'all') holds.clear();
      else holds.delete(source);
      if (holds.size > 0) {
        this.refreshKbd();
        return;
      }
      this.noteHolds.delete(midi);
    }
    if (!this.activeNotes.has(midi)) return;
    this.activeNotes.delete(midi);
    this.onEvent && this.onEvent({ type:'noteoff', midi });
    this.refreshKbd();
  }
  allNotesOff() {
    for (const midi of [...this.activeNotes]) this.fireOff(midi, 'all');
    this.clearActiveState();
  }
  clearActiveState() {
    this.activeNotes.clear();
    this.noteHolds.clear();
    this.heldQwerty.clear();
    this.pointerHolds.clear();
    this.refreshKbd();
  }

  onKey(e, down) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    const offset = this.qwertyCodeMap[e.code] ?? this.qwertyMap[key];
    if (offset === undefined) {
      if (e.code === 'KeyZ' || key === 'z') { if (down) { this.baseOctave = Math.max(0, this.baseOctave - 1); this.renderKbd(); } return; }
      if (e.code === 'KeyX' || key === 'x') { if (down) { this.baseOctave = Math.min(8, this.baseOctave + 1); this.renderKbd(); } return; }
      return;
    }
    const source = `qwerty:${e.code || key}`;
    if (down) {
      if (!this.heldQwerty.has(source)) {
        const midi = (this.baseOctave + 1) * 12 + offset;
        this.heldQwerty.set(source, midi);
        this.fireOn(midi, 0.8, source);
      }
    } else {
      const midi = this.heldQwerty.get(source);
      if (midi !== undefined) {
        this.heldQwerty.delete(source);
        this.fireOff(midi, source);
      }
    }
    e.preventDefault();
  }

  renderKbd(container = this._kbd) {
    if (!container) return;
    this._kbd = container;
    container.innerHTML = '';
    const start = this.baseOctave * 12;
    const end = (this.baseOctave + this.numOctaves) * 12;
    for (let m = start; m < end; m++) {
      const pc = m % 12;
      const isBlack = [1,3,6,8,10].includes(pc);
      const el = document.createElement('div');
      el.className = 'key' + (isBlack ? ' bk' : '');
      el.dataset.midi = m;
      if (pc === 0) el.textContent = 'C' + Math.floor(m / 12 - 1);
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.pointerHolds.set(ev.pointerId, m);
        this.fireOn(m, 0.8, `pointer:${ev.pointerId}`);
        el.setPointerCapture(ev.pointerId);
      });
      el.addEventListener('pointerup', (ev) => {
        const held = this.pointerHolds.get(ev.pointerId);
        if (held !== undefined) {
          this.pointerHolds.delete(ev.pointerId);
          this.fireOff(held, `pointer:${ev.pointerId}`);
        }
      });
      el.addEventListener('pointercancel', (ev) => {
        const held = this.pointerHolds.get(ev.pointerId);
        if (held !== undefined) {
          this.pointerHolds.delete(ev.pointerId);
          this.fireOff(held, `pointer:${ev.pointerId}`);
        }
      });
      container.appendChild(el);
    }
    this.refreshKbd();
  }

  refreshKbd() {
    if (!this._kbd) return;
    for (const el of this._kbd.children) {
      const m = parseInt(el.dataset.midi, 10);
      el.classList.toggle('on', this.activeNotes.has(m));
    }
  }
}
