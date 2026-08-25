// Raster import — the OpenCV.js/WASM half of FR-21's pipeline (deskew, adaptive
// threshold, morphological close, line segment detection). Everything after this —
// collinear merge, axis snap, wall graph construction, planar face traversal — is pure
// TypeScript in packages/core/src/rasterImport.ts and is unit-tested there; this file's
// job ends at handing that module a flat list of line segments in image-pixel coordinates.
//
// Not unit-tested: this needs a browser, the ~8 MB opencv.js WASM binary, and a real
// scanned floor plan to mean anything. It is written against OpenCV's long-stable,
// widely-documented core API (imread/cvtColor/adaptiveThreshold/morphologyEx/HoughLinesP)
// but has not been visually verified against a real scan — see the README's raster-import
// section for what that means for reliance on this file, and Mat cleanup below is
// deliberately paranoid (every intermediate .delete()d) since a WASM leak here silently
// grows without bound across imports/retries.

import type { LineSegment } from "@floorcraft/core";

// NFR-2: opencv.js is a multi-hundred-kilobyte-to-megabyte WASM payload — loaded only
// when raster import actually runs, never on first paint, and only once per session.
const OPENCV_SCRIPT_URL = "https://docs.opencv.org/4.x/opencv.js";

type CvMat = { delete(): void; rows: number; cols: number; data: Uint8Array; data32S: Int32Array };
type CvNamespace = {
  imread(source: HTMLImageElement | HTMLCanvasElement): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, ksize: unknown, sigmaX: number): void;
  adaptiveThreshold(src: CvMat, dst: CvMat, maxValue: number, method: number, type: number, blockSize: number, c: number): void;
  getStructuringElement(shape: number, ksize: unknown): CvMat;
  morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void;
  HoughLinesP(src: CvMat, lines: CvMat, rho: number, theta: number, threshold: number, minLineLength: number, maxLineGap: number): void;
  minAreaRect(points: CvMat): { angle: number; center: { x: number; y: number } };
  countNonZero(src: CvMat): number;
  matFromArray(rows: number, cols: number, type: number, array: number[]): CvMat;
  getRotationMatrix2D(center: { x: number; y: number }, angle: number, scale: number): CvMat;
  warpAffine(src: CvMat, dst: CvMat, m: CvMat, dsize: unknown): void;
  Mat: new (...args: unknown[]) => CvMat;
  Size: new (w: number, h: number) => unknown;
  Point: new (x: number, y: number) => unknown;
  COLOR_RGBA2GRAY: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  THRESH_BINARY_INV: number;
  MORPH_RECT: number;
  MORPH_CLOSE: number;
  CV_32SC2: number;
  onRuntimeInitialized?: () => void;
};

/**
 * What `loadOpenCv()` resolves with.
 *
 * The `cv` namespace is deliberately wrapped in a holder rather than being the promise's
 * own fulfilment value, and that indirection is load-bearing: opencv.js is an emscripten
 * MODULARIZE build, so the `cv` object carries its own `then` method (that's what makes
 * `await Module` work in emscripten's own API). That makes it a *thenable*, and resolving
 * a native promise with a thenable makes the promise adopt it — calling `cv.then(...)`,
 * which hands back the module again, which gets adopted again, forever. The result is not
 * a rejection but a wedged main thread: the tab freezes with no error to catch, and the
 * import UI sits on "Detecting walls and rooms…" until the page is closed. Wrapping keeps
 * the thenable out of the resolution path entirely. Do not "simplify" this back to
 * `Promise<CvNamespace>` — `.then((h) => h.cv)` re-introduces the exact same bug, because
 * a `then` callback's return value goes through the same thenable-adoption procedure.
 */
export type CvHandle = { cv: CvNamespace };

let cvPromise: Promise<CvHandle> | null = null;

/** opencv.js is slow to fetch (multi-megabyte) but not *this* slow — past this, something
 * is wrong in a way the user needs told about rather than spun on. */
const OPENCV_LOAD_TIMEOUT_MS = 120_000;

/** The runtime is usable once emscripten has finished instantiating the WASM module;
 * `cv.Mat` only becomes a constructor at that point. */
function runtimeReady(cv: CvNamespace | undefined): boolean {
  return typeof cv?.Mat === "function";
}

/** Injects the opencv.js script tag and resolves once its WASM runtime has initialized.
 * Cached so a second import in the same session reuses the already-loaded module. */
export function loadOpenCv(): Promise<CvHandle> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise<CvHandle>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The raster-import engine (opencv.js) took too long to load — check your connection and try again.")),
      OPENCV_LOAD_TIMEOUT_MS,
    );
    const succeed = (cv: CvNamespace) => {
      clearTimeout(timer);
      resolve({ cv });
    };
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };

    const existing = (globalThis as { cv?: CvNamespace }).cv;
    if (existing && runtimeReady(existing)) {
      succeed(existing);
      return;
    }

    const script = document.createElement("script");
    script.src = OPENCV_SCRIPT_URL;
    script.async = true;
    script.onerror = () => fail(new Error("Could not load the raster-import engine (opencv.js) — check your connection."));
    script.onload = () => {
      const cv = (globalThis as { cv?: CvNamespace }).cv;
      if (!cv) {
        fail(new Error("opencv.js loaded but did not define the expected global"));
        return;
      }
      // Two orderings are possible and both happen in the wild: the WASM module may still
      // be instantiating (the common case — wait on emscripten's ready hook), or it may
      // already have finished before the load event fired (a warm HTTP cache, a small
      // build), in which case the hook has *already* run and assigning to it would wait
      // for a callback that never comes.
      if (runtimeReady(cv)) {
        succeed(cv);
        return;
      }
      cv.onRuntimeInitialized = () => succeed(cv);
    };
    document.head.appendChild(script);
  });
  // A failed load must not poison the session: drop the cached rejection so a retry
  // (a flaky connection, a blocked CDN that later works) actually re-fetches.
  cvPromise.catch(() => {
    cvPromise = null;
  });
  return cvPromise;
}

export type PipelineOptions = {
  /** Adaptive threshold block size — must be odd; larger tolerates uneven scan lighting. */
  thresholdBlockSize?: number;
  /** Morphological close kernel size, in px — bridges small gaps in wall lines. */
  closeKernelPx?: number;
  /** Hough transform vote threshold — higher misses faint lines, lower adds noise. */
  houghThreshold?: number;
  minLineLengthPx?: number;
  maxLineGapPx?: number;
};

const DEFAULTS: Required<PipelineOptions> = {
  thresholdBlockSize: 35,
  closeKernelPx: 5,
  houghThreshold: 60,
  minLineLengthPx: 40,
  maxLineGapPx: 15,
};

/** Deskew measures its angle from every "ink" pixel, and a large scan has far more of
 * those than the measurement needs — a few tens of thousands already pin the dominant
 * tilt to well under a degree. Bounded so a phone photo doesn't build a multi-million
 * element array to answer the same question. */
const MAX_DESKEW_SAMPLE_POINTS = 20_000;

/**
 * The coordinates of the non-zero pixels of a CV_8UC1 binary image, as the CV_32SC2 point
 * Mat `minAreaRect` wants.
 *
 * This is what `cv.findNonZero` would do, done by hand on purpose: the opencv.js build
 * served from docs.opencv.org does not export `findNonZero` (it is absent from that
 * build's embind bindings, so `cv.findNonZero` is simply `undefined`), and calling it
 * throws a TypeError mid-pipeline. Returns null when the image has no ink at all, which
 * `minAreaRect` cannot be asked about.
 */
function inkPointsMat(cv: CvNamespace, binary: CvMat): CvMat | null {
  const total = cv.countNonZero(binary);
  if (total === 0) return null;
  const stride = Math.max(1, Math.ceil(total / MAX_DESKEW_SAMPLE_POINTS));
  const coords: number[] = [];
  const { rows, cols, data } = binary;
  let seen = 0;
  for (let y = 0; y < rows; y++) {
    const rowStart = y * cols;
    for (let x = 0; x < cols; x++) {
      if (data[rowStart + x] === 0) continue;
      if (seen++ % stride !== 0) continue;
      coords.push(x, y);
    }
  }
  if (coords.length === 0) return null;
  return cv.matFromArray(coords.length / 2, 1, cv.CV_32SC2, coords);
}

/**
 * FR-21's image-processing stages: deskew -> adaptive threshold -> morphological close ->
 * line segment detection. Returns raw segments in the (deskewed) image's own pixel space —
 * detectFloorPlan() in packages/core/src/rasterImport.ts picks up from here.
 */
export async function extractLineSegments(image: HTMLImageElement, options: PipelineOptions = {}): Promise<LineSegment[]> {
  const { cv } = await loadOpenCv();
  const opts = { ...DEFAULTS, ...options };

  const src = cv.imread(image);
  const gray = new cv.Mat();
  const roughThreshold = new cv.Mat();
  const deskewed = new cv.Mat();
  const thresholded = new cv.Mat();
  const closed = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(opts.closeKernelPx, opts.closeKernelPx));
  const lines = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);

    // Deskew: the minimum-area bounding rect of every non-background pixel gives the
    // dominant tilt of the whole drawing, which a phone photo or a slightly crooked scan
    // both produce. A first threshold pass finds "ink" pixels to measure the angle from,
    // then the actual detection runs on a rotated copy.
    cv.adaptiveThreshold(gray, roughThreshold, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, opts.thresholdBlockSize, 10);
    const inkPoints = inkPointsMat(cv, roughThreshold);
    // A blank or near-blank scan has no tilt to measure — leave it unrotated and let the
    // detection stages below find nothing, rather than failing here.
    const rect = inkPoints ? cv.minAreaRect(inkPoints) : { angle: 0, center: { x: gray.cols / 2, y: gray.rows / 2 } };
    inkPoints?.delete();
    // OpenCV's minAreaRect angle is in (-90, 0] and doesn't distinguish a wall grid from
    // its own 90-degree rotation — snap to the nearest 90 degrees so a mostly
    // axis-aligned drawing (every real floor plan, per this system's own axis-aligned
    // assumption) rotates by only its actual small skew, not by up to 45 degrees.
    const snapped = rect.angle % 90;
    const correction = snapped > 45 ? snapped - 90 : snapped < -45 ? snapped + 90 : snapped;
    const rotationMatrix = cv.getRotationMatrix2D(rect.center, correction, 1);
    cv.warpAffine(gray, deskewed, rotationMatrix, new cv.Size(gray.cols, gray.rows));
    rotationMatrix.delete();

    cv.adaptiveThreshold(deskewed, thresholded, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, opts.thresholdBlockSize, 10);
    cv.morphologyEx(thresholded, closed, cv.MORPH_CLOSE, kernel);
    cv.HoughLinesP(closed, lines, 1, Math.PI / 180, opts.houghThreshold, opts.minLineLengthPx, opts.maxLineGapPx);

    const segments: LineSegment[] = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4]!;
      const y1 = lines.data32S[i * 4 + 1]!;
      const x2 = lines.data32S[i * 4 + 2]!;
      const y2 = lines.data32S[i * 4 + 3]!;
      segments.push({ x1, y1, x2, y2 });
    }
    return segments;
  } finally {
    src.delete();
    gray.delete();
    roughThreshold.delete();
    deskewed.delete();
    thresholded.delete();
    closed.delete();
    kernel.delete();
    lines.delete();
  }
}
