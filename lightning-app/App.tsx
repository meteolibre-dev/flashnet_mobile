import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Platform, StatusBar, TextInput, Dimensions, Image } from 'react-native';
import Slider from '@react-native-community/slider';
import MapLibreGL from '@maplibre/maplibre-react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as Location from 'expo-location';
import * as Font from 'expo-font';

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

// Free OSM vector style from MapTiler (get free key at https://cloud.maptiler.com/)
const MAPTILER_API_KEY = 'Jn3KRzqaoa55axAJ3gnp';

// MapTiler Basic style - detailed OSM vector rendering
const OSM_VECTOR_STYLE = `https://api.maptiler.com/maps/basic-v2/style.json?key=${MAPTILER_API_KEY}`;

// CartoCDN Light - free, simple map perfect for weather overlays
const CARTOLIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// Fallback: Detailed OSM raster tiles (works without API key)
const OSM_RASTER_STYLE = JSON.stringify({
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      minzoom: 0,
      maxzoom: 19
    }
  ]
});

const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";

// Production Cloud Run endpoint
const SERVER_URL = "https://lightning-server-935480850831.europe-west3.run.app";

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

interface PrefetchedData {
  url: string;
  coordinates: any;
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
                  label: `${hour}h${minute}`,
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
  const [isLoading, setIsLoading] = useState(false); // internal, not shown in UI
  const [isAppReady, setIsAppReady] = useState(false);

  // Load custom font for splash screen
  useEffect(() => {
    Font.loadAsync({
      'Orbitron': require('./assets/Orbitron-Regular.ttf'),
    }).catch(e => {
      console.warn('Font loading failed:', e);
    });
  }, []);

  // Layer 0 State
  const [layerUrl, setLayerUrl] = useState<string | null>(null);
  const [layerCoordinates, setLayerCoordinates] = useState<any>(null);
  const [layerId, setLayerId] = useState<string>("src-0");

  // Layer 1 State
  const [nextLayerUrl, setNextLayerUrl] = useState<string | null>(null);
  const [nextLayerCoordinates, setNextLayerCoordinates] = useState<any>(null);
  const [nextLayerId, setNextLayerId] = useState<string>("src-1");

  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const [prevActiveLayerIndex, setPrevActiveLayerIndex] = useState<0 | 1 | null>(null);
  const isUpdatingLayer = useRef(false);

  // Pre-fetch cache
  const [prefetchedData, setPrefetchedData] = useState<Record<string, PrefetchedData>>({});

  const cameraRef = useRef<any>(null);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  // Computed time (10 minutes before first timestep)
  const computedTime = useMemo(() => {
    if (timesteps.length === 0) return null;
    const firstStep = timesteps[0]?.fullDate;
    if (!firstStep) return null;
    return new Date(firstStep.getTime() - 10 * 60 * 1000);
  }, [timesteps]);

  // Format computed time as HH:MM
  const computedTimeString = useMemo(() => {
    if (!computedTime) return '';
    return computedTime.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
  }, [computedTime]);

  // Full date string for display
  const fullDateString = useMemo(() => {
    if (!selectedStep?.fullDate) return '';
    return selectedStep.fullDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
  }, [selectedStep]);

  // Get user location on mount
  useEffect(() => {
    const getUserLocation = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          console.log('Location permission denied');
          return;
        }

        const location = await Location.getCurrentPositionAsync({});
        const { longitude, latitude } = location.coords;

        // Check if user is within Europe bounds
        if (longitude >= REGION.west && longitude <= REGION.east &&
            latitude >= REGION.south && latitude <= REGION.north) {
          setUserLocation([longitude, latitude]);

          // Center map on user location
          if (cameraRef.current) {
            cameraRef.current.setCamera({
              centerCoordinate: [longitude, latitude],
              zoomLevel: 6,
              animationDuration: 1000,
            });
          }
        }
      } catch (error) {
        console.error('Error getting location:', error);
      }
    };

    getUserLocation();
  }, []);

  // Initialize Data
  useEffect(() => {
    const initTimesteps = async () => {
      setIsScanning(true);
      try {
        const available = await scanAvailableTimesteps(18);
        setTimesteps(available);
        if (available.length > 0) {
          setSelectedStep(available[0]);
        }
      } catch (error) {
        console.error('Error scanning timesteps:', error);
      } finally {
        setIsScanning(false);
        // Additional delay to let splash screen show longer
        await new Promise(resolve => setTimeout(resolve, 1000));
        await SplashScreen.hideAsync();
        setIsAppReady(true);
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
      }, 3000); // 3 seconds to allow satellite images to load
    } else {
      if (playInterval.current) clearInterval(playInterval.current);
    }
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying, timesteps, isLoading]);

  // Clear hidden layer when it changes (frees MapLibre native memory)
  useEffect(() => {
    if (prevActiveLayerIndex !== null) {
      // Delay cleaning the old layer to prevent blinking/empty frames while the new one loads
      // Android native image loading is async and takes time
      const timeout = setTimeout(() => {
        if (prevActiveLayerIndex === 0) {
          setLayerUrl(null);
          setLayerCoordinates(null);
        } else {
          setNextLayerUrl(null);
          setNextLayerCoordinates(null);
        }
        setPrevActiveLayerIndex(null);
      }, 4000); // Wait 4s before clearing old layer (longer than interval to prevent blanks)

      return () => clearTimeout(timeout);
    }
  }, [prevActiveLayerIndex]);

  // Clear buffer layers when playback stops to free memory
  useEffect(() => {
    if (!isPlaying) {
      // Keep only the current active layer, clear the buffer
      if (activeLayerIndex === 1) {
        setLayerUrl(null);
        setLayerCoordinates(null);
      } else {
        setNextLayerUrl(null);
        setNextLayerCoordinates(null);
      }
    }
  }, [isPlaying, activeLayerIndex]);

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

      // Only update results if query hasn't changed (ignore stale results)
      setSearchQuery(currentQuery => {
        if (currentQuery === query) {
          setSearchResults(data);
          setShowSearchResults(true);
        }
        return currentQuery;
      });
    } catch (error) {
      console.error('Search error:', error);
    }
  };

  const handleSearchChange = (text: string) => {
    setSearchQuery(text);
    if (text.length >= 2) {
      const debounce = setTimeout(() => searchLocation(text), 700);
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

  // Pre-fetch function for better preloading
  const prefetchTimestep = useCallback(async (step: Timestep) => {
    if (!step) return;
    const cacheKey = `${step.filenameTime}_${selectedChannel.id}`;
    if (prefetchedData[cacheKey]) return;

    try {
      const tiffUrl = `${BASE_BUCKET_URL}/${step.dateFolder}/forecast_${step.filenameTime}_${selectedChannel.id}.tiff`;
      const metaUrl = `${SERVER_URL}/metadata?url=${encodeURIComponent(tiffUrl)}`;

      // Fetch metadata
      const metaRes = await fetch(metaUrl);
      if (!metaRes.ok) return;
      const metaData = await metaRes.json();

      const imageUrl = `${SERVER_URL}/image?url=${encodeURIComponent(tiffUrl)}&channel=${selectedChannel.id}`;

      // Store in prefetch cache
      setPrefetchedData(prev => ({
        ...prev,
        [cacheKey]: { url: imageUrl, coordinates: metaData.coordinates }
      }));

      // Trigger a silent background download to warm the cache
      fetch(imageUrl, { method: 'HEAD' }).catch(() => {});
    } catch (e) {
      console.warn('Pre-fetch failed', e);
    }
  }, [selectedChannel.id, prefetchedData]);

  // Pre-fetch next logic - enhanced for smoother playback
  useEffect(() => {
    if (!selectedStep || timesteps.length === 0) return;

    const currentIndex = timesteps.findIndex(s => s.filenameTime === selectedStep.filenameTime);

    // Pre-fetch next 3 timesteps for smoother animation
    const nextSteps = [
        timesteps[(currentIndex + 1) % timesteps.length],
        timesteps[(currentIndex + 2) % timesteps.length],
        timesteps[(currentIndex + 3) % timesteps.length],
    ].filter(Boolean);

    // Prefetch in parallel for faster loading
    Promise.all(nextSteps.map(step => prefetchTimestep(step)));

    // Cleanup old cache entries (keep last 15)
    if (Object.keys(prefetchedData).length > 30) {
        setPrefetchedData(prev => {
            const keys = Object.keys(prev);
            const newCache = { ...prev };
            keys.slice(0, keys.length - 15).forEach(k => delete newCache[k]);
            return newCache;
        });
    }

  }, [selectedStep, selectedChannel, timesteps, prefetchTimestep, prefetchedData]);

  // Update Layer Logic
  useEffect(() => {
    const controller = new AbortController();

    const updateLayer = async () => {
        if (!selectedStep) return;

        // Skip if already updating to prevent overlapping requests
        if (isUpdatingLayer.current) return;
        isUpdatingLayer.current = true;

        setIsLoading(true);
        try {
          const cacheKey = `${selectedStep.filenameTime}_${selectedChannel.id}`;
          let metaData;
          let imageUrl;

          if (prefetchedData[cacheKey]) {
            // Use cached data immediately
            metaData = prefetchedData[cacheKey];
            imageUrl = metaData.url;
          } else {
            const tiffUrl = `${BASE_BUCKET_URL}/${selectedStep.dateFolder}/forecast_${selectedStep.filenameTime}_${selectedChannel.id}.tiff`;

            // 1. Get Metadata (Coordinates)
            const metaUrl = `${SERVER_URL}/metadata?url=${encodeURIComponent(tiffUrl)}`;
            const metaRes = await fetch(metaUrl, { signal: controller.signal });
            if (!metaRes.ok) throw new Error('Failed to fetch metadata');
            const data = await metaRes.json();
            metaData = { coordinates: data.coordinates };

            // 2. Set Image URL
            imageUrl = `${SERVER_URL}/image?url=${encodeURIComponent(tiffUrl)}&channel=${selectedChannel.id}`;
          }

          // Double Buffering Logic with Memory Management
          // We load the new image into the "next" layer slot, then swap.
          // After swapping, we clear the hidden layer to free memory.

          // Generate unique ID to ensure fresh native source allocation
          const uniqueId = `src-${Date.now()}`;

          if (activeLayerIndex === 0) {
             // Set the new layer
             setNextLayerId(uniqueId);
             setNextLayerUrl(imageUrl);
             setNextLayerCoordinates(metaData.coordinates);
             // Track previous and swap
             setPrevActiveLayerIndex(0);
             setActiveLayerIndex(1);
          } else {
             // Set the new layer
             setLayerId(uniqueId);
             setLayerUrl(imageUrl);
             setLayerCoordinates(metaData.coordinates);
             // Track previous and swap
             setPrevActiveLayerIndex(1);
             setActiveLayerIndex(0);
          }

        } catch (error) {
            console.error('Error updating layer:', error);
        } finally {
            setIsLoading(false);
            isUpdatingLayer.current = false;
        }
    };

    updateLayer();

    return () => controller.abort();
  }, [selectedStep, selectedChannel]);

  return (
    <View style={styles.page}>
      {/* Custom Splash Screen */}
      {!isAppReady && (
        <View style={styles.splashContainer}>
          <Image source={require('./assets/icon.png')} style={styles.splashLogo} />
          <Text style={styles.splashTitle}>by meteolibre</Text>
        </View>
      )}

      <StatusBar barStyle="light-content" />

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

        {/* Computation Time Badge - below search bar */}
        {timesteps.length > 0 && computedTimeString && (
          <View style={styles.computedTimeBadge}>
            <Text style={styles.computedTimeText}>
              Computed at {computedTimeString} UTC
            </Text>
          </View>
        )}
      </View>

      {/* Map */}
      <MapLibreGL.MapView
        style={styles.map}
        mapStyle={CARTOLIGHT_STYLE}
        logoEnabled={false}
        attributionEnabled={true}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [(REGION.west + REGION.east) / 2, (REGION.north + REGION.south) / 2],
            zoomLevel: 3
          }}
          maxBounds={{
            ne: [REGION.east, REGION.north],
            sw: [REGION.west, REGION.south]
          }}
        />

        {/* Overlay Layers - Dynamic Order */}
        {activeLayerIndex === 1 ? (
          <>
             {/* Render 0 (Bottom) then 1 (Top) */}
             {layerUrl && layerCoordinates && (
               <MapLibreGL.ImageSource id={layerId} coordinates={layerCoordinates} url={layerUrl}>
                 <MapLibreGL.RasterLayer id={`layer-${layerId}`} style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
             {nextLayerUrl && nextLayerCoordinates && (
               <MapLibreGL.ImageSource id={nextLayerId} coordinates={nextLayerCoordinates} url={nextLayerUrl}>
                 <MapLibreGL.RasterLayer id={`layer-${nextLayerId}`} style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
          </>
        ) : (
          <>
             {/* Render 1 (Bottom) then 0 (Top) */}
             {nextLayerUrl && nextLayerCoordinates && (
               <MapLibreGL.ImageSource id={nextLayerId} coordinates={nextLayerCoordinates} url={nextLayerUrl}>
                 <MapLibreGL.RasterLayer id={`layer-${nextLayerId}`} style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
             {layerUrl && layerCoordinates && (
               <MapLibreGL.ImageSource id={layerId} coordinates={layerCoordinates} url={layerUrl}>
                 <MapLibreGL.RasterLayer id={`layer-${layerId}`} style={{ rasterOpacity: 0.8, rasterFadeDuration: 0 }} />
               </MapLibreGL.ImageSource>
             )}
          </>
        )}
      </MapLibreGL.MapView>
      
      {/* Remove loading overlay during playback - double buffering prevents blanks */}

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
        
        {/* Timeline Slider */}
        <View style={styles.timelineContainer}>
          {isScanning ? (
            <Text style={styles.scanningText}>Scanning...</Text>
          ) : timesteps.length === 0 ? (
            <Text style={styles.errorText}>No timesteps</Text>
          ) : (
            <>
              <View style={styles.timeLabels}>
                <Text style={styles.timeLabel}>{timesteps[0]?.label}</Text>
                <Text style={styles.currentTimeLabel}>{fullDateString}</Text>
                <Text style={styles.timeLabel}>{timesteps[timesteps.length - 1]?.label}</Text>
              </View>
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={timesteps.length - 1}
                step={1}
                value={timesteps.findIndex(s => s.filenameTime === selectedStep?.filenameTime)}
                onValueChange={(value) => setSelectedStep(timesteps[Math.round(value)])}
                minimumTrackTintColor="#007AFF"
                maximumTrackTintColor="rgba(255,255,255,0.3)"
                thumbTintColor="#007AFF"
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#000',
  },
  map: {
    flex: 1,
  },
  computedTimeBadge: {
    marginTop: 8,
    backgroundColor: 'rgba(220, 38, 38, 0.9)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'center',
  },
  computedTimeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  searchContainer: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 40 : 50,
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
  timelineContainer: {
    width: '100%',
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 15,
    padding: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  timeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 5,
    marginBottom: 5,
  },
  timeLabel: {
    color: '#888',
    fontSize: 11,
    minWidth: 40,
    textAlign: 'center',
  },
  currentTimeLabel: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: 'bold',
    minWidth: 50,
    textAlign: 'center',
  },
  slider: {
    width: '100%',
    height: 40,
  },
  scanningText: {
    color: '#007AFF',
    padding: 10,
    textAlign: 'center',
  },
  errorText: {
    color: '#FF3B30',
    padding: 10,
    textAlign: 'center',
  },
  // Custom Splash Screen
  splashContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  splashLogo: {
    width: 150,
    height: 150,
    resizeMode: 'contain',
  },
  splashTitle: {
    color: '#ffffff',
    fontSize: 16,
    marginTop: 20,
    fontFamily: 'Orbitron',
    fontWeight: '900',
    letterSpacing: 4,
    textTransform: 'uppercase',
  },
});
