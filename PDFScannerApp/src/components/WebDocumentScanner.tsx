import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  createDocumentScanner,
  DocumentCorners,
  DocumentPoint,
} from '@/utils/document-scanner';

type WebDocumentScannerProps = {
  visible: boolean;
  onCancel: () => void;
  onCapture: (page: { uri: string; width?: number; height?: number }) => void;
  onError: (message: string) => void;
};

type DetectedDocument = {
  corners: DocumentCorners;
  frameWidth: number;
  frameHeight: number;
  areaRatio: number;
  center: DocumentPoint;
};

type ScannerInstance = Awaited<ReturnType<typeof createDocumentScanner>>;

const A4_WIDTH = 1240;
const A4_HEIGHT = 1754;
const A4_RATIO = A4_HEIGHT / A4_WIDTH;
const DETECT_INTERVAL_MS = 260;
const AUTO_CAPTURE_STABLE_MS = 950;
const AUTO_CAPTURE_COOLDOWN_MS = 2200;
const DOCUMENT_ACCENT = '#2F86FF';
const DOCUMENT_RATIO_MIN = 1.16;
const DOCUMENT_RATIO_MAX = 1.7;

const distance = (a: DocumentPoint, b: DocumentPoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const hasCorners = (corners: Partial<DocumentCorners>): corners is DocumentCorners =>
  Boolean(
    corners.topLeftCorner &&
      corners.topRightCorner &&
      corners.bottomLeftCorner &&
      corners.bottomRightCorner
  );

const averagePoint = (points: DocumentPoint[]): DocumentPoint => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});

const polygonArea = (points: DocumentPoint[]) => {
  let sum = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }

  return Math.abs(sum) / 2;
};

const cornerList = (corners: DocumentCorners) => [
  corners.topLeftCorner,
  corners.topRightCorner,
  corners.bottomRightCorner,
  corners.bottomLeftCorner,
];

const toFullSizeCorners = (
  corners: DocumentCorners,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): DocumentCorners => {
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const scale = (point: DocumentPoint) => ({
    x: point.x * scaleX,
    y: point.y * scaleY,
  });

  return {
    topLeftCorner: scale(corners.topLeftCorner),
    topRightCorner: scale(corners.topRightCorner),
    bottomLeftCorner: scale(corners.bottomLeftCorner),
    bottomRightCorner: scale(corners.bottomRightCorner),
  };
};

const isDocumentLike = (
  corners: DocumentCorners,
  frameWidth: number,
  frameHeight: number
) => {
  const points = cornerList(corners);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const marginX = frameWidth * 0.01;
  const marginY = frameHeight * 0.01;

  if (
    minX < marginX ||
    maxX > frameWidth - marginX ||
    minY < marginY ||
    maxY > frameHeight - marginY
  ) {
    return null;
  }

  const topWidth = distance(corners.topLeftCorner, corners.topRightCorner);
  const bottomWidth = distance(corners.bottomLeftCorner, corners.bottomRightCorner);
  const leftHeight = distance(corners.topLeftCorner, corners.bottomLeftCorner);
  const rightHeight = distance(corners.topRightCorner, corners.bottomRightCorner);
  const averageWidth = (topWidth + bottomWidth) / 2;
  const averageHeight = (leftHeight + rightHeight) / 2;

  if (averageWidth < frameWidth * 0.18 || averageHeight < frameHeight * 0.18) {
    return null;
  }

  const longSide = Math.max(averageWidth, averageHeight);
  const shortSide = Math.min(averageWidth, averageHeight);
  const ratio = longSide / shortSide;
  const areaRatio = polygonArea(points) / (frameWidth * frameHeight);
  const oppositeWidthBalance = Math.min(topWidth, bottomWidth) / Math.max(topWidth, bottomWidth);
  const oppositeHeightBalance = Math.min(leftHeight, rightHeight) / Math.max(leftHeight, rightHeight);

  if (ratio < DOCUMENT_RATIO_MIN || ratio > DOCUMENT_RATIO_MAX) return null;
  if (areaRatio < 0.07 || areaRatio > 0.72) return null;
  if (oppositeWidthBalance < 0.5 || oppositeHeightBalance < 0.5) return null;

  return {
    areaRatio,
    center: averagePoint(points),
  };
};

const detectionShift = (current: DetectedDocument, previous: DetectedDocument | null) => {
  if (!previous) return Number.POSITIVE_INFINITY;

  const frameDiagonal = Math.hypot(current.frameWidth, current.frameHeight);
  const centerShift = distance(current.center, previous.center) / frameDiagonal;
  const areaShift = Math.abs(current.areaRatio - previous.areaRatio);

  return centerShift + areaShift;
};

const enhanceDocumentCanvas = (source: HTMLCanvasElement) => {
  const canvas = document.createElement('canvas');
  canvas.width = A4_WIDTH;
  canvas.height = A4_HEIGHT;

  const context = canvas.getContext('2d');
  if (!context) return source;

  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    const boosted = Math.max(0, Math.min(255, (luminance - 126) * 1.45 + 150));
    const paperLift = boosted > 168 ? Math.min(255, boosted + 48) : boosted;
    const inkDeepen = paperLift < 136 ? Math.max(0, paperLift - 34) : paperLift;
    const saturation = 0.78;

    data[index] = Math.max(0, Math.min(255, inkDeepen + (red - luminance) * saturation));
    data[index + 1] = Math.max(0, Math.min(255, inkDeepen + (green - luminance) * saturation));
    data[index + 2] = Math.max(0, Math.min(255, inkDeepen + (blue - luminance) * saturation));
  }

  context.putImageData(image, 0, 0);
  context.filter = 'contrast(1.22) brightness(1.08) saturate(1.08)';
  context.drawImage(canvas, 0, 0);
  context.filter = 'none';

  return canvas;
};

const fallbackGuideCorners = (width: number, height: number): DocumentCorners => {
  const guideLeft = width * 0.06;
  const guideRight = width * 0.94;
  const guideTop = height * 0.12;
  const guideBottom = height * 0.84;
  const maxWidth = guideRight - guideLeft;
  const maxHeight = guideBottom - guideTop;
  let cropHeight = maxHeight;
  let cropWidth = cropHeight / A4_RATIO;

  if (cropWidth > maxWidth) {
    cropWidth = maxWidth;
    cropHeight = cropWidth * A4_RATIO;
  }

  const left = guideLeft + (maxWidth - cropWidth) / 2;
  const top = guideTop + (maxHeight - cropHeight) / 2;
  const right = left + cropWidth;
  const bottom = top + cropHeight;

  return {
    topLeftCorner: { x: left, y: top },
    topRightCorner: { x: right, y: top },
    bottomLeftCorner: { x: left, y: bottom },
    bottomRightCorner: { x: right, y: bottom },
  };
};

const captureA4Document = (
  video: HTMLVideoElement,
  scanner: ScannerInstance,
  detected: DetectedDocument | null
) => {
  const frame = document.createElement('canvas');
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext('2d')?.drawImage(video, 0, 0, frame.width, frame.height);

  if (detected) {
    const corners = toFullSizeCorners(
      detected.corners,
      detected.frameWidth,
      detected.frameHeight,
      frame.width,
      frame.height
    );
    const extracted = scanner.extractPaper(frame, A4_WIDTH, A4_HEIGHT, corners);

    if (extracted) {
      return enhanceDocumentCanvas(extracted);
    }
  }

  const fallbackExtracted = scanner.extractPaper(
    frame,
    A4_WIDTH,
    A4_HEIGHT,
    fallbackGuideCorners(frame.width, frame.height)
  );

  if (fallbackExtracted) {
    return enhanceDocumentCanvas(fallbackExtracted);
  }

  return enhanceDocumentCanvas(frame);
};

const drawOverlay = (
  canvas: HTMLCanvasElement,
  detected: DetectedDocument | null,
  videoWidth: number,
  videoHeight: number
) => {
  const rect = canvas.getBoundingClientRect();
  const context = canvas.getContext('2d');
  if (!context || rect.width === 0 || rect.height === 0) return;

  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * pixelRatio);
  canvas.height = Math.round(rect.height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  if (!detected) return;

  const fullCorners = toFullSizeCorners(
    detected.corners,
    detected.frameWidth,
    detected.frameHeight,
    videoWidth,
    videoHeight
  );
  const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight);
  const offsetX = (rect.width - videoWidth * scale) / 2;
  const offsetY = (rect.height - videoHeight * scale) / 2;
  const point = (corner: DocumentPoint) => ({
    x: corner.x * scale + offsetX,
    y: corner.y * scale + offsetY,
  });

  const topLeft = point(fullCorners.topLeftCorner);
  const topRight = point(fullCorners.topRightCorner);
  const bottomRight = point(fullCorners.bottomRightCorner);
  const bottomLeft = point(fullCorners.bottomLeftCorner);

  context.fillStyle = 'rgba(47, 134, 255, 0.18)';
  context.strokeStyle = DOCUMENT_ACCENT;
  context.lineWidth = 6;
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(topLeft.x, topLeft.y);
  context.lineTo(topRight.x, topRight.y);
  context.lineTo(bottomRight.x, bottomRight.y);
  context.lineTo(bottomLeft.x, bottomLeft.y);
  context.closePath();
  context.fill();
  context.stroke();
};

export function WebDocumentScanner({
  visible,
  onCancel,
  onCapture,
  onError,
}: WebDocumentScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const scannerRef = useRef<ScannerInstance | null>(null);
  const detectedRef = useRef<DetectedDocument | null>(null);
  const previousDetectedRef = useRef<DetectedDocument | null>(null);
  const stableSinceRef = useRef<number | null>(null);
  const lastAutoCaptureAtRef = useRef(0);
  const autoCaptureRef = useRef(true);
  const isCapturingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDetectAtRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
  const [hint, setHint] = useState('書類を画面内に入れてください');

  useEffect(() => {
    autoCaptureRef.current = autoCaptureEnabled;
  }, [autoCaptureEnabled]);

  const capture = useCallback(async (reason: 'manual' | 'auto') => {
    const video = videoRef.current;
    const scanner = scannerRef.current;
    if (!video || !scanner || !video.videoWidth || !video.videoHeight || isCapturingRef.current) return;

    try {
      isCapturingRef.current = true;
      setIsCapturing(true);
      setCaptureFlash(true);
      window.setTimeout(() => setCaptureFlash(false), 170);
      setHint(reason === 'auto' ? '自動撮影しました' : 'スキャンしています');
      const result = await captureA4Document(video, scanner, detectedRef.current);

      onCapture({
        uri: result.toDataURL('image/jpeg', 0.95),
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      console.error('[WebScanner] failed to capture scan', error);
      onError(error instanceof Error ? error.message : 'スキャン画像の作成に失敗しました。');
    } finally {
      isCapturingRef.current = false;
      setIsCapturing(false);
    }
  }, [onCapture, onError]);

  useEffect(() => {
    if (!visible) return undefined;

    let active = true;

    const resetDetection = () => {
      detectedRef.current = null;
      previousDetectedRef.current = null;
      stableSinceRef.current = null;
    };

    const stop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      resetDetection();
      setReady(false);
    };

    const detect = () => {
      if (!active) return;

      const video = videoRef.current;
      const overlay = overlayRef.current;
      const frameCanvas = frameRef.current;
      const scanner = scannerRef.current;

      if (video && overlay && frameCanvas && scanner && video.videoWidth && video.videoHeight) {
        const now = performance.now();

        if (now - lastDetectAtRef.current > DETECT_INTERVAL_MS) {
          lastDetectAtRef.current = now;
          const frameScale = Math.min(1, 920 / video.videoWidth);
          frameCanvas.width = Math.round(video.videoWidth * frameScale);
          frameCanvas.height = Math.round(video.videoHeight * frameScale);
          const frameContext = frameCanvas.getContext('2d');

          if (frameContext) {
            frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
            const scannerWindow = window as typeof window & {
              cv?: {
                imread: (source: HTMLCanvasElement) => { delete: () => void };
              };
            };

            if (scannerWindow.cv) {
              const mat = scannerWindow.cv.imread(frameCanvas);
              const contour = scanner.findPaperContour(mat);
              let nextDetected: DetectedDocument | null = null;

              if (contour) {
                const corners = scanner.getCornerPoints(contour);
                if (hasCorners(corners)) {
                  const match = isDocumentLike(corners, frameCanvas.width, frameCanvas.height);
                  if (match) {
                    nextDetected = {
                      corners,
                      frameWidth: frameCanvas.width,
                      frameHeight: frameCanvas.height,
                      areaRatio: match.areaRatio,
                      center: match.center,
                    };
                  }
                }
                contour.delete();
              }

              mat.delete();

              if (nextDetected) {
                const shift = detectionShift(nextDetected, previousDetectedRef.current);
                stableSinceRef.current =
                  shift < 0.04 ? stableSinceRef.current ?? now : now;
                previousDetectedRef.current = nextDetected;
                detectedRef.current = nextDetected;
                setHint(autoCaptureRef.current ? '書類を検出中 自動撮影します' : '書類を検出中');

                const stableFor = now - (stableSinceRef.current ?? now);
                const canAutoCapture =
                  autoCaptureRef.current &&
                  stableFor > AUTO_CAPTURE_STABLE_MS &&
                  now - lastAutoCaptureAtRef.current > AUTO_CAPTURE_COOLDOWN_MS &&
                  !isCapturingRef.current;

                if (canAutoCapture) {
                  lastAutoCaptureAtRef.current = now;
                  void capture('auto');
                }
              } else {
                resetDetection();
                setHint('A4書類を画面内に入れてください');
              }
            }
          }
        }

        drawOverlay(overlay, detectedRef.current, video.videoWidth, video.videoHeight);
      }

      rafRef.current = requestAnimationFrame(detect);
    };

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('このブラウザではカメラを起動できません。');
        }

        setReady(false);
        setHint('スキャナーを準備しています');
        scannerRef.current = await createDocumentScanner();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play();
        setReady(true);
        setHint('A4書類を画面内に入れてください');
        detect();
      } catch (error) {
        console.error('[WebScanner] failed to start camera', error);
        onError(error instanceof Error ? error.message : 'スキャン用カメラを起動できませんでした。');
        onCancel();
      }
    };

    void start();

    return () => {
      active = false;
      stop();
    };
  }, [capture, onCancel, onError, visible]);

  if (!visible || typeof document === 'undefined') return null;

  return createPortal(
    <div style={styles.root}>
      <video ref={videoRef} playsInline muted autoPlay style={styles.video} />
      <canvas ref={overlayRef} style={styles.overlay} />
      <canvas ref={frameRef} style={styles.hiddenCanvas} />
      <div style={styles.scanFrame} aria-hidden="true">
        <span style={{ ...styles.frameCorner, ...styles.frameCornerTopLeft }} />
        <span style={{ ...styles.frameCorner, ...styles.frameCornerTopRight }} />
        <span style={{ ...styles.frameCorner, ...styles.frameCornerBottomLeft }} />
        <span style={{ ...styles.frameCorner, ...styles.frameCornerBottomRight }} />
        <span style={styles.scanLine} />
      </div>
      {captureFlash ? <div style={styles.flash} /> : null}

      <button type="button" aria-label="閉じる" onClick={onCancel} style={styles.closeButton}>
        x
      </button>

      <div style={styles.topPill}>
        <span style={ready ? styles.readyDot : styles.loadingDot} />
      </div>

      <div style={styles.statusPanel}>
        <span style={styles.statusText}>{hint}</span>
      </div>

      <button
        type="button"
        aria-pressed={autoCaptureEnabled}
        onClick={() => setAutoCaptureEnabled((current) => !current)}
        style={{
          ...styles.autoToggle,
          ...(autoCaptureEnabled ? styles.autoToggleOn : styles.autoToggleOff),
        }}
      >
        自動シャッター {autoCaptureEnabled ? 'ON' : 'OFF'}
      </button>

      <button
        type="button"
        aria-label="スキャン撮影"
        onClick={() => {
          void capture('manual');
        }}
        disabled={!ready || isCapturing}
        style={{
          ...styles.shutter,
          opacity: ready && !isCapturing ? 1 : 0.55,
        }}
      >
        <span style={styles.shutterInner} />
      </button>
    </div>,
    document.body
  );
}

const styles = {
  root: {
    position: 'fixed',
    inset: 0,
    zIndex: 10000,
    backgroundColor: '#000',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  video: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  hiddenCanvas: {
    display: 'none',
  },
  scanFrame: {
    position: 'absolute',
    left: '6%',
    right: '6%',
    top: '12%',
    bottom: '16%',
    borderRadius: 4,
    pointerEvents: 'none',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.28)',
  },
  frameCorner: {
    position: 'absolute',
    width: 46,
    height: 46,
    borderColor: DOCUMENT_ACCENT,
    opacity: 0.95,
  },
  frameCornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 5,
    borderLeftWidth: 5,
    borderTopStyle: 'solid',
    borderLeftStyle: 'solid',
    borderTopLeftRadius: 4,
  },
  frameCornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 5,
    borderRightWidth: 5,
    borderTopStyle: 'solid',
    borderRightStyle: 'solid',
    borderTopRightRadius: 4,
  },
  frameCornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 5,
    borderLeftWidth: 5,
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    borderBottomLeftRadius: 4,
  },
  frameCornerBottomRight: {
    right: 0,
    bottom: 0,
    borderRightWidth: 5,
    borderBottomWidth: 5,
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderBottomRightRadius: 4,
  },
  scanLine: {
    position: 'absolute',
    left: 22,
    right: 22,
    top: '50%',
    height: 2,
    borderRadius: 999,
    background: 'rgba(47, 134, 255, 0.65)',
    boxShadow: '0 0 18px rgba(47, 134, 255, 0.8)',
  },
  flash: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(255,255,255,0.72)',
    pointerEvents: 'none',
  },
  closeButton: {
    position: 'absolute',
    top: 'max(24px, env(safe-area-inset-top))',
    left: 24,
    width: 58,
    height: 58,
    borderRadius: 29,
    border: '1px solid rgba(255,255,255,0.28)',
    background: 'rgba(18, 34, 45, 0.62)',
    color: '#fff',
    fontSize: 36,
    lineHeight: '48px',
    cursor: 'pointer',
    backdropFilter: 'blur(10px)',
  },
  topPill: {
    position: 'absolute',
    top: 'max(18px, env(safe-area-inset-top))',
    left: '50%',
    width: 180,
    height: 54,
    borderRadius: 27,
    transform: 'translateX(-50%)',
    background: '#000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  readyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    background: '#64D96E',
  },
  loadingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    background: '#D8A83A',
  },
  statusPanel: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 'calc(162px + env(safe-area-inset-bottom))',
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  statusText: {
    maxWidth: 320,
    borderRadius: 18,
    padding: '9px 14px',
    background: 'rgba(0, 0, 0, 0.52)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    textAlign: 'center',
    backdropFilter: 'blur(8px)',
  },
  autoToggle: {
    position: 'absolute',
    left: '50%',
    bottom: 'calc(112px + env(safe-area-inset-bottom))',
    transform: 'translateX(-50%)',
    minWidth: 178,
    borderRadius: 999,
    padding: '12px 18px',
    color: '#fff',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer',
    backdropFilter: 'blur(10px)',
  },
  autoToggleOn: {
    border: '1px solid rgba(242,194,61,0.72)',
    background: 'rgba(79, 58, 15, 0.74)',
  },
  autoToggleOff: {
    border: '1px solid rgba(255,255,255,0.3)',
    background: 'rgba(24, 34, 46, 0.72)',
  },
  shutter: {
    position: 'absolute',
    left: '50%',
    bottom: 'calc(14px + env(safe-area-inset-bottom))',
    width: 90,
    height: 90,
    borderRadius: 45,
    transform: 'translateX(-50%)',
    border: '3px solid rgba(255,255,255,0.25)',
    background: 'rgba(0,0,0,0.48)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  shutterInner: {
    width: 66,
    height: 66,
    borderRadius: 33,
    background: '#fff',
    display: 'block',
  },
} satisfies Record<string, CSSProperties>;
