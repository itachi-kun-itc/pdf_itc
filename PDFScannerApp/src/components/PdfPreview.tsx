import { StyleSheet, Text, View } from 'react-native';

type PdfPreviewProps = {
  uri: string;
  variant: 'page' | 'history';
};

export function PdfPreview({ variant }: PdfPreviewProps) {
  const isPagePreview = variant === 'page';

  return (
    <View style={[styles.frame, isPagePreview ? styles.pageFrame : styles.historyFrame]}>
      <View style={styles.fold} />
      <View style={styles.label}>
        <Text style={styles.text}>PDF</Text>
      </View>
      <View style={styles.lineLong} />
      <View style={styles.lineMedium} />
      <View style={styles.lineShort} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 8,
    marginRight: 12,
    backgroundColor: '#F8FAFE',
    borderWidth: 1,
    borderColor: '#526A91',
    overflow: 'hidden',
    padding: 7,
  },
  pageFrame: {
    width: 70,
    height: 90,
  },
  historyFrame: {
    width: 58,
    height: 74,
  },
  fold: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 18,
    height: 18,
    backgroundColor: '#DCE4F2',
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#B9C5DA',
  },
  label: {
    alignSelf: 'flex-start',
    minWidth: 31,
    minHeight: 20,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#B3263B',
    marginBottom: 9,
  },
  text: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 12,
  },
  lineLong: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#C9D4E7',
    marginBottom: 5,
    width: '100%',
  },
  lineMedium: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D5DEED',
    marginBottom: 5,
    width: '74%',
  },
  lineShort: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E0E7F2',
    width: '54%',
  },
});
