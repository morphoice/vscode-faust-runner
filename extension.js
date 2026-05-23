const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { validate, compileSVG, getConfig } = require('./src/diagnostics');
const { lint } = require('./src/hise-lint');

let diagCollection;
let runner;

class FaustRunnerProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.activeDoc = null;
    this.saveWatcher = null;
    this._pendingAutoplay = false;
    const savedDir = context.globalState.get('faust.lastAudioDir');
    this._lastAudioDir = savedDir ? vscode.Uri.file(savedDir) : undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const ext = this.context.extensionPath;
    const wvRoot = vscode.Uri.file(path.join(ext, 'webview'));

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [wvRoot]
    };

    const u = (f) => webviewView.webview.asWebviewUri(vscode.Uri.joinPath(wvRoot, f));
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    const cdn = 'https://cdn.jsdelivr.net';

    webviewView.webview.html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src ${webviewView.webview.cspSource} data: blob:;
  style-src ${webviewView.webview.cspSource} 'unsafe-inline' ${cdn};
  font-src ${cdn};
  script-src 'nonce-${nonce}' ${webviewView.webview.cspSource} ${cdn} blob: data: 'wasm-unsafe-eval' 'unsafe-eval';
  connect-src ${webviewView.webview.cspSource} ${cdn} blob: data:;
  worker-src ${webviewView.webview.cspSource} blob: data:;
  child-src ${webviewView.webview.cspSource} blob: data:;
  media-src blob: data:;
">
<link rel="stylesheet" href="${u('style.css')}">
<link rel="stylesheet" href="${cdn}/npm/@shren/faust-ui@1/dist/esm/index.css">
</head>
<body>
<div id="app">
  <header>
    <div class="row">
      <button id="panic" title="MIDI panic / all notes off">Panic</button>
      <button id="recompile" title="Force recompile">↻</button>
      <button id="svgToggle" title="Show Faust SVG block diagram">SVG</button>
      <span class="sep"></span>
      <label>Src:
        <select id="srcKind">
          <option value="silence">— none —</option>
          <option value="noise-white">White noise</option>
          <option value="noise-pink">Pink noise</option>
          <option value="sine">Sine 440</option>
          <option value="sweep">Log sweep</option>
          <option value="impulse">Impulse (1/s)</option>
          <option value="click">Click train</option>
          <option value="mic">Audio input…</option>
          <option value="file">Audio file…</option>
        </select>
      </label>
      <button id="play" title="Toggle the source feed into Faust">Play</button>
      <input type="file" id="srcFile" accept="audio/*" style="display:none">
      <button id="srcFilePick" title="Pick a different audio file" style="display:none; padding:2px 6px">Browse…</button>
      <label id="srcLoopLbl" style="display:none"><input type="checkbox" id="srcLoop"> loop</label>
      <select id="srcDevice" title="Audio input device" style="display:none; min-width:160px"></select>
      <button id="srcDeviceRefresh" title="Rescan input devices" style="display:none; padding:2px 5px">↻</button>
      <span class="sep"></span>
      <label><input type="checkbox" id="midiOn"> MIDI in</label>
      <select id="midiPort" title="MIDI input device" style="min-width:140px"></select>
      <button id="midiRefresh" title="Rescan MIDI devices" style="padding:2px 5px">↻</button>
      <span class="sep"></span>
      <span class="status" id="status">idle</span>
    </div>
  </header>
  <div id="grid">
    <section id="paramPane"><div id="faust-ui"></div></section>
    <div id="vresizer" title="Drag to resize parameter pane"></div>
    <section id="scopePane">
      <div class="canvasWrap">
        <canvas id="scope"></canvas>
        <div class="ctlrow overlay" id="scopeCtl"></div>
      </div>
    </section>
    <section id="anaPane">
      <div class="canvasWrap">
        <canvas id="analyzer"></canvas>
        <div class="ctlrow overlay" id="anaCtl"></div>
      </div>
    </section>
  </div>
  <div id="svgPanel" style="display:none">
    <div id="svgToolbar">
      <span>Diagram</span>
      <select id="svgSelect" title="SVG diagram"></select>
      <button id="svgZoomOut" title="Zoom out">−</button>
      <button id="svgZoomReset" title="Reset zoom">100%</button>
      <button id="svgZoomIn" title="Zoom in">+</button>
      <button id="svgRefresh" title="Regenerate SVG">↻</button>
      <button id="svgClose" title="Close SVG viewer">×</button>
    </div>
    <div id="svgViewport">
      <div id="svgCanvas" aria-label="Faust SVG block diagram"></div>
      <div id="svgEmpty">No SVG diagram generated yet</div>
    </div>
  </div>
  <footer id="errBar"><pre id="log"></pre><button id="errDismiss" title="dismiss">×</button></footer>
  <div id="kbdRow"><div id="kbd"></div></div>
</div>
<script type="module" nonce="${nonce}">
  window.__faustInit = { voices: ${vscode.workspace.getConfiguration('faust').get('polyphony')} };
</script>
<script type="module" nonce="${nonce}" src="${u('main.js')}"></script>
</body></html>`;

    webviewView.webview.onDidReceiveMessage(async (msg) => this.onMessage(msg));
    webviewView.onDidDispose(() => {
      this.view = null;
      vscode.commands.executeCommand('setContext', 'faustPlaying', false);
      if (this._setInfo) this._setInfo('Faust: stopped');
    });
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        // Panel was collapsed or another tab selected — suspend audio
        try { webviewView.webview.postMessage({ type: 'editorStop' }); } catch (e) {}
      }
    });
  }

  async loadDoc(doc, { autoplay = false } = {}) {
    this.activeDoc = doc;
    this._pendingAutoplay = autoplay;
    if (this.saveWatcher) { this.saveWatcher.dispose(); this.saveWatcher = null; }
    this.saveWatcher = vscode.workspace.onDidSaveTextDocument(saved => {
      if (this.activeDoc && saved.uri.fsPath === this.activeDoc.uri.fsPath) {
        this.sendDsp(saved, { reload: true });
      }
    });
    if (this.view) {
      this.sendDsp(doc, { autoplay });
      this._pendingAutoplay = false;
      return;
    }
    // Panel not open — reveal it; the webview will then request the DSP itself when ready
    try { await vscode.commands.executeCommand('faust.runner.focus'); }
    catch (e) {
      try { await vscode.commands.executeCommand('workbench.view.extension.faustPanel'); }
      catch (e2) { vscode.window.showErrorMessage('Faust: could not open runner panel (' + (e2.message || e2) + ')'); }
    }
  }

  sendDsp(doc, { reload = false, autoplay = false } = {}) {
    if (!this.view) return;
    try {
      const code = fs.readFileSync(doc.uri.fsPath, 'utf8');
      this.view.webview.postMessage({
        type: 'dspCode',
        code,
        name: path.basename(doc.uri.fsPath, '.dsp'),
        path: doc.uri.fsPath,
        reload,
        autoplay
      });
    } catch (e) {
      this.view.webview.postMessage({ type: 'log', text: 'read failed: ' + e.message });
    }
  }

  async onMessage(msg) {
    if (!this.view) return;
    if (msg.type === 'requestDsp' && this.activeDoc) {
      this.sendDsp(this.activeDoc, { autoplay: this._pendingAutoplay });
      this._pendingAutoplay = false;
    } else if (msg.type === 'state') {
      vscode.commands.executeCommand('setContext', 'faustPlaying', !!msg.playing);
      if (this._setInfo) this._setInfo(msg.playing ? 'Faust: playing' : 'Faust: stopped', msg.playing ? 'ok' : '');
    } else if (msg.type === 'info') {
      if (this._setInfo) this._setInfo(msg.text, msg.severity);
    } else if (msg.type === 'pickFile') {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: this._lastAudioDir,
        filters: { Audio: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a'] }
      });
      if (picks && picks[0]) {
        const dir = path.dirname(picks[0].fsPath);
        this._lastAudioDir = vscode.Uri.file(dir);
        this.context.globalState.update('faust.lastAudioDir', dir);
        this.context.globalState.update('faust.lastAudioPath', picks[0].fsPath);
        const buf = fs.readFileSync(picks[0].fsPath);
        this.view.webview.postMessage({
          type: 'audioFile',
          name: path.basename(picks[0].fsPath),
          bytes: Array.from(buf)
        });
      }
    } else if (msg.type === 'requestLastAudio') {
      const p = this.context.globalState.get('faust.lastAudioPath');
      if (p && fs.existsSync(p)) {
        try {
          const buf = fs.readFileSync(p);
          this.view.webview.postMessage({
            type: 'audioFile',
            name: path.basename(p),
            bytes: Array.from(buf),
            silent: true
          });
        } catch (e) {}
      }
    } else if (msg.type === 'log') {
      console.log('[faust webview]', msg.text);
    }
  }
}

function activate(context) {
  vscode.commands.executeCommand('setContext', 'faustPlaying', false);
  diagCollection = vscode.languages.createDiagnosticCollection('faust');
  context.subscriptions.push(diagCollection);

  // Persistent info strip — holds the latest Faust message until replaced
  const infoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
  infoItem.tooltip = 'Latest Faust runner message';
  context.subscriptions.push(infoItem);
  const setInfo = (msg, severity = '') => {
    if (!msg) { infoItem.hide(); return; }
    let icon = '$(pulse)';
    if (severity === 'err') icon = '$(error)';
    else if (severity === 'warn') icon = '$(warning)';
    else if (severity === 'ok') icon = '$(check)';
    infoItem.text = icon + ' ' + msg;
    infoItem.color = severity === 'err' ? new vscode.ThemeColor('errorForeground') : undefined;
    infoItem.show();
  };
  runner = new FaustRunnerProvider(context);
  runner._setInfo = setInfo;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('faust.runner', runner, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const refresh = async (doc) => {
    if (!doc || doc.languageId !== 'faust') return;
    const diags = [];
    diags.push(...await validate(doc));
    if (vscode.workspace.getConfiguration('faust').get('hiseLint')) {
      diags.push(...lint(doc));
    }
    diagCollection.set(doc.uri, diags);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => {
      clearTimeout(refresh._t);
      refresh._t = setTimeout(() => refresh(e.document), 500);
    })
  );
  for (const doc of vscode.workspace.textDocuments) refresh(doc);

  context.subscriptions.push(
    vscode.commands.registerCommand('faust.validate', async () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) await refresh(ed.document);
      vscode.window.showInformationMessage('Faust: validation complete');
    }),

    vscode.commands.registerCommand('faust.stop', async () => {
      if (runner.view) runner.view.webview.postMessage({ type: 'editorStop' });
    }),

    vscode.commands.registerCommand('faust.run', async (uriArg) => {
      try {
        let doc = null;
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document && ed.document.uri.fsPath.toLowerCase().endsWith('.dsp')) {
          doc = ed.document;
        }
        if (!doc && uriArg && typeof uriArg === 'object' && uriArg.fsPath) {
          doc = await vscode.workspace.openTextDocument(vscode.Uri.file(uriArg.fsPath));
        }
        if (!doc) {
          vscode.window.showErrorMessage('Faust: open a .dsp file first');
          return;
        }
        if (runner._setInfo) runner._setInfo('Faust: loading ' + path.basename(doc.uri.fsPath));
        await runner.loadDoc(doc, { autoplay: true });
      } catch (e) {
        vscode.window.showErrorMessage('Faust run failed: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('faust.showSVG', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const tmp = path.join(os.tmpdir(), 'vscode-faust-svg');
      if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
      const res = await compileSVG(ed.document.uri.fsPath, tmp);
      if (res.code !== 0) {
        vscode.window.showErrorMessage('Faust SVG: ' + (res.stderr || res.stdout).slice(0, 300));
        return;
      }
      const base = path.basename(ed.document.uri.fsPath, '.dsp');
      const svgPath = path.join(tmp, `${base}-svg`, 'process.svg');
      if (!fs.existsSync(svgPath)) {
        vscode.window.showErrorMessage(`SVG not produced at ${svgPath}`);
        return;
      }
      const panel = vscode.window.createWebviewPanel('faustSVG', `Block diagram: ${base}`, vscode.ViewColumn.Beside, {
        enableScripts: false,
        localResourceRoots: [vscode.Uri.file(path.dirname(svgPath))]
      });
      const svgUri = panel.webview.asWebviewUri(vscode.Uri.file(svgPath));
      panel.webview.html = `<!doctype html><html><body style="margin:0;background:#1e1e1e">
        <img src="${svgUri}" style="max-width:100%;display:block;margin:auto"/></body></html>`;
    })
  );
}

function deactivate() {
  if (diagCollection) diagCollection.dispose();
}

module.exports = { activate, deactivate };
