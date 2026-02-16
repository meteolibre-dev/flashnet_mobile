import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Image, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoaded(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      {!isLoaded && (
        <View style={styles.splash}>
          <Image
            source={require('./assets/splash_highres.png')}
            style={styles.splashImage}
            resizeMode="contain"
          />
        </View>
      )}
      <WebView
        source={{ uri: 'https://meteolibre.dev/forecast-of-the-day' }}
        style={{ flex: 1, opacity: isLoaded ? 1 : 0 }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
        onLoadEnd={() => setIsLoaded(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  splash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  splashImage: {
    width: '100%',
    height: '100%',
  },
});
