// Full-screen palm scan. Used by checkout (pay) and enrolment (capture).
//
// openScanModal resolves with the value `submit` returns on success, or null
// if the person cancels. `submit({probe, snapshot} | {demo: {id}})` must return
//   { ok: true, value, title?, message? }            -> tick, then close
//   { ok: false, retry: boolean, title, message }    -> cross, offer another scan
import { PalmScanner } from '../palm/scanner.js';
import { getConfig } from '../api.js';
import { icon, palmGuide } from './icons.js';
import { mvrNumber, esc } from '../format.js';

const RING_R = 48;
const RING_C = 2 * Math.PI * RING_R;

export async function openScanModal({ eyebrow, amount, title, submit, demoChoices, demoLabel = 'No camera? Simulate a scan' }) {
  const config = await getConfig();
  const el = document.createElement('div');
  el.className = 'scan';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Palm scanner');
  el.innerHTML = `
    <div class="scan-head">
      <div>
        <small>${esc(eyebrow)}</small>
        ${amount != null
          ? `<div class="amount num"><span class="cur">MVR</span>${mvrNumber(amount)}</div>`
          : `<div class="amount" style="font-family:var(--font-display);font-size:var(--t-2xl)">${esc(title)}</div>`}
      </div>
      <button class="icon-btn" data-act="close" aria-label="Cancel">${icon('x')}</button>
    </div>
    <div class="scan-stage">
      <div class="viewport">
        <div class="ripples"><i></i><i></i><i></i></div>
        <div class="frame">
          <video playsinline muted></video>
          <canvas class="overlay"></canvas>
        </div>
        ${palmGuide()}
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
          <rect class="track" x="2" y="2" width="96" height="96" rx="33"/>
          <rect class="fill empty" x="2" y="2" width="96" height="96" rx="33" pathLength="${RING_C.toFixed(1)}"
                stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${RING_C.toFixed(1)}"/>
        </svg>
        <div class="scan-result" aria-hidden="true"></div>
      </div>
      <div class="scan-hint" aria-live="polite"><strong>Starting the scanner</strong><span></span></div>
      <div class="debug" hidden></div>
    </div>
    <div class="scan-foot">
      <div class="row">
        <button class="btn btn-ghost-dark" data-act="flip">${icon('flip')}Switch camera</button>
        <button class="btn btn-lagoon" data-act="retry" hidden>${icon('refresh')}Scan again</button>
      </div>
      ${config.demoMode && demoChoices ? `<button class="link-btn" data-act="demo" style="color:#8ff0e5;justify-self:center">${esc(demoLabel)}</button>` : ''}
      <div class="demo-pick" hidden></div>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => el.classList.add('open'));

  const $ = (s) => el.querySelector(s);
  const hint = $('.scan-hint');
  const ringFill = $('.ring .fill');
  const resultEl = $('.scan-result');
  const retryBtn = $('[data-act="retry"]');
  const debugEl = $('.debug');

  // Debug line: match distance and tremor score, so thresholds can be tuned on the spot.
  let matchLine = '';
  let liveLine = '';
  let errorLine = '';
  const showDebug = () => {
    if (!config.exposeMatchDebug) return;
    const text = [matchLine, liveLine, errorLine].filter(Boolean).join(' · ');
    debugEl.hidden = !text;
    debugEl.textContent = text;
  };
  const livenessText = (l) => {
    const L = config.liveness;
    const mark = (c) => (l.failed.includes(c) ? '✗' : '✓');
    const parts = [];
    if ('tremor' in l) parts.push(`Tremor ${l.tremor ?? 'n/a'} ${mark('tremor')} (min ${L.minTremor})`);
    if ('device' in l) parts.push(`Device ${l.device ? `${l.device.score} (${l.device.sides} sides)` : 'n/a'} ${mark('device')} (max ${L.maxDeviceScore})`);
    if ('glare' in l) parts.push(`Glare ${l.glare ?? 'n/a'} ${mark('glare')} (max ${L.maxGlare})`);
    return parts.join(' · ') + (L.mode === 'observe' ? ' · not enforced' : '');
  };

  const setHint = (strong, span = '') => { hint.innerHTML = `<strong>${esc(strong)}</strong><span>${esc(span)}</span>`; };
  const setProgress = (p) => {
    ringFill.setAttribute('stroke-dashoffset', (RING_C * (1 - Math.min(1, p))).toFixed(1));
    ringFill.classList.toggle('empty', p <= 0);
  };

  const scanner = new PalmScanner({
    video: $('video'), canvas: $('canvas'), viewport: $('.viewport'),
    modelUrl: config.biometric.handModelUrl, onHint: setHint, onProgress: setProgress,
    palmLines: config.biometric.palmLines, liveness: config.liveness, onLiveness: (l) => { liveLine = livenessText(l); showDebug(); },
    onError: (err) => {
      console.error('Scanner:', err);
      if (!errorLine) { errorLine = `Scanner error: ${String(err?.message || err).slice(0, 120)}`; showDebug(); }
    },
  });

  let finish;
  const done = new Promise((r) => (finish = r));
  let busy = false;

  function close(value) {
    scanner.stop();
    el.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => el.remove(), 220);
    document.removeEventListener('keydown', onKey);
    finish(value ?? null);
  }
  const onKey = (e) => { if (e.key === 'Escape' && !busy) close(null); };
  document.addEventListener('keydown', onKey);

  function showResult(ok) {
    resultEl.innerHTML = ok
      ? `<svg class="tick" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/><path d="M30 52l13 13 27-29"/></svg>`
      : `<svg class="tick cross" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/><path d="M36 36l28 28M64 36 36 64" stroke-width="7" stroke-linecap="round" style="stroke-dasharray:none"/></svg>`;
    resultEl.classList.add('show');
  }

  async function handle(input) {
    busy = true;
    el.classList.add('verifying');
    setHint(amount != null ? 'Verifying' : 'Saving', amount != null ? 'Matching your palm, then asking your bank.' : 'Securing your palm template.');
    let res;
    try {
      res = await submit(input);
    } catch (err) {
      res = { ok: false, retry: true, title: 'Something went wrong', message: err.message };
    }
    el.classList.remove('verifying');
    busy = false;
    if (res.debug) {
      const d = res.debug;
      matchLine = `Match: ${d.status}, shape ${d.distance ?? 'n/a'} (max ${d.threshold ?? 'n/a'})`
        + (d.linesThreshold != null ? `, lines ${d.lines ?? 'n/a'} (max ${d.linesThreshold})` : '');
      showDebug();
    }
    showResult(res.ok);
    setHint(res.title || (res.ok ? 'Done' : 'Not recognised'), res.message || '');
    if (res.ok) {
      setTimeout(() => close(res.value), 1100);
    } else if (res.retry) {
      retryBtn.hidden = false;
    } else {
      setTimeout(() => close(res.value ?? null), 2200);
    }
  }

  async function scanOnce() {
    resultEl.classList.remove('show');
    retryBtn.hidden = true;
    setProgress(0);
    const captured = await scanner.capture();
    if (captured.rejected === 'not_live') {
      showResult(false);
      setHint('Use your real hand', 'Photos and screens can\'t be used to pay. Hold your own hand up to the camera.');
      retryBtn.hidden = false;
      return;
    }
    await handle(captured);
  }

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || busy) return;
    if (act === 'close') close(null);
    if (act === 'flip') { try { await scanner.flip(); } catch (err) { setHint('Camera unavailable', err.message); } }
    if (act === 'retry') {
      if (cameraFailed) { $('.demo-pick').hidden = true; startScanner(); } // camera never opened: start again
      else { scanner.resume(); scanOnce(); }
    }
    if (act === 'demo') {
      const pick = $('.demo-pick');
      const choices = await demoChoices();
      pick.innerHTML = choices.map((c) =>
        `<button data-demo="${esc(c.id)}"><span>${esc(c.name)}</span><small>${esc(c.note || '')}</small></button>`).join('');
      pick.hidden = false;
    }
  });
  $('.demo-pick').addEventListener('click', (e) => {
    const id = e.target.closest('[data-demo]')?.dataset.demo;
    if (!id || busy) return;
    scanner.pause();
    $('.demo-pick').hidden = true;
    setProgress(1);
    handle({ demo: { id } });
  });

  let cameraFailed = false;
  async function startScanner() {
    cameraFailed = false;
    resultEl.classList.remove('show');
    retryBtn.hidden = true;
    try {
      await scanner.start();
      if (!scanner.running) return; // closed while starting
      scanOnce();
    } catch (err) {
      cameraFailed = true;
      setHint('Scanner unavailable', err.message);
      showResult(false);
      retryBtn.hidden = false;
      if (config.demoMode && demoChoices && err.code !== 'camera_busy') $('[data-act="demo"]')?.click();
    }
  }
  startScanner();

  return done;
}
