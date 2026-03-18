import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, Image, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';

export default function App() {
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimeElapsed(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Get user location
  useEffect(() => {
    const getLocation = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;

        const location = await Location.getCurrentPositionAsync({});
        setUserLocation({
          lat: location.coords.latitude,
          lon: location.coords.longitude
        });
      } catch (error) {
        console.log('Location error:', error);
      }
    };
    getLocation();
  }, []);

  const isLoaded = minTimeElapsed && webViewLoaded;

  const handleWebViewLoad = async () => {
    setWebViewLoaded(true);
    
    const setupMap = async () => {
      if (!userLocation) return;
      
      const { latitude, longitude } = userLocation;
      
      const jsCode = `
        (function() {
          var attempts = 0;
          var maxAttempts = 20;
          var checkMap = setInterval(function() {
            attempts++;
            if (window.mapInstance) {
              var map = window.mapInstance;
              
              map.flyTo({
                center: [${longitude}, ${latitude}],
                zoom: 7,
                essential: true
              });
              
              clearInterval(checkMap);
            }
            if (attempts >= maxAttempts) {
              clearInterval(checkMap);
            }
          }, 500);
        })();
        true;
      `;
      
      webViewRef.current?.injectJavaScript(jsCode);
    };

    setTimeout(setupMap, 2000);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      {!isLoaded && (
        <View style={styles.splash}>
          <Image
            source={require('./assets/mainimage_highres.png')}
            style={styles.splashImage}
            resizeMode="contain"
          />
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://meteolibre.dev/forecast-of-the-day' }}
        style={{ flex: 1, opacity: isLoaded ? 1 : 0 }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
        onLoadEnd={handleWebViewLoad}
        incognito={false}
        cacheEnabled={true}
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
