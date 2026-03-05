import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, Image, StatusBar, TouchableOpacity, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';

type Tab = 'map' | 'local';

export default function App() {
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [currentTab, setCurrentTab] = useState<Tab>('map');
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

  const getWebViewSource = () => {
    if (currentTab === 'map') {
      return { uri: 'https://meteolibre.dev/forecast-of-the-day' };
    } else {
      // Local forecast - pass user location as query params
      const lat = userLocation?.lat || 48.8566;
      const lon = userLocation?.lon || 2.3522;
      return { uri: `https://meteolibre.dev/local-forecast?lat=${lat}&lon=${lon}` };
    }
  };

  const handleTabChange = (tab: Tab) => {
    setWebViewLoaded(false);
    setCurrentTab(tab);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      {!isLoaded && currentTab === 'map' && (
        <View style={styles.splash}>
          <Image
            source={require('./assets/mainimage_highres.png')}
            style={styles.splashImage}
            resizeMode="contain"
          />
        </View>
      )}
      <WebView
        key={currentTab}
        ref={webViewRef}
        source={getWebViewSource()}
        style={{ flex: 1, opacity: isLoaded || currentTab === 'local' ? 1 : 0 }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
        onLoadEnd={currentTab === 'map' ? handleWebViewLoad : undefined}
        incognito={false}
        cacheEnabled={true}
      />
      
      {/* Bottom Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, currentTab === 'map' && styles.tabActive]}
          onPress={() => handleTabChange('map')}
        >
          <Ionicons 
            name="map" 
            size={24} 
            color={currentTab === 'map' ? '#14b8a6' : '#888'} 
          />
          <Text style={[styles.tabLabel, currentTab === 'map' && styles.tabLabelActive]}>
            Map
          </Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[styles.tab, currentTab === 'local' && styles.tabActive]}
          onPress={() => handleTabChange('local')}
        >
          <Ionicons 
            name="location" 
            size={24} 
            color={currentTab === 'local' ? '#14b8a6' : '#888'} 
          />
          <Text style={[styles.tabLabel, currentTab === 'local' && styles.tabLabelActive]}>
            Local
          </Text>
        </TouchableOpacity>
      </View>
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
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderTopWidth: 1,
    borderTopColor: '#333',
    paddingBottom: 20, // Account for home indicator
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  tabActive: {
    // Active state styling
  },
  tabIcon: {
    marginBottom: 4,
  },
  tabLabel: {
    fontSize: 12,
    color: '#888',
  },
  tabLabelActive: {
    color: '#14b8a6', // teal-500
    fontWeight: '600',
  },
});
