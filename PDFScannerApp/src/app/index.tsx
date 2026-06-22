// import { PDFDocument } from 'pdf-lib';
import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Image,
  ScrollView,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';

export default function HomeScreen() {
  const [images, setImages] = useState<string[]>([]);

  const scanDocument = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });

    if (!result.canceled) {
      setImages((prev) => [...prev, result.assets[0].uri]);
    }
  };

const createPdf = () => {
  alert("PDF生成機能は開発中です");
};

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>PDFスキャナー</Text>

      <TouchableOpacity style={styles.button} onPress={scanDocument}>
        <Text style={styles.buttonText}>📷 スキャン開始</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.button} onPress={createPdf}>
        <Text style={styles.buttonText}>📄 PDF生成</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>
        撮影済みページ ({images.length})
      </Text>

      {images.map((uri, index) => (
        <View key={index} style={styles.imageContainer}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
  <Text>ページ {index + 1}</Text>

  <TouchableOpacity
    onPress={() =>
      setImages(images.filter((_, i) => i !== index))
    }
  >
    <Text>🗑️削除</Text>
  </TouchableOpacity>
</View>
          <Image source={{ uri }} style={styles.image} />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingTop: 60,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 30,
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 18,
    borderRadius: 12,
    marginBottom: 20,
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    textAlign: 'center',
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  imageContainer: {
    marginBottom: 20,
  },
  image: {
    width: '100%',
    height: 250,
    borderRadius: 10,
    marginTop: 8,
  },
});