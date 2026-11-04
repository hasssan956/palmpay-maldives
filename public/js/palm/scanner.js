// Camera + MediaPipe HandLandmarker -> a palm probe for the API.
//
// The runtime is served from our own server (/vendor/mediapipe, installed by
// npm), so there is no CDN dependency for the code. The ~8 MB model file is
// fetched once from Google's model bucket unless HAND_MODEL_URL points elsewhere.
//
// In production this whole module is replaced by the scanner vendor's SDK,
// which hands us an encrypted template instead of a geometry vector.
import { extractFeatures, frameProblem, medianVector, spreadOf, FEATURE_MODEL } from '/shared/palm-features.js';

const TARGET_FRAMES = 18;
const MAX_SPREAD = 0.09;

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
   *          modelUrl: string, onHint: Function, onProgress: Function}} opts
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.facing = 'environment';
    this.frames = [];
    this.missing = 0;
    this.running = false;
  }

  async start() {
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
    this.running = true;
    this.lastTime = -1;
    this.loop();
  }

  async openCamera() {
    this.stopCamera();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (err) {
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      throw new ScanError(denied ? 'camera_denied' : 'no_camera',
        denied ? 'Camera access is blocked. Allow it in the browser settings, then try again.' : 'No camera was found on this device.');
    }
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
    if (v.readyState >= 2 && v.currentTime !== this.lastTime) {
      this.lastTime = v.currentTime;
      const result = this.landmarker.detectForVideo(v, performance.now());
      this.handleFrame(result);
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  handleFrame(result) {
    const image = result.landmarks?.[0];
    const world = result.worldLandmarks?.[0];
    const side = result.handedness?.[0]?.[0];
    this.draw(image);

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
      const probe = { model: FEATURE_MODEL, vector: median, hand, quality: { frames: this.frames.length, spread } };
      const snapshot = this.snapshot();
      this.pause();
      this.resolveCapture?.({ probe, snapshot });
    }
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
    if (!this.landmarker) return;
    this.running = true;
    this.loop();
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  stop() {
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

export class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
