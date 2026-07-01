import { useEffect, useState } from 'react';
import {
    Alert,
    Image,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import DraggableFlatList, {
    RenderItemParams,
} from 'react-native-draggable-flatlist';

import { PdfPreview } from '@/components/PdfPreview';
import { WebDocumentScanner } from '@/components/WebDocumentScanner';

type ScanPage = {
  id: string;
  sourceType: 'image' | 'pdf';
  uri: string;
  previewUri?: string;
  fileName: string;
  fileSize: number;
  createdAt: number;
  mimeType?: string;
  width?: number;
  height?: number;
  pageCount?: number;
  base64?: string;
};

type PdfHistoryItem = {
  id: string;
  fileName: string;
  uri: string;
  previewUri?: string;
  createdAt: number;
  pageCount: number;
  fileSize: number;
};

type ActiveTab = 'scan' | 'created';
type CameraMode = 'scan' | 'photo';

type ScannedPageInput = {
  uri: string;
  width?: number;
  height?: number;
};

type PendingPdf = {
  id: string;
  pdfDataUri: string;
  previewDataUri?: string;
  createdAt: number;
  pageCount: number;
  fileSize: number;
};

const PDF_HISTORY_STORAGE_KEY = 'pdfscanner.createdPdfs.v1';
const PDF_HISTORY_WEB_DB_NAME = 'pdfscanner.history.db';
const PDF_HISTORY_WEB_STORE_NAME = 'pdfHistory';
const PDF_HISTORY_WEB_RECORD_KEY = 'items';
const PDF_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CAMERA_PERMISSION_STORAGE_KEY = 'pdfscanner.cameraPermissionAsked.v1';
const PDFJS_SCRIPT_ID = 'pdfjs-preview-renderer';
const PDFJS_VERSION = '3.11.174';
const A4_PORTRAIT_WIDTH = 595.28;
const A4_PORTRAIT_HEIGHT = 841.89;
const PDF_IMAGE_PAGE_MARGIN = 36;
const WEB_CACHE_CLEARED_STORAGE_KEY = 'pdfscanner.webCacheCleared.v1';

type PdfProgressCallback = (progress: number) => void;
type PdfJsViewport = {
  width: number;
  height: number;
};
type PdfJsRenderTask = {
  promise: Promise<void>;
};
type PdfJsPage = {
  getViewport: (options: { scale: number }) => PdfJsViewport;
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfJsViewport;
  }) => PdfJsRenderTask;
};
type PdfJsDocument = {
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
};
type PdfJsLib = {
  GlobalWorkerOptions: {
    workerSrc: string;
  };
  getDocument: (options: { data: Uint8Array }) => {
    promise: Promise<PdfJsDocument>;
  };
};

const isJpegPage = (page: ScanPage) => {
  const mimeType = page.mimeType?.toLowerCase() ?? '';
  const fileName = page.fileName.toLowerCase();
  return mimeType.includes('jpeg') || mimeType.includes('jpg') || /\.(jpe?g)$/i.test(fileName);
};

const isPdfPage = (page: ScanPage) => {
  const mimeType = page.mimeType?.toLowerCase() ?? '';
  return page.sourceType === 'pdf' || mimeType.includes('pdf') || /\.pdf$/i.test(page.fileName);
};

const isDocumentPickerPdfAsset = (asset: DocumentPicker.DocumentPickerAsset) => {
  const mimeType = asset.mimeType?.toLowerCase() ?? '';
  return mimeType.includes('pdf') || /\.pdf$/i.test(asset.name) || /\.pdf$/i.test(asset.uri);
};

const isDocumentPickerImageAsset = (asset: DocumentPicker.DocumentPickerAsset) => {
  const mimeType = asset.mimeType?.toLowerCase() ?? '';
  return (
    mimeType.includes('jpeg') ||
    mimeType.includes('jpg') ||
    mimeType.includes('png') ||
    /\.(jpe?g|png)$/i.test(asset.name)
  );
};

const isImagePickerSupportedAsset = (asset: ImagePicker.ImagePickerAsset) => {
  const mimeType = asset.mimeType?.toLowerCase() ?? '';
  const fileName = asset.fileName?.toLowerCase() ?? '';
  const uri = asset.uri.toLowerCase();

  return (
    mimeType.includes('jpeg') ||
    mimeType.includes('jpg') ||
    mimeType.includes('png') ||
    /\.(jpe?g|png)$/i.test(fileName) ||
    /\.(jpe?g|png)(?:\?|#|$)/i.test(uri)
  );
};

const warnUnsupportedFiles = () => {
  Alert.alert('ファイルを追加できません', 'png／jpeg／PDFファイル以外は追加できません。');
};

const getImageDataUrl = async (page: ScanPage) => {
  const imageBase64 = await readImageBase64(page);
  const mimeType = isJpegPage(page) ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${imageBase64}`;
};

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Blobをbase64に変換できませんでした。'));
        return;
      }

      resolve(reader.result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Blobの読み込みに失敗しました。'));
    reader.readAsDataURL(blob);
  });

const readFileBase64 = async (uri: string, fileName: string) => {
  if (uri.startsWith('data:')) {
    return uri.split(',')[1] ?? '';
  }

  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`ファイルを読み込めませんでした: ${response.status} ${fileName}`);
    }

    return blobToBase64(await response.blob());
  }

  const FileSystem = await import('expo-file-system/legacy');

  return FileSystem.readAsStringAsync(uri, {
    encoding: 'base64',
  });
};

const readImageBase64 = async (page: ScanPage) =>
  page.base64 ?? readFileBase64(page.uri, page.fileName);

const readPdfBase64 = async (page: ScanPage) =>
  page.base64 ?? readFileBase64(page.uri, page.fileName);

const getPageCount = (page: ScanPage) => (isPdfPage(page) ? page.pageCount ?? 1 : 1);

const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const loadPdfJs = () =>
  new Promise<PdfJsLib>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('PDFプレビューを生成できません。'));
      return;
    }

    const pdfJsWindow = window as typeof window & { pdfjsLib?: PdfJsLib };
    if (pdfJsWindow.pdfjsLib) {
      resolve(pdfJsWindow.pdfjsLib);
      return;
    }

    const existingScript = document.getElementById(PDFJS_SCRIPT_ID) as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener('load', () => {
        if (pdfJsWindow.pdfjsLib) resolve(pdfJsWindow.pdfjsLib);
        else reject(new Error('PDFプレビューを初期化できません。'));
      }, { once: true });
      existingScript.addEventListener('error', () => reject(new Error('PDFプレビューを読み込めません。')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.id = PDFJS_SCRIPT_ID;
    script.src = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
    script.async = true;
    script.onload = () => {
      if (!pdfJsWindow.pdfjsLib) {
        reject(new Error('PDFプレビューを初期化できません。'));
        return;
      }

      resolve(pdfJsWindow.pdfjsLib);
    };
    script.onerror = () => reject(new Error('PDFプレビューを読み込めません。'));
    document.head.appendChild(script);
  });

const createPdfFirstPagePreviewDataUri = async (base64: string) => {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;

  try {
    const pdfjsLib = await loadPdfJs();
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;

    const documentProxy = await pdfjsLib.getDocument({ data: base64ToBytes(base64) }).promise;
    const page = await documentProxy.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, Math.max(0.5, 360 / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext('2d');
    if (!context) return undefined;

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;

    return canvas.toDataURL('image/jpeg', 0.88);
  } catch (error) {
    console.warn('[PDF] failed to create first page preview', error);
    return undefined;
  }
};

const getContainedImageFrame = (
  imageWidth: number,
  imageHeight: number,
  pageWidth: number,
  pageHeight: number,
  margin = 0,
) => {
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const safeMargin = Math.max(0, Math.min(margin, pageWidth / 2, pageHeight / 2));
  const availableWidth = Math.max(1, pageWidth - safeMargin * 2);
  const availableHeight = Math.max(1, pageHeight - safeMargin * 2);
  const scale = Math.min(availableWidth / safeImageWidth, availableHeight / safeImageHeight);
  const width = safeImageWidth * scale;
  const height = safeImageHeight * scale;

  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
};

const createSingleImagePdfDataUri = async (page: ScanPage) => {
  const { jsPDF } = await import('jspdf/dist/jspdf.es.min.js');
  const imageDataUrl = await getImageDataUrl(page);
  const probeDocument = new jsPDF({
    unit: 'pt',
    format: 'a4',
  });
  const imageProperties = probeDocument.getImageProperties(imageDataUrl);
  const imageWidth = imageProperties.width;
  const imageHeight = imageProperties.height;
  const isLandscape = imageWidth > imageHeight;
  const pageWidth = isLandscape ? A4_PORTRAIT_HEIGHT : A4_PORTRAIT_WIDTH;
  const pageHeight = isLandscape ? A4_PORTRAIT_WIDTH : A4_PORTRAIT_HEIGHT;
  const imageFrame = getContainedImageFrame(
    imageWidth,
    imageHeight,
    pageWidth,
    pageHeight,
    PDF_IMAGE_PAGE_MARGIN,
  );
  const document = new jsPDF({
    orientation: isLandscape ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [pageWidth, pageHeight],
    compress: true,
  });

  document.addImage(
    imageDataUrl,
    isJpegPage(page) ? 'JPEG' : 'PNG',
    imageFrame.x,
    imageFrame.y,
    imageFrame.width,
    imageFrame.height,
  );

  return {
    pdfDataUri: document.output('datauristring'),
    previewDataUri: imageDataUrl,
  };
};

const createMergedPdf = async (pages: ScanPage[], onProgress?: PdfProgressCallback) => {
  console.log('[PDF] creating merged PDF with pdf-lib', { count: pages.length });

  const { PDFDocument } = await import('pdf-lib/dist/pdf-lib.esm.min.js');
  const document = await PDFDocument.create();
  let previewDataUri: string | undefined;
  const totalPages = Math.max(1, pages.length);
  const pageProgressSpan = 92 / totalPages;

  onProgress?.(2);

  for (const [index, page] of pages.entries()) {
    const pageStartProgress = 2 + index * pageProgressSpan;
    onProgress?.(pageStartProgress);

    if (isPdfPage(page)) {
      const sourcePdf = await PDFDocument.load(await readPdfBase64(page), {
        ignoreEncryption: true,
      });
      const copiedPages = await document.copyPages(sourcePdf, sourcePdf.getPageIndices());
      copiedPages.forEach((copiedPage) => {
        document.addPage(copiedPage);
      });
      previewDataUri ??= page.previewUri;
      onProgress?.(2 + (index + 1) * pageProgressSpan);
      continue;
    }

    const imagePdf = await createSingleImagePdfDataUri(page);
    onProgress?.(pageStartProgress + pageProgressSpan * 0.58);
    const sourcePdf = await PDFDocument.load(imagePdf.pdfDataUri, {
      ignoreEncryption: true,
    });
    const [copiedPage] = await document.copyPages(sourcePdf, [0]);
    document.addPage(copiedPage);

    previewDataUri ??= imagePdf.previewDataUri;
    onProgress?.(2 + (index + 1) * pageProgressSpan);
  }

  onProgress?.(96);
  const pdfDataUri = await document.saveAsBase64({
    dataUri: true,
  });
  onProgress?.(100);

  return {
    pdfDataUri,
    previewDataUri,
    pageCount: document.getPageCount(),
  };
};

const getPdfHistoryFileUri = async () => {
  const FileSystem = await import('expo-file-system/legacy');
  return `${FileSystem.documentDirectory}${PDF_HISTORY_STORAGE_KEY}.json`;
};

const openWebPdfHistoryDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PDF_HISTORY_WEB_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PDF_HISTORY_WEB_STORE_NAME)) {
        database.createObjectStore(PDF_HISTORY_WEB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('PDF履歴DBを開けませんでした。'));
  });

const readWebPdfHistory = async () => {
  const database = await openWebPdfHistoryDb();

  try {
    const history = await new Promise<PdfHistoryItem[]>((resolve, reject) => {
      const transaction = database.transaction(PDF_HISTORY_WEB_STORE_NAME, 'readonly');
      const store = transaction.objectStore(PDF_HISTORY_WEB_STORE_NAME);
      const request = store.get(PDF_HISTORY_WEB_RECORD_KEY);

      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error ?? new Error('PDF履歴を読み込めませんでした。'));
    });

    if (history.length > 0) return history;

    const legacyRaw = localStorage.getItem(PDF_HISTORY_STORAGE_KEY);
    if (!legacyRaw) return [];

    const legacyHistory = JSON.parse(legacyRaw) as PdfHistoryItem[];
    await writeWebPdfHistory(legacyHistory);
    localStorage.removeItem(PDF_HISTORY_STORAGE_KEY);
    return legacyHistory;
  } finally {
    database.close();
  }
};

const writeWebPdfHistory = async (history: PdfHistoryItem[]) => {
  const database = await openWebPdfHistoryDb();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PDF_HISTORY_WEB_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(PDF_HISTORY_WEB_STORE_NAME);
      const request = store.put(history, PDF_HISTORY_WEB_RECORD_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('PDF履歴を保存できませんでした。'));
    });
    localStorage.removeItem(PDF_HISTORY_STORAGE_KEY);
  } finally {
    database.close();
  }
};

const readPdfHistory = async (): Promise<PdfHistoryItem[]> => {
  try {
    if (Platform.OS === 'web') {
      return readWebPdfHistory();
    }

    const FileSystem = await import('expo-file-system/legacy');
    const fileUri = await getPdfHistoryFileUri();
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) return [];

    const raw = await FileSystem.readAsStringAsync(fileUri);
    return JSON.parse(raw);
  } catch (error) {
    console.error('[PDF] failed to read history', error);
    return [];
  }
};

const writePdfHistory = async (history: PdfHistoryItem[]) => {
  if (Platform.OS === 'web') {
    await writeWebPdfHistory(history);
    return;
  }

  const FileSystem = await import('expo-file-system/legacy');
  const fileUri = await getPdfHistoryFileUri();
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(history));
};

const isExpiredPdfHistoryItem = (item: PdfHistoryItem, now = Date.now()) =>
  now - item.createdAt >= PDF_HISTORY_RETENTION_MS;

const deletePdfHistoryFiles = async (item: PdfHistoryItem) => {
  if (Platform.OS === 'web') return;

  const FileSystem = await import('expo-file-system/legacy');
  await FileSystem.deleteAsync(item.uri, { idempotent: true });
  if (item.previewUri) {
    await FileSystem.deleteAsync(item.previewUri, { idempotent: true });
  }
};

const estimateDataUriBytes = (dataUri: string) => {
  const base64 = dataUri.split(',')[1] ?? '';
  return Math.round((base64.length * 3) / 4);
};

const clampPdfProgress = (progress: number) => Math.max(0, Math.min(100, progress));

const waitForUiPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
      return;
    }

    setTimeout(resolve, 0);
  });

const padDatePart = (value: number) => String(value).padStart(2, '0');

const getDefaultPdfName = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
    `${padDatePart(now.getHours())}:${padDatePart(now.getMinutes())}`,
  ].join('/');
};

const toSafePdfFileName = (name: string) => {
  const trimmed = name.trim() || getDefaultPdfName();
  const withoutExtension = trimmed.replace(/\.pdf$/i, '');
  const safeBaseName = withoutExtension
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^-+|-+$/g, '') || 'scan';

  return `${safeBaseName}.pdf`;
};

const isSamePdfHistoryItem = (left: PdfHistoryItem, right: PdfHistoryItem) =>
  left.id === right.id &&
  left.fileName === right.fileName &&
  left.createdAt === right.createdAt;

const dataUriToBlob = (dataUri: string) => {
  const [header, base64 = ''] = dataUri.split(',');
  const mimeType = header.match(/data:(.*?);base64/)?.[1] ?? 'application/octet-stream';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
};

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<ActiveTab>('scan');
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [createdPdfs, setCreatedPdfs] = useState<PdfHistoryItem[]>([]);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewImage, setPreviewImage] = useState('');
  const [cameraModeVisible, setCameraModeVisible] = useState(false);
  const [webScannerVisible, setWebScannerVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [pendingPdf, setPendingPdf] = useState<PendingPdf | null>(null);
  const [fileNameModalVisible, setFileNameModalVisible] = useState(false);
  const [pdfFileNameInput, setPdfFileNameInput] = useState('');
  const [isCreatingPdf, setIsCreatingPdf] = useState(false);
  const [pdfProgressTarget, setPdfProgressTarget] = useState(0);
  const [pdfProgressDisplay, setPdfProgressDisplay] = useState(0);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [isReorderingPages, setIsReorderingPages] = useState(false);

  useEffect(() => {
    const loadCreatedPdfs = async () => {
      const history = await readPdfHistory();
      const activeHistory = history.filter((item) => !isExpiredPdfHistoryItem(item));
      const expiredHistory = history.filter(isExpiredPdfHistoryItem);

      if (expiredHistory.length > 0) {
        await Promise.all(expiredHistory.map(deletePdfHistoryFiles));
        await writePdfHistory(activeHistory);
        setStatusMessage(`${expiredHistory.length}件の期限切れPDFを自動削除しました。`);
      }

      setCreatedPdfs(activeHistory);
    };

    void loadCreatedPdfs();
  }, []);

  useEffect(() => {
    const clearOldWebCaches = async () => {
      if (Platform.OS !== 'web' || typeof window === 'undefined') {
        return;
      }

      if (localStorage.getItem(WEB_CACHE_CLEARED_STORAGE_KEY) === 'true') {
        return;
      }

      try {
        if (typeof caches !== 'undefined') {
          const cacheNames = await caches.keys();
          await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
        }

        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        }

        localStorage.setItem(WEB_CACHE_CLEARED_STORAGE_KEY, 'true');
        console.info('[Web] 古いキャッシュとサービスワーカーを削除しました。');
      } catch (error) {
        console.warn('[Web] キャッシュ削除に失敗しました。', error);
      }
    };

    void clearOldWebCaches();
  }, []);

  useEffect(() => {
    if (!isCreatingPdf) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setPdfProgressDisplay((current) => {
        const gap = pdfProgressTarget - current;
        if (Math.abs(gap) < 0.4) return pdfProgressTarget;

        return current + Math.max(0.4, Math.abs(gap) * 0.22) * Math.sign(gap);
      });
    }, 60);

    return () => {
      window.clearInterval(interval);
    };
  }, [isCreatingPdf, pdfProgressTarget]);

  useEffect(() => {
    const askInitialCameraPermission = async () => {
      try {
        if (Platform.OS === 'web') {
          if (localStorage.getItem(CAMERA_PERMISSION_STORAGE_KEY)) return;
          localStorage.setItem(CAMERA_PERMISSION_STORAGE_KEY, 'true');

          if (!navigator.mediaDevices?.getUserMedia) {
            setStatusMessage('このブラウザではカメラ権限を事前確認できません。');
            return;
          }

          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
          });
          stream.getTracks().forEach((track) => track.stop());
          setStatusMessage('カメラ権限を確認しました。');
          return;
        }

        const permission = await ImagePicker.requestCameraPermissionsAsync();
        setStatusMessage(
          permission.granted
            ? 'カメラ権限を確認しました。'
            : 'カメラ権限がありません。設定から許可してください。'
        );
      } catch (error) {
        console.error('[Camera] initial permission request failed', error);
        setStatusMessage('カメラ権限の確認がキャンセルまたは拒否されました。');
      }
    };

    void askInitialCameraPermission();
  }, []);

  const updateCreatedPdfs = async (nextHistory: PdfHistoryItem[]) => {
    setCreatedPdfs(nextHistory);
    await writePdfHistory(nextHistory);
  };

  const addImagePage = (asset: ImagePicker.ImagePickerAsset) => {
    setPages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sourceType: 'image',
        uri: asset.uri,
        fileName: asset.fileName ?? `scan_${Date.now()}.jpg`,
        fileSize: asset.fileSize ?? 0,
        createdAt: Date.now(),
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      },
    ]);
  };

  const addDocumentImagePage = (asset: DocumentPicker.DocumentPickerAsset, base64?: string) => {
    const mimeType = asset.mimeType ?? (base64?.startsWith('/9j') ? 'image/jpeg' : 'image/png');

    setPages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sourceType: 'image',
        uri: base64 ? `data:${mimeType};base64,${base64}` : asset.uri,
        fileName: asset.name,
        fileSize: asset.size ?? (base64 ? Math.round((base64.length * 3) / 4) : 0),
        createdAt: Date.now(),
        mimeType,
        base64,
      },
    ]);
  };

  const addPdfPage = (
    asset: DocumentPicker.DocumentPickerAsset,
    base64: string,
    pageCount: number,
    previewUri?: string
  ) => {
    setPages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sourceType: 'pdf',
        uri: `data:application/pdf;base64,${base64}`,
        previewUri,
        fileName: asset.name,
        fileSize: asset.size ?? Math.round((base64.length * 3) / 4),
        createdAt: Date.now(),
        mimeType: asset.mimeType ?? 'application/pdf',
        pageCount,
        base64,
      },
    ]);
  };

  const addScannedPages = (scannedPages: ScannedPageInput[]) => {
    const createdAt = Date.now();

    setPages((prev) => [
      ...prev,
      ...scannedPages.map((page, index) => ({
        id: `${createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        sourceType: 'image' as const,
        uri: page.uri,
        fileName: `document_scan_${createdAt}_${index + 1}.jpg`,
        fileSize: 0,
        createdAt,
        mimeType: 'image/jpeg',
        width: page.width,
        height: page.height,
      })),
    ]);
  };

  const createAndSavePdf = async () => {
    if (isCreatingPdf || isSavingPdf) return;

    if (pages.length === 0) {
      Alert.alert('PDF作成', '先に1つ以上の画像またはPDFを追加してください。');
      return;
    }

    try {
      setIsCreatingPdf(true);
      setPdfProgressTarget(0);
      setPdfProgressDisplay(0);
      setStatusMessage('PDF結合中...（0％）');
      await waitForUiPaint();

      const mergedPdf = await createMergedPdf(pages, (progress) => {
        setPdfProgressTarget(clampPdfProgress(progress));
      });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setPendingPdf({
        id,
        pdfDataUri: mergedPdf.pdfDataUri,
        previewDataUri: mergedPdf.previewDataUri,
        createdAt: Date.now(),
        pageCount: mergedPdf.pageCount,
        fileSize: estimateDataUriBytes(mergedPdf.pdfDataUri),
      });
      setPdfFileNameInput(getDefaultPdfName());
      setFileNameModalVisible(true);
      setStatusMessage('PDFを結合しました。ファイル名を入力してください。');
    } catch (error) {
      console.error('[PDF] failed to create PDF', error);
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`PDF作成でエラーが発生しました: ${message}`);
      Alert.alert('PDF作成エラー', message);
    } finally {
      setIsCreatingPdf(false);
      setPdfProgressTarget(0);
      setPdfProgressDisplay(0);
    }
  };

  const savePendingPdf = async () => {
    if (!pendingPdf || isSavingPdf) return;

    const pdfToSave = pendingPdf;

    try {
      setIsSavingPdf(true);
      setPendingPdf(null);
      setFileNameModalVisible(false);
      const fileName = toSafePdfFileName(pdfFileNameInput);
      let uri = pdfToSave.pdfDataUri;
      let previewUri = pdfToSave.previewDataUri;
      let fileSize = pdfToSave.fileSize;

      if (Platform.OS !== 'web') {
        const FileSystem = await import('expo-file-system/legacy');
        const pdfBase64 = pdfToSave.pdfDataUri.split(',')[1] ?? '';
        uri = `${FileSystem.documentDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(uri, pdfBase64, {
          encoding: 'base64',
        });

        if (pdfToSave.previewDataUri) {
          const previewBase64 = pdfToSave.previewDataUri.split(',')[1] ?? '';
          previewUri = `${FileSystem.documentDirectory}${pdfToSave.id}_preview.jpg`;
          await FileSystem.writeAsStringAsync(previewUri, previewBase64, {
            encoding: 'base64',
          });
        }

        fileSize = Math.round((pdfBase64.length * 3) / 4);
      }

      const historyItem: PdfHistoryItem = {
        id: pdfToSave.id,
        fileName,
        uri,
        previewUri,
        createdAt: pdfToSave.createdAt,
        pageCount: pdfToSave.pageCount,
        fileSize,
      };
      const nextHistory = [historyItem, ...createdPdfs];

      await updateCreatedPdfs(nextHistory);
      setPdfFileNameInput('');
      setFileNameModalVisible(false);
      setPendingPdf(null);
      setActiveTab('created');
      setStatusMessage(`PDFを作成しました: ${fileName}`);
    } catch (error) {
      console.error('[PDF] failed to save named PDF', error);
      setStatusMessage('PDF保存でエラーが発生しました。');
      Alert.alert('PDF保存エラー', error instanceof Error ? error.message : String(error));
      setPendingPdf(pdfToSave);
      setFileNameModalVisible(true);
    } finally {
      setIsSavingPdf(false);
    }
  };

  const cancelPendingPdfName = () => {
    if (isSavingPdf) return;

    setPendingPdf(null);
    setFileNameModalVisible(false);
    setPdfFileNameInput('');
    setStatusMessage('PDFの保存をキャンセルしました。');
  };

  const openCreatedPdf = async (item: PdfHistoryItem) => {
    try {
      if (Platform.OS === 'web') {
        const blob = dataUriToBlob(item.uri);
        const file = new File([blob], item.fileName, { type: 'application/pdf' });
        const shareNavigator = navigator as Navigator & {
          canShare?: (data: ShareData) => boolean;
          share?: (data: ShareData) => Promise<void>;
        };
        const shareData: ShareData = {
          files: [file],
        };

        if (shareNavigator.share && (!shareNavigator.canShare || shareNavigator.canShare(shareData))) {
          await shareNavigator.share(shareData);
          return;
        }

        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
        return;
      }

      const Sharing = await import('expo-sharing');
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('PDF', item.uri);
        return;
      }

      await Sharing.shareAsync(item.uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'PDFを開く',
        UTI: 'com.adobe.pdf',
      });
    } catch (error) {
      console.error('[PDF] failed to open history item', error);
      Alert.alert('PDFを開けませんでした', error instanceof Error ? error.message : String(error));
    }
  };

  const deleteCreatedPdf = async (item: PdfHistoryItem) => {
    let nextHistory: PdfHistoryItem[] = [];
    setCreatedPdfs((currentHistory) => {
      nextHistory = currentHistory.filter((pdf) => !isSamePdfHistoryItem(pdf, item));
      return nextHistory;
    });

    try {
      await deletePdfHistoryFiles(item);
      await writePdfHistory(nextHistory);
      setStatusMessage(`${item.fileName} を削除しました。`);
    } catch (error) {
      console.error('[PDF] failed to delete history item', error);
      void readPdfHistory().then(setCreatedPdfs);
      Alert.alert('削除エラー', error instanceof Error ? error.message : String(error));
    }
  };

  const launchNativeDocumentScanner = async () => {
    const {
      default: DocumentScanner,
      ResponseType,
      ScanDocumentResponseStatus,
    } = await import('react-native-document-scanner-plugin');
    const result = await DocumentScanner.scanDocument({
      croppedImageQuality: 100,
      responseType: ResponseType.Base64,
    });

    if (result.status === ScanDocumentResponseStatus.Cancel) {
      setStatusMessage('書類スキャンをキャンセルしました。');
      return;
    }

    const scannedImages = result.scannedImages ?? [];
    if (result.status !== ScanDocumentResponseStatus.Success || scannedImages.length === 0) {
      setStatusMessage('書類スキャンで画像を取得できませんでした。');
      return;
    }

    addScannedPages(
      scannedImages.map((imageBase64) => ({
        uri: `data:image/jpeg;base64,${imageBase64}`,
      }))
    );
    setStatusMessage(`ネイティブ書類スキャンで${scannedImages.length}ページ追加しました。`);
  };

  const launchCamera = async (mode: CameraMode) => {
    try {
      setCameraModeVisible(false);
      setStatusMessage('');

      if (Platform.OS === 'web' && mode === 'scan') {
        setStatusMessage('書類スキャンを起動します。紙をガイド枠に合わせてください。');
        setWebScannerVisible(true);
        return;
      }

      if (mode === 'scan') {
        await launchNativeDocumentScanner();
        return;
      }

      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setStatusMessage('カメラの権限がありません。');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        cameraType: ImagePicker.CameraType.back,
        quality: 0.92,
        allowsEditing: false,
      });

      if (!result.canceled) {
        const asset = result.assets[0];
        addImagePage(asset);
      }
    } catch {
      setStatusMessage('カメラを起動できませんでした。');
    }
  };

  const launchLibrary = async () => {
    try {
      setCameraModeVisible(false);
      setStatusMessage('');

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (!result.canceled) {
        const supportedAssets = result.assets.filter(isImagePickerSupportedAsset);
        const skippedFiles = result.assets.length - supportedAssets.length;

        if (skippedFiles > 0) {
          warnUnsupportedFiles();
        }

        supportedAssets.forEach(addImagePage);

        if (supportedAssets.length === 0 && skippedFiles > 0) {
          setStatusMessage('追加できるPDF/JPEG/PNGファイルがありませんでした。');
        }
      }
    } catch {
      setStatusMessage('ライブラリを開けませんでした。');
    }
  };

  const launchFilePicker = async () => {
    try {
      setCameraModeVisible(false);
      setStatusMessage('');

      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
        base64: false,
      });

      if (result.canceled) return;

      let addedFiles = 0;
      let skippedFiles = 0;

      for (const asset of result.assets) {
        try {
          const fileBase64 = await readFileBase64(asset.uri, asset.name);
          const isPdfAsset = isDocumentPickerPdfAsset(asset) || fileBase64.startsWith('JVBERi0');
          const isImageAsset =
            isDocumentPickerImageAsset(asset) ||
            fileBase64.startsWith('/9j') ||
            fileBase64.startsWith('iVBOR');

          if (isPdfAsset) {
            const { PDFDocument } = await import('pdf-lib/dist/pdf-lib.esm.min.js');
            const sourcePdf = await PDFDocument.load(fileBase64, {
              ignoreEncryption: true,
            });
            const previewUri = await createPdfFirstPagePreviewDataUri(fileBase64);
            addPdfPage(asset, fileBase64, sourcePdf.getPageCount(), previewUri);
            addedFiles += 1;
            continue;
          }

          if (isImageAsset) {
            addDocumentImagePage(asset, fileBase64);
            addedFiles += 1;
            continue;
          }
        } catch (error) {
          console.warn('[DocumentPicker] skipped file', asset.name, error);
        }

        skippedFiles += 1;
      }

      if (skippedFiles > 0) {
        warnUnsupportedFiles();
      }

      if (addedFiles > 0) {
        setStatusMessage(
          skippedFiles > 0
            ? `${addedFiles}ファイルを追加しました。${skippedFiles}ファイルは未対応形式です。`
            : `${addedFiles}ファイルを追加しました。`
        );
        return;
      }

      setStatusMessage('追加できるPDF/JPEG/PNGファイルがありませんでした。');
    } catch (error) {
      console.error('[DocumentPicker] failed to add files', error);
      setStatusMessage('ファイルを追加できませんでした。');
      Alert.alert('ファイル追加エラー', error instanceof Error ? error.message : String(error));
    }
  };

  const renderPage = ({
    item,
    drag,
    getIndex,
    isActive,
  }: RenderItemParams<ScanPage>) => {
    const index = getIndex() ?? 0;
    const pageCount = getPageCount(item);

    return (
      <View style={[styles.pageCard, isActive && styles.pageCardActive]}>
        <Pressable
          style={styles.deleteButton}
          disabled={isActive || isReorderingPages}
          onPress={() => setPages((prev) => prev.filter((page) => page.id !== item.id))}
        >
          <Text style={styles.deleteText}>✕</Text>
        </Pressable>

        <View style={styles.pageNumber}>
          <Text style={styles.pageNumberText}>{index + 1}</Text>
        </View>

        {isPdfPage(item) && item.previewUri ? (
          <Image source={{ uri: item.previewUri }} style={styles.thumbnail} />
        ) : isPdfPage(item) ? (
          <PdfPreview uri={item.uri} variant="page" />
        ) : (
          <Pressable
            disabled={isActive || isReorderingPages}
            onPress={() => {
              setPreviewImage(item.uri);
              setPreviewVisible(true);
            }}
          >
            <Image source={{ uri: item.uri }} style={styles.thumbnail} />
          </Pressable>
        )}

        <View style={styles.pageInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {item.fileName}
          </Text>
          {isPdfPage(item) ? (
            <Text style={styles.meta}>
              {item.pageCount ? `${pageCount}ページのPDF` : 'PDFファイル'}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {(item.fileSize / 1024 / 1024).toFixed(2)} MB
          </Text>
          <Text style={styles.meta}>
            {new Date(item.createdAt).toLocaleString()}
          </Text>
        </View>

        <Pressable
          style={[styles.dragHandle, isActive && styles.dragHandleActive]}
          onPressIn={drag}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="順番を入れ替える"
        >
          <Text style={styles.dragText}>|||</Text>
        </Pressable>
      </View>
    );
  };

  const renderCreatedPdf = (item: PdfHistoryItem) => (
    <Pressable
      key={item.id}
      style={({ pressed }) => [
        styles.historyCard,
        pressed && styles.buttonPressed,
      ]}
      onPress={() => {
        void openCreatedPdf(item);
      }}
    >
      <Pressable
        style={styles.deleteButton}
        onPress={(event) => {
          event.stopPropagation();
          void deleteCreatedPdf(item);
        }}
      >
        <Text style={styles.deleteText}>✕</Text>
      </Pressable>

      {item.previewUri ? (
        <Image source={{ uri: item.previewUri }} style={styles.pdfPreview} />
      ) : (
        <PdfPreview uri={item.uri} variant="history" />
      )}
      <View style={styles.pageInfo}>
        <Text style={styles.fileName} numberOfLines={1}>
          {item.fileName}
        </Text>
        <Text style={styles.meta}>
          {item.pageCount}ページ / {(item.fileSize / 1024 / 1024).toFixed(2)} MB
        </Text>
        <Text style={styles.meta}>
          {new Date(item.createdAt).toLocaleString()}
        </Text>
      </View>
    </Pressable>
  );

  const header = (
    <View style={[styles.topArea, { paddingTop: insets.top + 14 }]}>
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tabButton, activeTab === 'scan' && styles.tabButtonActive]}
          onPress={() => setActiveTab('scan')}
        >
          <Text style={[styles.tabText, activeTab === 'scan' && styles.tabTextActive]}>
            スキャン
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === 'created' && styles.tabButtonActive]}
          onPress={() => setActiveTab('created')}
        >
          <Text style={[styles.tabText, activeTab === 'created' && styles.tabTextActive]}>
            作成済み
          </Text>
        </Pressable>
      </View>

      {isCreatingPdf || statusMessage ? (
        <>
          <Text style={styles.statusText}>
            {isCreatingPdf
              ? `PDF結合中...（${Math.round(pdfProgressDisplay)}％）`
              : statusMessage}
          </Text>
          {isCreatingPdf ? (
            <View style={styles.statusProgressTrack}>
              <View
                style={[
                  styles.statusProgressFill,
                  { width: `${Math.max(0, Math.min(100, pdfProgressDisplay))}%` },
                ]}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {header}

      {activeTab === 'scan' ? (
        <DraggableFlatList
          data={pages}
          keyExtractor={(item) => item.id}
          renderItem={renderPage}
          onDragBegin={() => setIsReorderingPages(true)}
          onRelease={() => setIsReorderingPages(false)}
          onDragEnd={({ data }) => {
            setPages(data);
            setIsReorderingPages(false);
          }}
          activationDistance={8}
          autoscrollThreshold={96}
          autoscrollSpeed={180}
          dragItemOverflow
          style={styles.list}
          containerStyle={styles.list}
          contentContainerStyle={[
            styles.container,
            {
              paddingBottom: insets.bottom + 72,
            },
          ]}
          scrollEnabled
          nestedScrollEnabled
          alwaysBounceVertical={pages.length > 0}
          persistentScrollbar
          showsVerticalScrollIndicator
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.buttonRow}>
                <Pressable
                  style={({ pressed }) => [
                    styles.button,
                    styles.scanButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={() => setCameraModeVisible(true)}
                >
                  <Text style={styles.buttonText}>スキャン開始</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.button,
                    styles.pdfButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={() => {
                    void createAndSavePdf();
                  }}
                  disabled={isCreatingPdf || isSavingPdf}
                >
                  <Text style={styles.buttonText}>
                    {isCreatingPdf ? 'PDF結合中...' : '結合PDFを作成'}
                  </Text>
                </Pressable>
              </View>

              <Text style={styles.sectionTitle}>追加済みファイル ({pages.length})</Text>

              {pages.length === 0 ? (
                <Text style={styles.emptyText}>
                  まだページがありません。スキャン開始から写真またはPDFを追加してください。
                </Text>
              ) : null}
            </View>
          }
        />
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={[
            styles.container,
            {
              paddingBottom: insets.bottom + 72,
            },
          ]}
          showsVerticalScrollIndicator
        >
          <Text style={styles.sectionTitle}>作成済みPDF ({createdPdfs.length})</Text>
          <Text style={styles.emptyText}>
            PDFをタップすると保存できます。作成済みPDFは30日後に自動削除されます。
          </Text>

          {createdPdfs.length === 0 ? (
            <Text style={styles.emptyText}>
              まだ作成済みファイルがありません。スキャンタブで結合PDFを作成してください。
            </Text>
          ) : (
            createdPdfs.map(renderCreatedPdf)
          )}
        </ScrollView>
      )}

      <Modal
        visible={cameraModeVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCameraModeVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setCameraModeVisible(false)}
        >
          <View style={styles.modalSheet} pointerEvents="box-none">
            <Text style={styles.modalTitle}>撮影方法を選択</Text>

            <Pressable
              style={({ pressed }) => [
                styles.modalButton,
                pressed && styles.buttonPressed,
              ]}
              onPress={async () => {
                setCameraModeVisible(false);
                await launchCamera('scan');
              }}
            >
              <Text style={styles.modalButtonText}>スキャンとして撮影</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalButtonSecondary,
                pressed && styles.buttonPressed,
              ]}
              onPress={async () => {
                setCameraModeVisible(false);
                await launchCamera('photo');
              }}
            >
              <Text style={styles.modalButtonText}>カメラで撮影</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalButtonSecondary,
                pressed && styles.buttonPressed,
              ]}
              onPress={async () => {
                if (Platform.OS === 'web') {
                  const pickerPromise = launchFilePicker();
                  setCameraModeVisible(false);
                  await pickerPromise;
                } else {
                  await launchLibrary();
                  setCameraModeVisible(false);
                }
              }}
            >
              <Text style={styles.modalButtonText}>写真／ファイルから選択</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.modalCancelButton,
                pressed && styles.buttonPressed,
              ]}
              onPress={() => setCameraModeVisible(false)}
            >
              <Text style={styles.modalCancelText}>キャンセル</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <WebDocumentScanner
        visible={webScannerVisible}
        onCancel={() => setWebScannerVisible(false)}
        onCapture={(page) => {
          addScannedPages([page]);
          setWebScannerVisible(false);
          setStatusMessage('書類スキャンを1枚追加しました。');
        }}
        onError={(message) => {
          setStatusMessage(`書類スキャンに失敗しました: ${message}`);
        }}
      />

      <Modal
        visible={fileNameModalVisible && Boolean(pendingPdf) && !isSavingPdf}
        transparent
        animationType="fade"
        onRequestClose={cancelPendingPdfName}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>PDFのファイル名</Text>
            <TextInput
              value={pdfFileNameInput}
              onChangeText={setPdfFileNameInput}
              placeholder="YYYY/MM/DD/hh:mm"
              placeholderTextColor="#7F91AE"
              autoCapitalize="none"
              autoCorrect={false}
              selectTextOnFocus
              style={styles.fileNameInput}
              onSubmitEditing={() => {
                void savePendingPdf();
              }}
              editable={!isSavingPdf}
            />
            <View style={styles.modalActionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.modalActionButton,
                  styles.modalActionSecondary,
                  pressed && styles.buttonPressed,
                ]}
                onPress={cancelPendingPdfName}
                disabled={isSavingPdf}
              >
                <Text style={styles.modalButtonText}>キャンセル</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.modalActionButton,
                  pressed && styles.buttonPressed,
                ]}
                onPress={() => {
                  void savePendingPdf();
                }}
                disabled={isSavingPdf}
              >
                <Text style={styles.modalButtonText}>
                  {isSavingPdf ? '保存中...' : '保存'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={previewVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewVisible(false)}
      >
        <View style={styles.previewContainer}>
          <Image source={{ uri: previewImage }} style={styles.previewImage} />

          <Pressable
            style={[
              styles.closePreview,
              { top: Math.max(insets.top + 12, 24) },
            ]}
            hitSlop={12}
            onPress={() => setPreviewVisible(false)}
          >
            <Text style={styles.closePreviewText}>✕</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#06152A',
  },
  topArea: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: '#06152A',
    borderBottomWidth: 1,
    borderBottomColor: '#172C49',
    flexShrink: 0,
    zIndex: 20,
    elevation: 20,
  },
  tabBar: {
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A4368',
    backgroundColor: '#0B1C31',
  },
  tabButton: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#1E6AD1',
  },
  tabText: {
    color: '#AAB8D1',
    fontSize: 15,
    fontWeight: '700',
  },
  tabTextActive: {
    color: '#FFF',
  },
  list: {
    flex: 1,
  },
  container: {
    padding: 20,
    backgroundColor: '#06152A',
    flexGrow: 1,
  },
  header: {
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
  },
  button: {
    flex: 1,
    minHeight: 56,
    borderRadius: 10,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  scanButton: {
    backgroundColor: '#123B73',
  },
  pdfButton: {
    backgroundColor: '#22543D',
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  buttonText: {
    color: '#FFF',
    fontSize: 15,
    textAlign: 'center',
    fontWeight: '700',
    lineHeight: 18,
  },
  statusProgressTrack: {
    width: '100%',
    height: 4,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#183252',
    marginTop: 6,
  },
  statusProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#8FB8FF',
  },
  statusText: {
    marginTop: 10,
    color: '#8FB8FF',
    fontSize: 13,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    color: '#EAF1FF',
  },
  emptyText: {
    color: '#AAB8D1',
    fontSize: 14,
    marginBottom: 12,
  },
  pageCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#10243F',
    borderWidth: 1,
    borderColor: '#243B5F',
    borderRadius: 12,
    padding: 15,
    marginBottom: 12,
    minHeight: 122,
    position: 'relative',
  },
  pageCardActive: {
    opacity: 0.92,
    transform: [{ scale: 1.01 }],
  },
  historyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#10243F',
    borderWidth: 1,
    borderColor: '#243B5F',
    borderRadius: 12,
    padding: 15,
    marginBottom: 12,
    position: 'relative',
  },
  pdfIcon: {
    width: 58,
    height: 74,
    borderRadius: 8,
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#8F1D2C',
  },
  pdfIconText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '800',
  },
  pdfPageIcon: {
    width: 70,
    height: 90,
    borderRadius: 8,
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#8F1D2C',
    borderWidth: 1,
    borderColor: '#C55262',
  },
  pdfPreview: {
    width: 58,
    height: 74,
    borderRadius: 8,
    marginRight: 12,
    backgroundColor: '#F4F6FA',
    borderWidth: 1,
    borderColor: '#526A91',
    resizeMode: 'cover',
  },
  thumbnail: {
    width: 70,
    height: 90,
    borderRadius: 8,
    marginRight: 12,
    borderWidth: 1,
    borderColor: '#2E4A72',
  },
  pageInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
    color: '#F5F9FF',
  },
  meta: {
    color: '#B8C7E0',
    fontSize: 12,
    marginTop: 2,
  },
  dragHandle: {
    width: 48,
    height: 90,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    borderRadius: 10,
  },
  dragHandleActive: {
    backgroundColor: '#1B3558',
  },
  dragText: {
    fontSize: 18,
    color: '#C8D6EE',
    fontWeight: 'bold',
    letterSpacing: 0,
  },
  deleteButton: {
    position: 'absolute',
    top: -12,
    left: -12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#0C1B2F',
    borderWidth: 1.5,
    borderColor: '#2D456C',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  deleteText: {
    color: '#FF7B7B',
    fontSize: 18,
    fontWeight: 'bold',
    lineHeight: 18,
  },
  pageNumber: {
    position: 'absolute',
    top: -12,
    right: -12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#123B73',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  pageNumberText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  previewContainer: {
    flex: 1,
    backgroundColor: 'rgba(3,10,20,0.94)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewImage: {
    width: '95%',
    height: '80%',
    resizeMode: 'contain',
  },
  closePreview: {
    position: 'absolute',
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(7,18,35,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    elevation: 20,
  },
  closePreviewText: {
    color: '#FFF',
    fontSize: 30,
    fontWeight: 'bold',
    lineHeight: 34,
    textAlign: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,10,20,0.55)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#10243F',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2A4368',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
    color: '#F5F9FF',
  },
  modalButton: {
    backgroundColor: '#123B73',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  modalButtonSecondary: {
    backgroundColor: '#1B2A45',
  },
  modalButtonText: {
    color: '#FFF',
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '600',
  },
  fileNameInput: {
    minHeight: 50,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2D456C',
    backgroundColor: '#0B1C31',
    color: '#F5F9FF',
    fontSize: 16,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  modalActionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  modalActionButton: {
    flex: 1,
    backgroundColor: '#123B73',
    borderRadius: 12,
    paddingVertical: 14,
  },
  modalActionSecondary: {
    backgroundColor: '#1B2A45',
  },
  modalCancelButton: {
    paddingVertical: 14,
  },
  modalCancelText: {
    textAlign: 'center',
    fontSize: 16,
    color: '#C8D6EE',
    fontWeight: '600',
  },
});
