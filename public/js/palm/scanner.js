// Camera + MediaPipe HandLandmarker -> a palm probe for the API.
//
// The runtime is served from our own server (/vendor/mediapipe, installed by
// npm), so there is no CDN dependency for the code. The ~8 MB model file is
// fetched once from Google's model bucket unless HAND_MODEL_URL points elsewhere.
//
// Liveness checks run on the same frames (see shared/palm-features.js):
//   tremor  - do the fingers move on their own, like a real hand?
//   device  - is the hand boxed in by straight edges, like a phone or screen border?
//   glare   - is the palm throwing back shiny, near-white reflection?
//
// In production this whole module is replaced by the scanner vendor's SDK,
// which hands us an encrypted template instead of a geometry vector.
import {
  extractFeatures, frameProblem, medianVector, spreadOf, FEATURE_MODEL,
  tremorScore, handBox, frameAroundHand, glareShare, evaluateLiveness, PALM_OUTLINE,
} from '/shared/palm-features.js?v=3'; // ?v= skips any copy a phone cached before app code was set to no-cache

const TARGET_FRAMES = 18;
const MAX_SPREAD = 0.09;
const DEVICE_EVERY = 5; // look for a device border on every 5th frame with a hand in it
const DEVICE_SIZE = 192; // pixels, longest side of the frame the border check works on
const DEVICE_WINDOW_MS = 5000; // a device seen in the last 5 s counts, so showing it from afar then moving close doesn't help
const GLARE_EVERY = 3; // measure glare on every 3rd frame of the reading
const GLARE_SIZE = 96; // pixels, longest side of the palm crop

const HINTS = {
  loading: ['Starting the scanner', 'Allow camera access if your browser asks.'],
  no_hand: ['Show your palm', 'Hold your open hand up to the camera.'],
  too_far: ['Move closer', 'Fill the outline with your hand.'],
  too_close: ['Move back a little', 'Your whole hand needs to be in view.'],
  off_center: ['Centre your hand', 'Line it up with the outline.'],
  fingers_closed: ['Spread your fingers', 'Keep your hand flat and open.'],
  reading: ['Hold still', 'Reading your palm.'],
  unsteady: ['Keep your hand steady', 'Starting the reading again.'],
  two_hands: ['Show one hand only', 'Keep your other hand out of view.'],
  mixed_hands: ['Use one hand', 'Keep the same hand in view until the reading finishes.'],
};

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

let landmarkerPromise;
async function getLandmarker(modelUrl) {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, HandLandmarker } = await import('/vendor/mediapipe/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      const make = (delegate) =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl, delegate },
          runningMode: 'VIDEO',
          numHands: 2, // detect two so we can ask for one, instead of silently picking either
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.5,
        });
      try { return await make('GPU'); } catch { return make('CPU'); }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = undefined; });
  }
  return landmarkerPromise;
}

export class PalmScanner {
  /**
   * @param {{video: HTMLVideoElement, canvas: HTMLCanvasElement, viewport: HTMLElement,
   *          modelUrl: string, onHint: Function, onProgress: Function,
   *          liveness?: {mode: 'off'|'observe'|'enforce', checks: string[], minTremor: number,
   *                      maxDeviceScore: number, maxGlare: number},
   *          onLiveness?: Function}} opts
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.liveness ||= { mode: 'off', checks: [] };
    this.checks = this.liveness.mode === 'off' ? [] : this.liveness.checks || [];
    this.imageFrames = [];
    this.glareSamples = [];
    this.deviceSeen = []; // kept across resets on purpose
    this.tick = 0;
    this.errors = 0;
    this.facing = 'environment';
    this.frames = [];
    this.missing = 0;
    this.running = false;
  }

  async start() {
    this.stopped = false;
    this.onHint(...HINTS.loading);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new ScanError('no_camera', 'This browser cannot open the camera. Use Chrome or Safari over https.');
    }
    const [landmarker] = await Promise.all([
      getLandmarker(this.modelUrl).catch(() => {
        throw new ScanError('model_failed', 'The palm reader could not load. Check the connection and try again.');
      }),
      this.openCamera(),
    ]);
    this.landmarker = landmarker;
    if (this.stopped) { this.stopCamera(); return; } // closed while starting
    this.running = true;
    this.lastTime = -1;
    this.loop();
  }

  async openCamera() {
    this.stopCamera();
    // Phones can take a moment to release the camera from the last scan, and
    // some refuse the preferred size: retry, asking for less each time.
    const asks = [
      { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      { facingMode: { ideal: this.facing } },
      true,
    ];
    let stream, lastErr;
    for (const video of asks) {
      if (this.stopped) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
        break;
      } catch (err) {
        lastErr = err;
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (!stream) throw cameraError(lastErr);
    if (this.stopped) { stream.getTracks().forEach((t) => t.stop()); return; } // closed while opening
    this.stream = stream;
    const settings = this.stream.getVideoTracks()[0]?.getSettings?.() || {};
    // Laptops report no facingMode and use the front camera: mirror those.
    this.viewport.classList.toggle('mirror', settings.facingMode !== 'environment');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
  }

  async flip() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.reset();
    await this.openCamera();
  }

  reset() {
    this.frames = [];
    this.imageFrames = [];
    this.glareSamples = [];
    this.hands = [];
    this.onProgress(0);
    this.viewport.classList.remove('locked');
  }

  capture() {
    return new Promise((resolve) => (this.resolveCapture = resolve));
  }

  loop() {
    if (!this.running) return;
    const v = this.video;
    try {
      if (v.readyState >= 2 && v.currentTime !== this.lastTime) {
        this.lastTime = v.currentTime;
        const result = this.landmarker.detectForVideo(v, performance.now());
        this.handleFrame(result);
        this.errors = 0;
      }
    } catch (err) {
      // One bad frame must never freeze the scanner: report it and carry on.
      this.errors = (this.errors || 0) + 1;
      this.onError?.(err);
      if (this.errors >= 60) {
        this.pause();
        this.onHint('Scanner stopped', 'Close the scanner and try again.');
        return;
      }
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  handleFrame(result) {
    const image = result.landmarks?.[0];
    const world = result.worldLandmarks?.[0];
    const side = result.handedness?.[0]?.[0];
    this.draw(image);

    const handCount = result.landmarks?.length || 0;
    if (handCount === 1 && this.checks.includes('device') && ++this.tick % DEVICE_EVERY === 0) this.sampleDevice(image);

    const problem = (result.landmarks?.length || 0) > 1 ? 'two_hands' : frameProblem(image);
    if (problem) {
      this.missing++;
      if ((this.missing > 8 || problem === 'two_hands') && this.frames.length) this.reset();
      this.onHint(...HINTS[problem]);
      return;
    }
    this.missing = 0;
    const vector = extractFeatures(world);
    if (!vector) return;
    this.frames.push(vector);
    this.imageFrames.push(image);
    if (this.checks.includes('glare') && this.frames.length % GLARE_EVERY === 1) {
      try { this.sampleGlare(image); } catch (err) { this.onError?.(err); }
    }
    if (side && side.score >= 0.6) (this.hands ||= []).push(side.categoryName);
    this.viewport.classList.add('locked');
    this.onHint(...HINTS.reading);
    this.onProgress(this.frames.length / TARGET_FRAMES);

    if (this.frames.length >= TARGET_FRAMES) {
      const median = medianVector(this.frames);
      const spread = spreadOf(this.frames, median);
      if (spread > MAX_SPREAD) {
        this.reset();
        this.onHint(...HINTS.unsteady);
        return;
      }
      // Which hand is it? Majority vote across frames. The label is only used to
      // compare with the label recorded at enrolment, so it just has to be consistent.
      const hand = majority(this.hands || []);
      if (!hand) {
        this.reset();
        this.onHint(...HINTS.mixed_hands);
        return;
      }
      // Liveness: tremor, device frame and glare.
      let liveness;
      if (this.checks.length) {
        liveness = this.measureLiveness();
        this.onLiveness?.(liveness);
        if (!liveness.passed && this.liveness.mode === 'enforce') {
          // Stop and say so, instead of quietly scanning again.
          this.pause();
          this.resolveCapture?.({ rejected: 'not_live', liveness });
          return;
        }
      }
      const probe = { model: FEATURE_MODEL, vector: median, hand, quality: { frames: this.frames.length, spread }, liveness };
      const snapshot = this.snapshot();
      this.pause();
      this.resolveCapture?.({ probe, snapshot });
    }
  }

  measureLiveness() {
    const m = {};
    if (this.checks.includes('tremor')) {
      m.tremor = tremorScore(this.imageFrames, this.video.videoWidth / this.video.videoHeight || 1);
    }
    if (this.checks.includes('device')) {
      const now = performance.now();
      const recent = this.deviceSeen.filter((d) => now - d.t <= DEVICE_WINDOW_MS);
      m.device = recent.length
        ? recent.reduce((best, d) => (d.score > best.score ? { score: d.score, sides: d.sides } : best), { score: 0, sides: 0 })
        : null;
    }
    if (this.checks.includes('glare')) {
      m.glare = this.glareSamples.length ? medianVector(this.glareSamples.map((g) => [g]))[0] : null;
    }
    return { ...m, ...evaluateLiveness(m, { ...this.liveness, checks: this.checks }) };
  }

  sampleDevice(image) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    try {
      const k = DEVICE_SIZE / Math.max(vw, vh);
      const w = Math.round(vw * k), h = Math.round(vh * k);
      const c = (this.deviceCanvas ||= document.createElement('canvas'));
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      const b = handBox(image);
      const now = performance.now();
      this.deviceSeen.push({ t: now, ...frameAroundHand(gray, w, h, { x: b.x * w, y: b.y * h, w: b.w * w, h: b.h * h }) });
      this.deviceSeen = this.deviceSeen.filter((d) => now - d.t <= DEVICE_WINDOW_MS);
    } catch (err) {
      this.onError?.(err); // no sample this frame; the scan carries on
    }
  }

  sampleGlare(image) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const palm = PALM_OUTLINE.map((i) => [image[i].x * vw, image[i].y * vh]);
    const x0 = Math.max(0, Math.min(...palm.map((p) => p[0])));
    const y0 = Math.max(0, Math.min(...palm.map((p) => p[1])));
    const x1 = Math.min(vw, Math.max(...palm.map((p) => p[0])));
    const y1 = Math.min(vh, Math.max(...palm.map((p) => p[1])));
    if (!(x1 - x0 > 8 && y1 - y0 > 8)) return;
    const k = GLARE_SIZE / Math.max(x1 - x0, y1 - y0);
    const w = Math.max(1, Math.round((x1 - x0) * k)), h = Math.max(1, Math.round((y1 - y0) * k));
    const c = (this.glareCanvas ||= document.createElement('canvas'));
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
    const share = glareShare(g.getImageData(0, 0, w, h).data, w, h, palm.map(([x, y]) => [(x - x0) * k, (y - y0) * k]));
    if (share != null) this.glareSamples.push(share);
  }

  draw(points) {
    const c = this.canvas;
    const v = this.video;
    if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (!points) return;
    const locked = this.viewport.classList.contains('locked');
    const s = Math.max(2, c.width / 320);
    g.lineWidth = s;
    g.strokeStyle = locked ? 'rgba(255,200,87,0.9)' : 'rgba(46,196,182,0.85)';
    g.beginPath();
    for (const [a, b] of CONNECTIONS) {
      g.moveTo(points[a].x * c.width, points[a].y * c.height);
      g.lineTo(points[b].x * c.width, points[b].y * c.height);
    }
    g.stroke();
    g.fillStyle = '#fff';
    for (const p of points) {
      g.beginPath();
      g.arc(p.x * c.width, p.y * c.height, s * 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }

  snapshot(size = 240) {
    const v = this.video;
    const side = Math.min(v.videoWidth, v.videoHeight);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (this.viewport.classList.contains('mirror')) { g.translate(size, 0); g.scale(-1, 1); }
    g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.72);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resume() {
    this.reset();
    this.deviceSeen = []; // a fresh try after a refusal starts with a clean slate
    if (!this.landmarker) return;
    this.running = true;
    this.loop();
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  stop() {
    this.stopped = true;
    this.pause();
    this.stopCamera();
  }
}

function majority(labels) {
  if (labels.length < 6) return null;
  const left = labels.filter((l) => l === 'Left').length;
  const share = Math.max(left, labels.length - left) / labels.length;
  if (share < 0.75) return null;
  return left * 2 > labels.length ? 'Left' : 'Right';
}

function cameraError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new ScanError('camera_denied', 'Camera access is blocked. Allow it in the browser settings, then try again.');
  }
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) {
    return new ScanError('camera_busy', 'The camera is busy. Close other tabs or apps using the camera, then tap Scan again.');
  }
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name)) {
    return new ScanError('no_camera', 'No camera was found on this device.');
  }
  return new ScanError('camera_failed', `The camera could not start${name ? ` (${name})` : ''}. Tap Scan again.`);
}

export class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
