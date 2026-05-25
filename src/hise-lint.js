// HISE-specific lint layer for Faust files.
//
// These checks complement the real Faust compiler diagnostics. They only run
// inside HISE's DspNetworks/CodeLibrary/faust layout and warn about conventions
// that Faust accepts but HISE handles poorly or silently ignores.

const path = require('path');
const fs = require('fs');
const vscode = require('vscode');

// Detect the HISE Faust source location without requiring project metadata.
function isHiseFaustFile(filePath) {
  return /DspNetworks[\\/]+CodeLibrary[\\/]+faust[\\/]+[^\\/]+\.dsp$/i.test(filePath);
}

const MAGIC_LABELS = new Set(['freq', 'gate', 'gain']);
const VANILLA_ONLY_LABELS = new Set(['key', 'vel', 'velocity', 'bend', 'pitchwheel']);

// Scan Faust widget declarations for labels HISE treats specially, then verify
// the matching wrapper XML exists in the sibling Networks directory.
function lint(document) {
  const diags = [];
  if (!isHiseFaustFile(document.uri.fsPath)) return diags;

  const text = document.getText();
  // Faust widget labels may include metadata in brackets. HISE's magic MIDI
  // wiring is based on the visible label before that metadata.
  const widgetRegex = /\b(hslider|vslider|nentry|button|checkbox)\s*\(\s*"([^"]*)"/g;

  let m;
  while ((m = widgetRegex.exec(text)) !== null) {
    const widget = m[1];
    const labelFull = m[2];
    const labelOnly = labelFull.split('[')[0].trim();
    const startIdx = m.index + widget.length + 2;
    const pos = document.positionAt(startIdx);
    const range = new vscode.Range(pos, document.positionAt(startIdx + labelFull.length));

    if (labelFull.includes('/')) {
      diags.push(new vscode.Diagnostic(range,
        `HISE crashes if a Faust widget label contains '/'. Rename "${labelFull}".`,
        vscode.DiagnosticSeverity.Error));
    }

    const lowered = labelOnly.toLowerCase();
    if (VANILLA_ONLY_LABELS.has(lowered)) {
      diags.push(new vscode.Diagnostic(range,
        `HISE does not auto-wire "${labelOnly}". Only freq/gate/gain are routed from MIDI events. This widget will just be a regular parameter.`,
        vscode.DiagnosticSeverity.Warning));
    }

    if (lowered === 'gate' && widget !== 'button') {
      diags.push(new vscode.Diagnostic(range,
        `HISE convention: "gate" should be a button(), not ${widget}(). KickDSP/TomDSP use button("gate").`,
        vscode.DiagnosticSeverity.Warning));
    }
    if (lowered === 'freq' && widget !== 'hslider' && widget !== 'vslider' && widget !== 'nentry') {
      diags.push(new vscode.Diagnostic(range,
        `HISE convention: "freq" must be an hslider/vslider/nentry so the MIDI frequency can be written into it.`,
        vscode.DiagnosticSeverity.Warning));
    }
  }

  // HISE scriptnode DSPs need a wrapper XML that references the DSP ClassId.
  // A wrapper with the same basename as the .dsp collides with generated files.
  const dspName = path.basename(document.uri.fsPath, '.dsp');
  const dspDir = path.dirname(document.uri.fsPath);
  const networksDir = path.resolve(dspDir, '..', '..', 'Networks');
  if (fs.existsSync(networksDir)) {
    const xmls = fs.readdirSync(networksDir).filter(f => f.endsWith('.xml'));
    let foundWrapper = false;
    for (const x of xmls) {
      try {
        const content = fs.readFileSync(path.join(networksDir, x), 'utf8');
        if (content.includes(`ClassId" Value="${dspName}"`)) {
          foundWrapper = true;
          if (path.basename(x, '.xml') === dspName) {
            diags.push(new vscode.Diagnostic(new vscode.Range(0,0,0,1),
              `Wrapper XML "${x}" shares the base name of this .dsp. HISE templates will collide. Rename the .dsp or the wrapper so they differ.`,
              vscode.DiagnosticSeverity.Error));
          }
          break;
        }
      } catch (e) { /* ignore */ }
    }
    if (!foundWrapper) {
      diags.push(new vscode.Diagnostic(new vscode.Range(0,0,0,1),
        `No wrapper XML in ${path.relative(path.dirname(dspDir), networksDir)}/ references ClassId="${dspName}". This .dsp will not be loadable as a scriptnode until a wrapper is created.`,
        vscode.DiagnosticSeverity.Warning));
    }
  }

  return diags;
}

module.exports = { lint, isHiseFaustFile };
