import React, { useEffect, useRef, useState, useCallback } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Platform, StatusBar, Image, TextInput, Dimensions } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import * as SplashScreen from 'expo-splash-screen';

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

// Set access token if needed (null for MapLibre/OpenStreetMap)
MapLibreGL.setAccessToken(null);

// --- Configuration ---
const REGION = {
  west: -10.0,
  north: 65.0,
  east: 33.0,
  south: 33.0,
};

const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";
// Android Emulator Localhost: 10.0.2.2
// iOS Simulator Localhost: 127.0.0.1
// Physical Device: Use your machine's LAN IP
const SERVER_URL = Platform.OS === 'android' ? "http://10.0.2.2:3000" : "http://127.0.0.1:3000";

const CHANNELS = [
  { id: 'lightning', label: 'Lightning' },
  { id: 'sat_ch0', label: 'VIS (Ch0)' },
  { id: 'sat_ch1', label: 'IR (Ch1)' },
];

interface Timestep {
  dateFolder: string;
  filenameTime: string;
  label: string;
  fullDate: Date;
}

const scanAvailableTimesteps = async (maxTimesteps: number = 18): Promise<Timestep[]> => {
  const availableTimesteps: Timestep[] = [];
  const now = new Date();
  
  const datesToCheck = [];
  for (let i = 0; i < 2; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    datesToCheck.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }

  for (const dateFolder of datesToCheck) {
    const listUrl = `https://storage.googleapis.com/storage/v1/b/inference_result/o?prefix=forecasts/${dateFolder}/`;
    try {
      const response = await fetch(listUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.items) {
          for (const item of data.items) {
            const match = item.name.match(/forecast_(\d{12})_lightning\.tiff$/);
            if (match) {
              const filenameTime = match[1];
              const year = filenameTime.substring(0, 4);
              const month = filenameTime.substring(4, 6);
              const day = filenameTime.substring(6, 8);
              const hour = filenameTime.substring(8, 10);
              const minute = filenameTime.substring(10, 12);
              
              const fullDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
              
              if (!availableTimesteps.find(s => s.filenameTime === filenameTime)) {
                availableTimesteps.push({
                  dateFolder,
                  filenameTime,
                  label: `${hour}:${minute}`,
                  fullDate
                });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error listing files for ${dateFolder}:`, error);
    }
  }
  
  return availableTimesteps.sort((a, b) => a.fullDate.getTime() - b.fullDate.getTime()).slice(-maxTimesteps);
};

export default function App() {
  const [timesteps, setTimesteps] = useState<Timestep[]>([]);
  const [selectedStep, setSelectedStep] = useState<Timestep | null>(null);
  const [selectedChannel, setSelectedChannel] = useState(CHANNELS[0]);
  const [isPlaying, setIsPlaying] = useState(false);
  const playInterval = useRef<any>(null);
  const [isScanning, setIsScanning] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [layerUrl, setLayerUrl] = useState<string | null>(null);
  const [layerCoordinates, setLayerCoordinates] = useState<any>(null);
  const [nextLayerUrl, setNextLayerUrl] = useState<string | null>(null);
  const [nextLayerCoordinates, setNextLayerCoordinates] = useState<any>(null);
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);

  const cameraRef = useRef<any>(null);

  // Initialize Data
  useEffect(() => {
    const initTimesteps = async () => {
      setIsScanning(true);
      try {
        const available = await scanAvailableTimesteps(18);
        setTimesteps(available);
        if (available.length > 0) {
          setSelectedStep(available[available.length - 1]);
        }
      } catch (error) {
        console.error('Error scanning timesteps:', error);
      } finally {
        setIsScanning(false);
        await SplashScreen.hideAsync();
      }
    };
    initTimesteps();
  }, []);

  // Playback Logic
  useEffect(() => {
    if (isPlaying && timesteps.length > 0) {
      playInterval.current = setInterval(() => {
        setSelectedStep((prevStep) => {
          if (!prevStep) return timesteps[0];
          const currentIndex = timesteps.findIndex(s => s.filenameTime === prevStep.filenameTime);
          const nextIndex = (currentIndex + 1) % timesteps.length;
          return timesteps[nextIndex];
        });
      }, 1000);
    } else {
      if (playInterval.current) clearInterval(playInterval.current);
    }
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying, timesteps]);

  // Search Logic
  const searchLocation = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`,
        { headers: { 'User-Agent': 'FlashNetMobile/1.0' } }
      );
      const data = await response.json();
      setSearchResults(data);
      setShowSearchResults(true);
    } catch (error) {
      console.error('Search error:', error);
    }
  };

  const handleSearchChange = (text: string) => {
    setSearchQuery(text);
    if (text.length >= 2) {
      const debounce = setTimeout(() => searchLocation(text), 300);
      return () => clearTimeout(debounce);
    } else {
      setSearchResults([]);
      setShowSearchResults(false);
    }
  };

  const selectLocation = (result: any) => {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    
    if (cameraRef.current) {
        cameraRef.current.setCamera({
            centerCoordinate: [lon, lat],
            zoomLevel: 7,
            animationDuration: 1000,
        });
    }

    setSearchQuery(result.display_name.split(',')[0]);
    setShowSearchResults(false);
  };

  // Update Layer Logic
  useEffect(() => {
    const updateLayer = async () => {
        if (!selectedStep) return;
        
        setIsLoading(true);
        try {
          const tiffUrl = `${BASE_BUCKET_URL}/${selectedStep.dateFolder}/forecast_${selectedStep.filenameTime}_${selectedChannel.id}.tiff`;
          
          // 1. Get Metadata (Coordinates)
          const metaUrl = `${SERVER_URL}/metadata?url=${encodeURIComponent(tiffUrl)}`;
          const metaRes = await fetch(metaUrl);
          if (!metaRes.ok) throw new Error('Failed to fetch metadata');
          const metaData = await metaRes.json();
          
          // 2. Set Image URL
          const imageUrl = `${SERVER_URL}/image?url=${encodeURIComponent(tiffUrl)}&channel=${selectedChannel.id}`;
          
          // Double Buffering Logic
          // We load the new image into the "next" layer slot
          // In React Native MapLibre, we can't easily detect "onLoad".
          // However, since we are using a local server that caches the PNG, the load should be fast.
          // We will update the "active" layer pointer immediately, but we keep rendering BOTH layers.
          // The "new" layer will render on top of the "old" layer.
          
          if (activeLayerIndex === 0) {
             setNextLayerUrl(imageUrl);
             setNextLayerCoordinates(metaData.coordinates);
             setActiveLayerIndex(1);
             // After a delay, clear the old layer to save memory? 
             // Or just keep it. It's hidden by the new one.
          } else {
             setLayerUrl(imageUrl);
             setLayerCoordinates(metaData.coordinates);
             setActiveLayerIndex(0);
          }

        } catch (error) {
            console.error('Error updating layer:', error);
        } finally {
            setIsLoading(false);
        }
    };

    updateLayer();
  }, [selectedStep, selectedChannel]);

  return (
    <View style={styles.page}>
      <StatusBar barStyle="light-content" />
      
      {/* Navbar */}
      <View style={styles.navbar}>
        <Image 
            source={require('./public/logo_small.png')} 
            style={styles.logo} 
            resizeMode="contain" 
        />
        <Text style={styles.title}>FlashNet</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search location..."
          placeholderTextColor="#888"
          value={searchQuery}
          onChangeText={handleSearchChange}
          onFocus={() => searchResults.length > 0 && setShowSearchResults(true)}
        />
        {showSearchResults && searchResults.length > 0 && (
          <View style={styles.searchResults}>
            {searchResults.map((result, index) => (
              <TouchableOpacity
                key={index}
                style={styles.searchResultItem}
                onPress={() => selectLocation(result)}
              >
                <Text style={styles.searchResultText} numberOfLines={1}>
                  {result.display_name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Map */}
      <MapLibreGL.MapView
        style={styles.map}
        // @ts-ignore
        styleURL="https://demotiles.maplibre.org/style.json"
        logoEnabled={false}
        attributionEnabled={false}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [(REGION.west + REGION.east) / 2, (REGION.north + REGION.south) / 2],
            zoomLevel: 2
          }}
        />

        {/* Overlay Layers - Dynamic Order */}
        {activeLayerIndex === 1 ? (
          <>
             {/* Render 0 (Bottom) then 1 (Top) */}
             {layerUrl && layerCoordinates && (
               <MapLibreGL.ImageSource id="src-0" coordinates={layerCoordinates} url={layerUrl}>
                 <MapLibreGL.RasterLayer id="layer-0" style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
             {nextLayerUrl && nextLayerCoordinates && (
               <MapLibreGL.ImageSource id="src-1" coordinates={nextLayerCoordinates} url={nextLayerUrl}>
                 <MapLibreGL.RasterLayer id="layer-1" style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
          </>
        ) : (
          <>
             {/* Render 1 (Bottom) then 0 (Top) */}
             {nextLayerUrl && nextLayerCoordinates && (
               <MapLibreGL.ImageSource id="src-1" coordinates={nextLayerCoordinates} url={nextLayerUrl}>
                 <MapLibreGL.RasterLayer id="layer-1" style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
             {layerUrl && layerCoordinates && (
               <MapLibreGL.ImageSource id="src-0" coordinates={layerCoordinates} url={layerUrl}>
                 <MapLibreGL.RasterLayer id="layer-0" style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
          </>
        )}
      </MapLibreGL.MapView>
      
      {isLoading && (
        <View style={styles.loader}>
          <Text style={styles.loaderText}>Loading...</Text>
        </View>
      )}

      {/* Controls */}
      <View style={styles.controlsContainer}>
        <View style={styles.controlsRow}>
            <TouchableOpacity 
              onPress={() => setIsPlaying(!isPlaying)}
              style={[styles.playBtn, isPlaying && styles.pauseBtn]}
            >
              <Text style={styles.playBtnText}>{isPlaying ? "II" : "▶"}</Text>
            </TouchableOpacity>

             <View style={styles.channelRow}>
              {CHANNELS.map((ch) => (
                <TouchableOpacity
                  key={ch.id}
                  onPress={() => setSelectedChannel(ch)}
                  style={[styles.channelBtn, selectedChannel.id === ch.id && styles.selectedBtn]}
                >
                  <Text style={[styles.btnText, selectedChannel.id === ch.id && styles.selectedBtnText]}>
                    {ch.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
        </View>
        
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.timeScroll}
            contentContainerStyle={styles.scrollContent}
        >
            {isScanning ? (
                <Text style={styles.scanningText}>Scanning...</Text>
            ) : timesteps.length === 0 ? (
                <Text style={styles.errorText}>No timesteps</Text>
            ) : (
                timesteps.map((step) => (
                <TouchableOpacity
                    key={step.filenameTime}
                    onPress={() => setSelectedStep(step)}
                    style={[styles.timeBtn, selectedStep?.filenameTime === step.filenameTime && styles.selectedBtn]}
                >
                    <Text style={[styles.btnText, selectedStep?.filenameTime === step.filenameTime && styles.selectedBtnText]}>
                    {step.label}
                    </Text>
                </TouchableOpacity>
                ))
            )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#000',
  },
  navbar: {
    height: 60,
    backgroundColor: '#000',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#00FFFF',
    zIndex: 10,
    marginTop: Platform.OS === 'android' ? 25 : 0
  },
  logo: {
    width: 30,
    height: 30,
    marginRight: 10,
  },
  title: {
    color: '#00FFFF',
    fontSize: 20,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  map: {
    flex: 1,
  },
  searchContainer: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 95 : 70, // Adjust for status bar/navbar
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1500,
  },
  searchInput: {
    width: '60%',
    backgroundColor: 'white',
    borderRadius: 25,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#333',
    fontSize: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  searchResults: {
    width: '60%',
    marginTop: 4,
    backgroundColor: 'white',
    borderRadius: 12,
    maxHeight: 200,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  searchResultItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  searchResultText: {
    color: '#333',
    fontSize: 14,
  },
  loader: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -50 }, { translateY: -50 }],
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 15,
    borderRadius: 10,
    zIndex: 2000,
  },
  loaderText: {
    color: 'white',
    fontWeight: 'bold',
  },
  controlsContainer: {
    position: 'absolute',
    bottom: 30,
    left: 10,
    right: 10,
    zIndex: 100,
    alignItems: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 20,
    padding: 10,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 10,
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  pauseBtn: {
    backgroundColor: '#FF3B30',
  },
  playBtnText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
  channelRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 20,
    padding: 2,
  },
  channelBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 18,
  },
  timeScroll: {
    maxHeight: 40,
    width: '100%',
  },
  scrollContent: {
    alignItems: 'center',
  },
  timeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 15,
    marginRight: 5,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  selectedBtn: {
    backgroundColor: '#007AFF',
  },
  btnText: {
    color: '#888',
    fontSize: 12,
  },
  selectedBtnText: {
    color: 'white',
    fontWeight: 'bold',
  },
  scanningText: {
    color: '#00FFFF',
    padding: 10,
  },
  errorText: {
    color: '#FF3B30',
    padding: 10,
  }
});
