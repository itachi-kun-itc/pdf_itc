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

import * as ImagePicker from 'expo-image-picker';
import DraggableFlatList, {
  RenderItemParams,
} from 'react-native-draggable-flatlist';

import { WebDocumentScanner } from '@/components/WebDocumentScanner';
import { scanDocumentImage } from '@/utils/document-scanner';

type ScanPage = {
  id: string;
  uri: string;
  fileName: string;
  fileSize: number;
  createdAt: number;
  mimeType?: string;
  width?: number;
  height?: number;
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
  previewDataUri: string;
  createdAt: number;
  pageCount: number;
  fileSize: number;
};

const PDF_HISTORY_STORAGE_KEY = 'pdfscanner.createdPdfs.v1';
const CAMERA_PERMISSION_STORAGE_KEY = 'pdfscanner.cameraPermissionAsked.v1';

const isDesktopWeb = () => {
  if (Platform.OS !== 'web') return false;
  if (typeof navigator === 'undefined') return false;
  return !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
};

const isJpegPage = (page: ScanPage) => {
  const mimeType = page.mimeType?.toLowerCase() ?? '';
  const fileName = page.fileName.toLowerCase();
  return mimeType.includes('jpeg') || mimeType.includes('jpg') || /\.(jpe?g)$/i.test(fileName);
};

const getImageFormat = (page: ScanPage) => (isJpegPage(page) ? 'JPEG' : 'PNG');

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

const readImageBase64 = async (page: ScanPage) => {
  if (page.uri.startsWith('data:')) {
    return page.uri.split(',')[1] ?? '';
  }

  if (Platform.OS === 'web') {
    const response = await fetch(page.uri);
    if (!response.ok) {
      throw new Error(`画像を読み込めませんでした: ${response.status} ${page.fileName}`);
    }

    return blobToBase64(await response.blob());
  }

  const FileSystem = await import('expo-file-system/legacy');

  return FileSystem.readAsStringAsync(page.uri, {
    encoding: 'base64',
  });
};

const createImagePdf = async (pages: ScanPage[]) => {
  console.log('[PDF] creating image PDF with jsPDF', { count: pages.length });

  const { jsPDF } = await import('jspdf/dist/jspdf.es.min.js');
  const firstPage = pages[0];
  const firstWidth = firstPage.width ?? 595;
  const firstHeight = firstPage.height ?? 842;
  const document = new jsPDF({
    orientation: firstWidth > firstHeight ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [firstWidth, firstHeight],
    compress: true,
  });

  for (const [index, page] of pages.entries()) {
    const width = page.width ?? firstWidth;
    const height = page.height ?? firstHeight;
    const imageDataUrl = await getImageDataUrl(page);

    if (index > 0) {
      document.addPage([width, height], width > height ? 'landscape' : 'portrait');
    }

    document.addImage(imageDataUrl, getImageFormat(page), 0, 0, width, height);
  }

  return document;
};

const getPdfHistoryFileUri = async () => {
  const FileSystem = await import('expo-file-system/legacy');
  return `${FileSystem.documentDirectory}${PDF_HISTORY_STORAGE_KEY}.json`;
};

const readPdfHistory = async (): Promise<PdfHistoryItem[]> => {
  try {
    if (Platform.OS === 'web') {
      const raw = localStorage.getItem(PDF_HISTORY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
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
    localStorage.setItem(PDF_HISTORY_STORAGE_KEY, JSON.stringify(history));
    return;
  }

  const FileSystem = await import('expo-file-system/legacy');
  const fileUri = await getPdfHistoryFileUri();
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(history));
};

const confirmAsync = (title: string, message: string) =>
  new Promise<boolean>((resolve) => {
    if (Platform.OS === 'web') {
      resolve(window.confirm(`${title}\n\n${message}`));
      return;
    }

    Alert.alert(title, message, [
      { text: 'いいえ', style: 'cancel', onPress: () => resolve(false) },
      { text: 'はい', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });

const estimateDataUriBytes = (dataUri: string) => {
  const base64 = dataUri.split(',')[1] ?? '';
  return Math.round((base64.length * 3) / 4);
};

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

  useEffect(() => {
    void readPdfHistory().then(setCreatedPdfs);
  }, []);

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

  const addPage = (asset: ImagePicker.ImagePickerAsset) => {
    setPages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  const addScannedPages = (scannedPages: ScannedPageInput[]) => {
    const createdAt = Date.now();

    setPages((prev) => [
      ...prev,
      ...scannedPages.map((page, index) => ({
        id: `${createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
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
    if (pages.length === 0) {
      Alert.alert('PDF作成', '先に1枚以上の画像を追加してください。');
      return;
    }

    try {
      setStatusMessage(`PDF結合中... (${pages.length}枚)`);

      const pdf = await createImagePdf(pages);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pdfDataUri = pdf.output('datauristring');
      const previewDataUri = await getImageDataUrl(pages[0]);

      setPendingPdf({
        id,
        pdfDataUri,
        previewDataUri,
        createdAt: Date.now(),
        pageCount: pages.length,
        fileSize: estimateDataUriBytes(pdfDataUri),
      });
      setPdfFileNameInput(getDefaultPdfName());
      setFileNameModalVisible(true);
      setStatusMessage('PDFを結合しました。ファイル名を入力してください。');
    } catch (error) {
      console.error('[PDF] failed to create PDF', error);
      setStatusMessage('PDF作成でエラーが発生しました。');
      Alert.alert('PDF作成エラー', error instanceof Error ? error.message : String(error));
    }
  };

  const savePendingPdf = async () => {
    if (!pendingPdf) return;

    try {
      const fileName = toSafePdfFileName(pdfFileNameInput);
      let uri = pendingPdf.pdfDataUri;
      let previewUri = pendingPdf.previewDataUri;
      let fileSize = pendingPdf.fileSize;

      if (Platform.OS !== 'web') {
        const FileSystem = await import('expo-file-system/legacy');
        const pdfBase64 = pendingPdf.pdfDataUri.split(',')[1] ?? '';
        const previewBase64 = pendingPdf.previewDataUri.split(',')[1] ?? '';
        uri = `${FileSystem.documentDirectory}${fileName}`;
        previewUri = `${FileSystem.documentDirectory}${pendingPdf.id}_preview.jpg`;
        await FileSystem.writeAsStringAsync(uri, pdfBase64, {
          encoding: 'base64',
        });
        await FileSystem.writeAsStringAsync(previewUri, previewBase64, {
          encoding: 'base64',
        });
        fileSize = Math.round((pdfBase64.length * 3) / 4);
      }

      const historyItem: PdfHistoryItem = {
        id: pendingPdf.id,
        fileName,
        uri,
        previewUri,
        createdAt: pendingPdf.createdAt,
        pageCount: pendingPdf.pageCount,
        fileSize,
      };
      const nextHistory = [historyItem, ...createdPdfs];

      await updateCreatedPdfs(nextHistory);
      setPendingPdf(null);
      setFileNameModalVisible(false);
      setPdfFileNameInput('');
      setActiveTab('created');
      setStatusMessage(`PDFを作成しました: ${fileName}`);
    } catch (error) {
      console.error('[PDF] failed to save named PDF', error);
      setStatusMessage('PDF保存でエラーが発生しました。');
      Alert.alert('PDF保存エラー', error instanceof Error ? error.message : String(error));
    }
  };

  const cancelPendingPdfName = () => {
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
          title: item.fileName,
          text: item.fileName,
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
    const confirmed = await confirmAsync(
      'PDFを削除しますか？',
      `${item.fileName} を作成済み履歴から削除します。`
    );
    if (!confirmed) return;

    try {
      if (Platform.OS !== 'web') {
        const FileSystem = await import('expo-file-system/legacy');
        await FileSystem.deleteAsync(item.uri, { idempotent: true });
        if (item.previewUri) {
          await FileSystem.deleteAsync(item.previewUri, { idempotent: true });
        }
      }

      const nextHistory = createdPdfs.filter((pdf) => pdf.id !== item.id);
      await updateCreatedPdfs(nextHistory);
      setStatusMessage(`${item.fileName} を削除しました。`);
    } catch (error) {
      console.error('[PDF] failed to delete history item', error);
      Alert.alert('削除エラー', error instanceof Error ? error.message : String(error));
    }
  };

  const launchCamera = async (mode: CameraMode) => {
    try {
      setStatusMessage('');

      if (Platform.OS === 'web' && mode === 'scan') {
        setStatusMessage('書類スキャンを起動します。紙をガイド枠に合わせてください。');
        setWebScannerVisible(true);
        return;
      }

      if (isDesktopWeb()) {
        setStatusMessage('PCブラウザではカメラの起動を省略して、写真の追加に切り替えます。');
        await launchLibrary();
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
        quality: mode === 'scan' ? 1 : 0.92,
        allowsEditing: mode === 'scan',
        aspect: mode === 'scan' ? [3, 4] : undefined,
      });

      if (!result.canceled) {
        const asset = result.assets[0];

        if (mode === 'scan') {
          setStatusMessage('カラー補正しながらスキャン画像を整えています...');
          const scannedPage = await scanDocumentImage(asset.uri);
          addScannedPages([
            {
              uri: scannedPage.uri,
              width: scannedPage.width ?? asset.width,
              height: scannedPage.height ?? asset.height,
            },
          ]);
          setStatusMessage('カラー補正済みのスキャンを1枚追加しました。');
          return;
        }

        addPage(asset);
      }
    } catch {
      setStatusMessage('カメラを起動できませんでした。');
    }
  };

  const launchLibrary = async () => {
    try {
      setStatusMessage('');

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (!result.canceled) {
        result.assets.forEach(addPage);
      }
    } catch {
      setStatusMessage('ライブラリを開けませんでした。');
    }
  };

  const renderPage = ({
    item,
    drag,
    getIndex,
    isActive,
  }: RenderItemParams<ScanPage>) => {
    const index = getIndex() ?? 0;

    return (
      <View style={[styles.pageCard, isActive && styles.pageCardActive]}>
        <Pressable
          style={styles.deleteButton}
          onPress={() => setPages((prev) => prev.filter((page) => page.id !== item.id))}
        >
          <Text style={styles.deleteText}>x</Text>
        </Pressable>

        <View style={styles.pageNumber}>
          <Text style={styles.pageNumberText}>{index + 1}</Text>
        </View>

        <Pressable
          onPress={() => {
            setPreviewImage(item.uri);
            setPreviewVisible(true);
          }}
        >
          <Image source={{ uri: item.uri }} style={styles.thumbnail} />
        </Pressable>

        <View style={styles.pageInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {item.fileName}
          </Text>
          <Text style={styles.meta}>
            {(item.fileSize / 1024 / 1024).toFixed(2)} MB
          </Text>
          <Text style={styles.meta}>
            {new Date(item.createdAt).toLocaleString()}
          </Text>
        </View>

        <Pressable
          style={styles.dragHandle}
          onLongPress={drag}
          delayLongPress={120}
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
      onLongPress={() => {
        void deleteCreatedPdf(item);
      }}
      delayLongPress={450}
    >
      {item.previewUri ? (
        <Image source={{ uri: item.previewUri }} style={styles.pdfPreview} />
      ) : (
        <View style={styles.pdfIcon}>
          <Text style={styles.pdfIconText}>PDF</Text>
        </View>
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

      {statusMessage ? (
        <Text style={styles.statusText}>{statusMessage}</Text>
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
          onDragEnd={({ data }) => setPages(data)}
          activationDistance={4}
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
                >
                  <Text style={styles.buttonText}>結合PDFを作成</Text>
                </Pressable>
              </View>

              <Text style={styles.sectionTitle}>スキャン済みページ ({pages.length})</Text>

              {pages.length === 0 ? (
                <Text style={styles.emptyText}>
                  まだページがありません。スキャン開始から写真を追加してください。
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
            PDFをタップすると開きます。長押しすると削除できます。
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
          <Pressable style={styles.modalSheet} onPress={() => {}}>
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
                setCameraModeVisible(false);
                await launchLibrary();
              }}
            >
              <Text style={styles.modalButtonText}>写真／ファイルから追加</Text>
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
          </Pressable>
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
        visible={fileNameModalVisible}
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
            />
            <View style={styles.modalActionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.modalActionButton,
                  styles.modalActionSecondary,
                  pressed && styles.buttonPressed,
                ]}
                onPress={cancelPendingPdfName}
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
              >
                <Text style={styles.modalButtonText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={previewVisible} transparent animationType="fade">
        <View style={styles.previewContainer}>
          <Pressable
            style={styles.closePreview}
            onPress={() => setPreviewVisible(false)}
          >
            <Text style={styles.closePreviewText}>x</Text>
          </Pressable>

          <Image source={{ uri: previewImage }} style={styles.previewImage} />
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
    width: 36,
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
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
    top: 60,
    right: 30,
    zIndex: 999,
  },
  closePreviewText: {
    color: '#FFF',
    fontSize: 32,
    fontWeight: 'bold',
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
