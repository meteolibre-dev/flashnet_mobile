import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Platform, StatusBar, TextInput, Dimensions, Image } from 'react-native';
import Slider from '@react-native-community/slider';
import MapLibreGL from '@maplibre/maplibre-react-native';
import Svg, { Circle } from 'react-native-svg';
import * as FileSystem from 'expo-file-system/legacy';
import * as SplashScreen from 'expo-splash-screen';
import * as Location from 'expo-location';
import * as Font from 'expo-font';
import {
  scanAvailableTimesteps,
  downloadAllFrames,
  fetchMetadata,
  downloadImage,
  Timestep,
  PrefetchedData,
  CHANNELS,
  SERVER_URL,
  BASE_BUCKET_URL,
  REGION
} from './dataService';

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

// Set access token if needed (null for MapLibre/OpenStreetMap)
MapLibreGL.setAccessToken(null);

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

  // Preloading
  const [isPreloading, setIsPreloading] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState(0);
  const cancelPreloadingRef = useRef(false);

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
  const activeLayerIndexRef = useRef(0);
  const latestParamsRef = useRef({ step: selectedStep, channel: selectedChannel });
  const lastProcessedRef = useRef<string | null>(null);

  // Use ref for prefetchedData to ensure access to latest state inside async loops
  const prefetchedDataRef = useRef<Record<string, PrefetchedData>>({});

  useEffect(() => {
    activeLayerIndexRef.current = activeLayerIndex;
  }, [activeLayerIndex]);

  useEffect(() => {
    latestParamsRef.current = { step: selectedStep, channel: selectedChannel };
  }, [selectedStep, selectedChannel]);

  // Pre-fetch cache
  const [prefetchedData, setPrefetchedData] = useState<Record<string, PrefetchedData>>({});

  // Sync ref with state
  useEffect(() => {
    prefetchedDataRef.current = prefetchedData;
  }, [prefetchedData]);

  const cameraRef = useRef<any>(null);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  // Computed time (10 minutes before first timestep)
  const computedTime = useMemo(() => {
    if (timesteps.length === 0) return null;
    const firstStep = timesteps[0]?.fullDate;
    if (!firstStep) return null;
    return new Date(firstStep.getTime() - 10 * 60 * 1000);
  }, [timesteps]);

  // Point forecast data
  const [pointForecastData, setPointForecastData] = useState<any>(null);
  const [pointForecastLoading, setPointForecastLoading] = useState(false);
  const [showPointForecast, setShowPointForecast] = useState(false);

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

  // Hide native splash immediately and show custom full-screen splash
  useEffect(() => {
    SplashScreen.hideAsync();
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
        // Minimum display time for splash screen (2 seconds)
        await new Promise(resolve => setTimeout(resolve, 2000));
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
      }, 1000); // 1000ms delay per frame
    } else {
      if (playInterval.current) clearInterval(playInterval.current);
    }
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying, timesteps]);

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
      }, 3000); // Wait 3s before clearing old layer (longer than interval to prevent blanks)

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

  // Fetch point forecast data for current location
  const fetchPointForecast = async (lat: number, lon: number, channel: string = 'lightning') => {
    setPointForecastLoading(true);
    try {
      const url = `${SERVER_URL}/point?lat=${lat}&lon=${lon}&channel=${channel}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setPointForecastData(data);
        setShowPointForecast(true);
      } else {
        console.error('Failed to fetch point forecast');
      }
    } catch (error) {
      console.error('Error fetching point forecast:', error);
    } finally {
      setPointForecastLoading(false);
    }
  };

  // Handle location button press
  const handleLocationPress = async () => {
    if (!userLocation) {
      // Request location if not available
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          alert('Location permission is required to show local forecast');
          return;
        }
        const location = await Location.getCurrentPositionAsync({});
        const { longitude, latitude } = location.coords;
        if (longitude >= REGION.west && longitude <= REGION.east &&
            latitude >= REGION.south && latitude <= REGION.north) {
          setUserLocation([longitude, latitude]);
          await fetchPointForecast(latitude, longitude, selectedChannel.id);
        } else {
          alert('Your location is outside the forecast coverage area');
        }
      } catch (error) {
        console.error('Error getting location:', error);
      }
    } else {
      // Already have location - toggle panel
      if (showPointForecast) {
        setShowPointForecast(false);
      } else {
        await fetchPointForecast(userLocation[1], userLocation[0], selectedChannel.id);
      }
    }
  };

  // Start preload/download sequence
  const startDownloadSequence = async (steps: Timestep[], channelId: string) => {
    setIsPreloading(true);
    setPreloadProgress(0);
    cancelPreloadingRef.current = false;

    try {
      await downloadAllFrames(
        steps,
        channelId,
        prefetchedDataRef.current,
        (progress) => setPreloadProgress(progress),
        () => cancelPreloadingRef.current,
        Platform.OS === 'web'
      );

      // Sync state with ref
      setPrefetchedData({ ...prefetchedDataRef.current });

    } catch (error) {
       console.error('Preload sequence error:', error);
    } finally {
      setIsPreloading(false);
      if (!cancelPreloadingRef.current) {
        setIsPlaying(true);
      }
    }
  };

  const handlePlayClick = () => {
    if (isPreloading) {
      cancelPreloadingRef.current = true;
      setIsPreloading(false);
    } else if (isPlaying) {
      setIsPlaying(false);
      cancelPreloadingRef.current = true;
    } else {
      startDownloadSequence(timesteps, selectedChannel.id);
    }
  };

  // Update Layer Logic
  useEffect(() => {
    const processQueue = async () => {
        if (isUpdatingLayer.current) return;
        isUpdatingLayer.current = true;
        setIsLoading(true);

        try {
            while (true) {
                const { step, channel } = latestParamsRef.current;
                if (!step) break;

                const targetKey = `${step.filenameTime}_${channel.id}`;
                if (lastProcessedRef.current === targetKey) break;

                try {
                    const cacheKey = `${step.filenameTime}_${channel.id}`;
                    let metaData;
                    let imageUrl;

                    const cached = prefetchedDataRef.current[cacheKey];

                    if (cached) {
                        metaData = cached;
                        imageUrl = cached.localUri || cached.url;
                    } else {
                        const tiffUrl = `${BASE_BUCKET_URL}/${step.dateFolder}/forecast_${step.filenameTime}_${channel.id}.tiff`;

                        // 1. Get Metadata
                        const data = await fetchMetadata(tiffUrl);
                        if (!data) throw new Error('Failed to fetch metadata');
                        metaData = { coordinates: data.coordinates };

                        // 2. Download Image
                        const remoteImageUrl = `${SERVER_URL}/image?url=${encodeURIComponent(tiffUrl)}&channel=${channel.id}`;

                        if (Platform.OS === 'web') {
                            imageUrl = remoteImageUrl;
                        } else {
                            const localUri = `${FileSystem.cacheDirectory}forecasts/${step.filenameTime}_${channel.id}.png`;
                            const downloaded = await downloadImage(remoteImageUrl, localUri);
                            if (!downloaded) throw new Error('Download failed');
                            imageUrl = downloaded;
                        }

                        // Save to cache
                        const newData = { url: remoteImageUrl, coordinates: metaData.coordinates, localUri: imageUrl };
                        prefetchedDataRef.current = { ...prefetchedDataRef.current, [cacheKey]: newData };
                        setPrefetchedData(prev => ({ ...prev, [cacheKey]: newData }));
                    }

                    // Double Buffering Logic
                    const currentActiveIndex = activeLayerIndexRef.current;
                    if (currentActiveIndex === 0) {
                        setNextLayerUrl(imageUrl);
                        setNextLayerCoordinates(metaData.coordinates);
                        setPrevActiveLayerIndex(0);
                        setActiveLayerIndex(1);
                        activeLayerIndexRef.current = 1;
                    } else {
                        setLayerUrl(imageUrl);
                        setLayerCoordinates(metaData.coordinates);
                        setPrevActiveLayerIndex(1);
                        setActiveLayerIndex(0);
                        activeLayerIndexRef.current = 0;
                    }

                    lastProcessedRef.current = targetKey;

                } catch (error) {
                    console.error('Error updating layer:', error);
                    lastProcessedRef.current = targetKey;
                }
            }
        } finally {
            setIsLoading(false);
            isUpdatingLayer.current = false;
        }
    };

    processQueue();
  }, [selectedStep, selectedChannel]);

  return (
    <View style={styles.page}>
      {/* Custom Splash Screen */}
      {!isAppReady && (
        <View style={styles.splashContainer}>
          <Image source={require('./assets/mainimage_highres.png')} style={styles.splashImage} />
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

        {/* Location Button */}
        <TouchableOpacity
          style={styles.locationBtn}
          onPress={handleLocationPress}
        >
          <Text style={styles.locationBtnText}>
            {pointForecastLoading ? '...' : showPointForecast ? '✕' : '📍'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Point Forecast Panel */}
      {showPointForecast && pointForecastData && (
        <View style={styles.pointForecastPanel}>
          <View style={styles.pointForecastHeader}>
            <Text style={styles.pointForecastTitle}>Lightning Forecast</Text>
            <Text style={styles.pointForecastSubtitle}>
              {pointForecastData.coordinates.lat.toFixed(4)}°N, {pointForecastData.coordinates.lon.toFixed(4)}°E
            </Text>
          </View>

          <View style={styles.pointForecastData}>
            {pointForecastData.timesteps.map((step: any, index: number) => (
              <View key={index} style={styles.pointForecastRow}>
                <Text style={styles.pointForecastTime}>
                  {step.timestamp ? `${step.timestamp.substring(8, 10)}:${step.timestamp.substring(10, 12)}` : 'N/A'}
                </Text>
                <View style={[styles.pointForecastValue, step.value !== null && step.value >= 1 && styles.pointForecastValueActive]}>
                  <Text style={[styles.pointForecastValueText, step.value !== null && step.value >= 1 && styles.pointForecastValueTextActive]}>
                    {step.value !== null ? step.value.toFixed(1) : '--'}
                  </Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.pointForecastLegend}>
            <Text style={styles.pointForecastLegendText}>
              Values: 0-4 (higher = more lightning)
            </Text>
          </View>
        </View>
      )}

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
            <View style={{ width: 60, height: 60, justifyContent: 'center', alignItems: 'center', marginRight: 10 }}>
              {isPreloading && (
                <Svg height="60" width="60" style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
                  <Circle
                    cx="30"
                    cy="30"
                    r="28"
                    stroke="rgba(255,255,255,0.2)"
                    strokeWidth="3"
                    fill="none"
                  />
                  <Circle
                    cx="30"
                    cy="30"
                    r="28"
                    stroke="#2dd4bf"
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray={`${2 * Math.PI * 28}`}
                    strokeDashoffset={`${2 * Math.PI * 28 * (1 - preloadProgress)}`}
                    strokeLinecap="round"
                  />
                </Svg>
              )}
              <TouchableOpacity
                onPress={handlePlayClick}
                style={[styles.playBtn, isPlaying && styles.pauseBtn, { marginRight: 0 }]}
              >
                {isPreloading ? (
                   <Text style={[styles.playBtnText, { fontSize: 11, fontWeight: 'bold' }]}>{Math.round(preloadProgress * 100)}%</Text>
                ) : (
                   <Text style={styles.playBtnText}>{isPlaying ? "II" : "▶"}</Text>
                )}
              </TouchableOpacity>
            </View>

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
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 9999,
  },
  splashImage: {
    width: Dimensions.get('screen').width,
    height: Dimensions.get('screen').height,
    resizeMode: 'cover',
  },
  // Location Button
  locationBtn: {
    position: 'absolute',
    right: -180,
    top: 0,
    width: 40,
    height: 40,
    backgroundColor: 'white',
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  locationBtnText: {
    fontSize: 18,
  },
  // Point Forecast Panel
  pointForecastPanel: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 100 : 110,
    right: 10,
    width: 180,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#333',
    zIndex: 1600,
    overflow: 'hidden',
  },
  pointForecastHeader: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    alignItems: 'center',
  },
  pointForecastTitle: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  pointForecastSubtitle: {
    color: '#888',
    fontSize: 10,
    marginTop: 2,
  },
  pointForecastData: {
    maxHeight: 300,
    paddingVertical: 8,
  },
  pointForecastRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  pointForecastTime: {
    color: '#888',
    fontSize: 12,
  },
  pointForecastValue: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 45,
    alignItems: 'center',
  },
  pointForecastValueActive: {
    backgroundColor: 'rgba(255, 200, 0, 0.3)',
  },
  pointForecastValueText: {
    color: '#666',
    fontSize: 12,
    fontWeight: 'bold',
  },
  pointForecastValueTextActive: {
    color: '#ffcc00',
  },
  pointForecastLegend: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#333',
    alignItems: 'center',
  },
  pointForecastLegendText: {
    color: '#555',
    fontSize: 9,
  },
});
