# Faust Runner for VS Code

Compile, play, and analyze [Faust](https://faust.grame.fr) DSPs **inside the VS Code bottom panel** (next to Terminal / Debug Console), with hardware + on-screen MIDI, swappable test signals, a triggered oscilloscope, and a spectrum analyzer with pre/post overlay and frequency-response mode.

Optional HISE plugin lint catches HISE-specific gotchas (`freq`/`gate`/`gain` magic labels, no slashes, no `key`/`vel`/`bend` auto-wiring) without getting in the way of plain Faust development.

## Features

- **Live compile** via `libfaust.wasm` from the CDN — no native Faust install required for the runner panel. (Editor diagnostics and block-diagram SVG do use the local `faust` binary.)
- **Bottom-panel webview** alongside Terminal / Debug Console. Survives panel hide / show.
- **Test signal palette**: silence, white/pink noise, sine, log sweep, impulse train, click train, microphone, **drag-drop any audio file** (or pick via dialog).
- **MIDI input**: WebMIDI hardware + on-screen QWERTY keyboard (`a`–`'` rows; `z`/`x` shift octave).
- **Triggered oscilloscope**: rising/falling/auto/free trigger, level + hysteresis, time/div, L/R/L+R/Lissajous (X/Y), persistence (afterglow), draggable cursors with Δt/frequency readout, single-shot capture, export window to `.wav`.
- **Spectrum analyzer**: FFT 512–16384, six windows incl. flat-top + Kaiser, log frequency, dBFS, exp / max-hold averaging, peak hold with decay, **input/output overlay**, **frequency-response (out/in)** mode, parabolic-interpolated cursor readout, click-a-fundamental harmonic markers.
- **Hot reload**: save a `.dsp` → recompile and swap the worklet node in place.
- **Optional HISE lint**: forbidden `/` in labels, warning when `gate` isn't a `button`, warning on `key`/`vel`/`velocity`/`bend` labels that vanilla Faust auto-wires but HISE silently ignores, and a check that a wrapper XML exists in `../../Networks/` with matching `ClassId`. Only activates when the `.dsp` lives inside a HISE-shaped folder.
- **Block-diagram view**: the runner panel can generate navigable SVG diagrams with `faustwasm`; `Faust: Show block diagram` also opens the `process.svg` produced by the local `faust -svg`.

## Install

### From a `.vsix` release

Download the latest `.vsix` from the [Releases page](https://github.com/morphoice/vscode-faust-runner/releases) and install:

```bash
code --install-extension vscode-faust-runner-<version>.vsix
```

Or in VS Code: `Extensions` → `…` menu → `Install from VSIX…`.

### From source (development mode)

No build step — the extension is unpacked source.

```bash
git clone https://github.com/morphoice/vscode-faust-runner.git
cd vscode-faust-runner
code --extensionDevelopmentPath=$(pwd)
```

Or open the folder in VS Code and press **F5** ("Run Extension") to launch a second window with the extension loaded.

## First run

1. Install or have a [Faust compiler](https://faust.grame.fr) on `$PATH` (needed for editor diagnostics and block-diagram SVG; the runner panel itself uses WASM and works without it).
2. Open any `.dsp` file.
3. Run the command **Faust: Run DSP in panel** (`⇧⌘P`), or click the play icon in the editor title bar.
4. The **Faust** tab appears in the bottom panel. Click **Play**, choose a source, play the keyboard.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `faust.binary` | `faust` | Compiler used for editor diagnostics and SVG. Bare name resolves from `$PATH`; use an absolute path to pin a specific build. |
| `faust.libraryPath` | `""` | Passed to the compiler as `-I`. Leave empty to use the compiler's built-in default. |
| `faust.hiseLint` | `true` | Layer HISE rules on top of regular diagnostics. Rules only activate inside HISE-shaped folders; harmless for non-HISE projects. |
| `faust.polyphony` | `8` | Voice count when **poly** is enabled in the runner. |

## Known limitations

- Webview loads `@grame/faustwasm` + `@shren/faust-ui` from CDN. Offline use needs `npm install` + `localResourceRoots` rewiring.
- WASM compile happens in the webview, not via the native `faust` binary — output is identical, but rare backend-specific issues won't surface here.
- No waterfall/spectrogram view yet.
- No batch test runner (planned: render every wav in `tests/` through the DSP and dump outputs for A/B).
- Scope persistence uses canvas alpha blending, not WebGL — fine for our render rates but not infinite-decay.

## Project layout

```
vscode-faust-runner/
  package.json
  extension.js               activation, command, view provider, hot-reload watcher
  src/
    diagnostics.js           shells `faust -lang cpp -o /dev/null`, parses errors
    hise-lint.js             HISE-specific lint rules
  webview/
    main.js                  orchestrator: compile, wire graph, route MIDI, hot reload
    capture-worklet.js       AudioWorkletProcessor → rolling buffer → MessagePort
    fft.js                   radix-2 Cooley-Tukey + windowing (hann/hamming/blackman/BH7/flat-top/kaiser)
    scope.js                 triggered oscilloscope
    analyzer.js              spectrum analyzer
    signals.js               test signal generators
    midi.js                  WebMIDI + on-screen keyboard
    style.css
  build-vsix.sh              build a .vsix without node/vsce
```

## Building a `.vsix`

```bash
./build-vsix.sh
```

Produces `<publisher>.<name>-<version>.vsix` in the project root. No `npm install` or `vsce` required.

## Built for

This extension grew out of two HISE-based synthesizer plugins from [Morphoice](https://www.morphoice.com/plugins) — every feature in the runner exists because something needed measuring or auditioning while voicing them.

### [Unstable](https://www.morphoice.com/unstable) — Yamaha CS-80 emulation

The oscilloscope's L/R/Lissajous mode, the analyzer's frequency-response overlay, and the scope persistence were built while voicing Unstable's VCF, ring-mod, and chorus sections.

[![Unstable](https://www.morphoice.com/images/unstable-screenshot.jpg)](https://www.morphoice.com/unstable)

### [HexaDrum](https://www.morphoice.com/hexadrum) — Simmons SDS-V drum module

The triggered scope, hot reload, and click/impulse test signals were built while voicing HexaDrum's kick and tom Faust DSPs.

[![HexaDrum](https://www.morphoice.com/images/hexadrum-screenshot.jpg)](https://www.morphoice.com/hexadrum)

## License

[MIT](LICENSE)
