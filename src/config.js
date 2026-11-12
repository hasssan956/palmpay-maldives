// Every runtime knob lives here, read from environment variables.
// Swapping an adapter (JSON -> Postgres, simulated bank -> real bank API,
// hand geometry -> palm-vein vendor) is a config change plus a new adapter
// file, never a change to services or routes.

const env = process.env;

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const num = (v, d) => (v === undefined || v === '' ? d : Number.parseFloat(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { throw new Error('Invalid JSON in environment variable'); } };

// API keys identify who is calling: a partner bank's backend or a shop terminal.
// These demo keys are public on purpose. Set PARTNER_KEYS in Secrets for anything real.
const DEMO_KEYS = {
  'demo-bank-bml': { type: 'bank', bankId: 'bml' },
  'demo-bank-mib': { type: 'bank', bankId: 'mib' },
  'demo-terminal-raalhu': { type: 'terminal', merchantId: 'mer_raalhu_cafe' },
  'demo-terminal-mart': { type: 'terminal', merchantId: 'mer_hulhumale_mart' },
};

export const config = Object.freeze({
  port: int(env.PORT, 3000),
  nodeEnv: env.NODE_ENV || 'development',

  // Storage: "json" today, "postgres" when the pilot needs it.
  storeDriver: env.STORE_DRIVER || 'json',
  storePersistence: env.STORE_PERSISTENCE || 'file', // file | replit-object-storage
  storeFile: env.STORE_FILE || 'data/palmpay.json',
  storeObjectKey: env.STORE_OBJECT_KEY || 'palmpay/palmpay.json',

  // Banks: "simulated" (BML/MIB stand-ins inside this app) or a real connector later.
  bankConnector: env.BANK_CONNECTOR || 'simulated',
  simBankFile: env.SIM_BANK_FILE || 'data/sim-banks.json',
  simBankObjectKey: env.SIM_BANK_OBJECT_KEY || 'palmpay/sim-banks.json',
  simBankLatencyMs: int(env.SIM_BANK_LATENCY_MS, 350),

  partnerKeys: json(env.PARTNER_KEYS, DEMO_KEYS),

  // Biometrics: "hand-geometry" (MediaPipe landmarks, demo grade) or a vendor later.
  biometricProvider: env.BIOMETRIC_PROVIDER || 'hand-geometry',
  matchThreshold: num(env.MATCH_THRESHOLD, 0.075),
  matchMargin: num(env.MATCH_MARGIN, 0.8),
  // Same as the match threshold by default: a palm close enough to pay as
  // someone else is close enough to block a second enrolment.
  duplicateThreshold: num(env.DUPLICATE_THRESHOLD, num(env.MATCH_THRESHOLD, 0.075)),
  // Liveness checks against photos, screens and videos (demo grade).
  //   off | observe (measure and show the scores, never block) | enforce (block failed scans)
  livenessMode: ['off', 'observe', 'enforce'].includes(env.LIVENESS_MODE) ? env.LIVENESS_MODE : 'observe',
  livenessChecks: (env.LIVENESS_CHECKS || 'tremor,device,glare').split(',').map((x) => x.trim())
    .filter((x) => ['tremor', 'device', 'glare'].includes(x)),
  minTremor: num(env.MIN_TREMOR, 0.005), // palm widths a live hand moves on its own
  maxDeviceScore: num(env.MAX_DEVICE_SCORE, 0.5), // detector confidence that a phone/screen frames the hand
  maxGlare: num(env.MAX_GLARE, 0.05), // share of the palm that is shiny near-white glare
  objectModelUrl: env.OBJECT_MODEL_URL || 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite',
  handModelUrl:
    env.HAND_MODEL_URL ||
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',

  // Payments
  currency: 'MVR',
  defaultPalmLimit: int(env.DEFAULT_PALM_LIMIT_LAARI, 250_000), // MVR 2,500, customer can change
  maxPalmLimit: int(env.MAX_PALM_LIMIT_LAARI, 1_000_000), // MVR 10,000 ceiling set by PalmPay
  maxScanAttempts: int(env.MAX_SCAN_ATTEMPTS, 3),
  intentTtlSeconds: int(env.INTENT_TTL_SECONDS, 600),

  // Demo switches. Turn all off for anything that is not a demo.
  demoMode: bool(env.DEMO_MODE, true), // simulated scans + demo keys handed to the browser
  allowReset: bool(env.ALLOW_RESET, true),
  exposeMatchDebug: bool(env.EXPOSE_MATCH_DEBUG, true),
});
