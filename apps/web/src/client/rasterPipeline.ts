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

type CvMat = { delete(): void; rows: number; cols: number; data32S: Int32Array };
type CvNamespace = {
  imread(source: HTMLImageElement | HTMLCanvasElement): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, ksize: unknown, sigmaX: number): void;
  adaptiveThreshold(src: CvMat, dst: CvMat, maxValue: number, method: number, type: number, blockSize: number, c: number): void;
  getStructuringElement(shape: number, ksize: unknown): CvMat;
  morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void;
  HoughLinesP(src: CvMat, lines: CvMat, rho: number, theta: number, threshold: number, minLineLength: number, maxLineGap: number): void;
  minAreaRect(points: CvMat): { angle: number; center: { x: number; y: number } };
  findNonZero(src: CvMat, dst: CvMat): void;
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
  onRuntimeInitialized?: () => void;
};

let cvPromise: Promise<CvNamespace> | null = null;

/** Injects the opencv.js script tag and resolves once its WASM runtime has initialized.
 * Cached so a second import in the same session reuses the already-loaded module. */
export function loadOpenCv(): Promise<CvNamespace> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const existing = (globalThis as { cv?: CvNamespace }).cv;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = OPENCV_SCRIPT_URL;
    script.async = true;
    script.onerror = () => reject(new Error("Could not load the raster-import engine (opencv.js) — check your connection."));
    script.onload = () => {
      const cv = (globalThis as { cv?: CvNamespace }).cv;
      if (!cv) {
        reject(new Error("opencv.js loaded but did not define the expected global"));
        return;
      }
      // The emscripten module exposes `onRuntimeInitialized` as the WASM-ready signal —
      // the module object exists synchronously on script load, but calling into it
      // (imread etc.) before this fires throws.
      if ("onRuntimeInitialized" in cv) {
        cv.onRuntimeInitialized = () => resolve(cv);
      } else {
        resolve(cv);
      }
    };
    document.head.appendChild(script);
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

/**
 * FR-21's image-processing stages: deskew -> adaptive threshold -> morphological close ->
 * line segment detection. Returns raw segments in the (deskewed) image's own pixel space —
 * detectFloorPlan() in packages/core/src/rasterImport.ts picks up from here.
 */
export async function extractLineSegments(image: HTMLImageElement, options: PipelineOptions = {}): Promise<LineSegment[]> {
  const cv = await loadOpenCv();
  const opts = { ...DEFAULTS, ...options };

  const src = cv.imread(image);
  const gray = new cv.Mat();
  const roughThreshold = new cv.Mat();
  const nonZero = new cv.Mat();
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
    cv.findNonZero(roughThreshold, nonZero);
    const rect = cv.minAreaRect(nonZero);
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
    nonZero.delete();
    deskewed.delete();
    thresholded.delete();
    closed.delete();
    kernel.delete();
    lines.delete();
  }
}
