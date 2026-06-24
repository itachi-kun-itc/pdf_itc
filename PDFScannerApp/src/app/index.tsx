import { useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import * as ImagePicker from 'expo-image-picker';
import DraggableFlatList, {
  RenderItemParams,
} from 'react-native-draggable-flatlist';

type ScanPage = {
  id: string;
  uri: string;
  fileName: string;
  fileSize: number;
  createdAt: number;
};

type CameraMode = 'scan' | 'photo';

const isDesktopWeb = () => {
  if (Platform.OS !== 'web') return false;
  if (typeof navigator === 'undefined') return false;
  return !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
};

export default function HomeScreen() {
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewImage, setPreviewImage] = useState('');
  const [cameraModeVisible, setCameraModeVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const addPage = (asset: ImagePicker.ImagePickerAsset) => {
    setPages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        uri: asset.uri,
        fileName: asset.fileName ?? `scan_${Date.now()}.jpg`,
        fileSize: asset.fileSize ?? 0,
        createdAt: Date.now(),
      },
    ]);
  };

  const launchCamera = async (mode: CameraMode) => {
    try {
      setStatusMessage('');

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
        quality: mode === 'scan' ? 1 : 0.92,
        allowsEditing: mode === 'scan',
        aspect: mode === 'scan' ? [3, 4] : undefined,
      });

      if (!result.canceled) {
        addPage(result.assets[0]);
      }
    } catch {
      setStatusMessage('カメラを起動できませんでした。');
    }
  };

  const launchLibrary = async () => {
    try {
      setStatusMessage('');

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
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

  const startScanFlow = () => {
    if (isDesktopWeb()) {
      void launchLibrary();
      return;
    }

    setCameraModeVisible(true);
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
          <Text style={styles.deleteText}>×</Text>
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
          accessibilityLabel="順序を入れ替える"
        >
          <Text style={styles.dragText}>⋮⋮⋮</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <DraggableFlatList
        data={pages}
        keyExtractor={(item) => item.id}
        renderItem={renderPage}
        onDragEnd={({ data }) => setPages(data)}
        activationDistance={4}
        contentContainerStyle={styles.container}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.buttonRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  styles.scanButton,
                  pressed && styles.buttonPressed,
                ]}
                onPress={startScanFlow}
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
                  if (pages.length === 0) {
                    Alert.alert('PDF作成', '先に1枚以上の写真を追加してください。');
                    return;
                  }
                  setStatusMessage('PDF作成は次の段階でつなぎ込みます。');
                }}
              >
                <Text style={styles.buttonText}>PDFを作成して共有</Text>
              </Pressable>
            </View>

            {statusMessage ? (
              <Text style={styles.statusText}>{statusMessage}</Text>
            ) : null}

            <Text style={styles.sectionTitle}>スキャン済みページ ({pages.length})</Text>

            {pages.length === 0 ? (
              <Text style={styles.emptyText}>
                まだページがありません。スキャン開始から写真を追加してください。
              </Text>
            ) : null}
          </View>
        }
      />

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
              <Text style={styles.modalButtonText}>通常の撮影</Text>
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
              <Text style={styles.modalButtonText}>写真から追加</Text>
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

      <Modal visible={previewVisible} transparent animationType="fade">
        <View style={styles.previewContainer}>
          <Pressable
            style={styles.closePreview}
            onPress={() => setPreviewVisible(false)}
          >
            <Text style={styles.closePreviewText}>×</Text>
          </Pressable>

          <Image source={{ uri: previewImage }} style={styles.previewImage} />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#06152A',
  },
  container: {
    padding: 20,
    paddingTop: 54,
    paddingBottom: 40,
    backgroundColor: '#06152A',
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
    backgroundColor: '#1B2A45',
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
    marginBottom: 12,
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
