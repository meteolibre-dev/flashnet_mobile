import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Platform, StyleSheet, View, Text, TouchableOpacity, TextInput, Animated, Dimensions, Easing, Image } from 'react-native';
import 'maplibre-gl/dist/maplibre-gl.css';

// --- Configuration ---
const REGION = {
  west: -10.0,
  north: 65.0,
  east: 33.0,
  south: 33.0,
};

const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";
// In development: use local server, in production: use Cloud Run endpoint
const SERVER_URL = __DEV__
  ? "http://localhost:3000"
  : "https://lightning-server-935480850831.europe-west1.run.app";

// CartoCDN Light - free, simple map perfect for weather overlays
const CARTOLIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

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
  
  // We'll check today and yesterday to ensure we have enough data
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
            // Pattern: forecasts/YYYY-MM-DD/forecast_YYYYMMDDHHmm_lightning.tiff
            // We only need to check for one channel to identify the timestep
            const match = item.name.match(/forecast_(\d{12})_lightning\.tiff$/);
            if (match) {
              const filenameTime = match[1];
              const year = filenameTime.substring(0, 4);
              const month = filenameTime.substring(4, 6);
              const day = filenameTime.substring(6, 8);
              const hour = filenameTime.substring(8, 10);
              const minute = filenameTime.substring(10, 12);
              
              // Create UTC date object
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
  const mapRef = useRef<any>(null);
  const mapInstance = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(true);

  // Pre-fetch cache
  const [prefetchedData, setPrefetchedData] = useState<Record<string, PrefetchedData>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);

  // Splash Screen Logic
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [isSplashVisible, setIsSplashVisible] = useState(true);

  useEffect(() => {
    // Load custom font for Splash Screen
    const link = document.createElement('link');
    link.href = "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);

    // Wait a bit before sliding up
    const timer = setTimeout(() => {
      Animated.timing(slideAnim, {
        toValue: -Dimensions.get('window').height,
        duration: 800,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        useNativeDriver: false, // Web compatible
      }).start(() => {
        setIsSplashVisible(false);
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Initialize Map (Web Only)
  useEffect(() => {
    if (Platform.OS === 'web' && mapRef.current) {
      import('maplibre-gl').then(({ Map, NavigationControl }) => {
        const map = new Map({
          container: mapRef.current,
          style: CARTOLIGHT_STYLE,
          center: [(REGION.west + REGION.east) / 2, (REGION.north + REGION.south) / 2],
          zoom: 3,
          maxBounds: [[REGION.west, REGION.south], [REGION.east, REGION.north]]
        });

        mapInstance.current = map;
        map.addControl(new NavigationControl());

        map.on('load', () => {
          updateMapLayer();

          // Get user location and center map
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (position) => {
                const { longitude, latitude } = position.coords;

                // Check if user is within Europe bounds
                if (longitude >= REGION.west && longitude <= REGION.east &&
                    latitude >= REGION.south && latitude <= REGION.north) {
                  map.flyTo({
                    center: [longitude, latitude],
                    zoom: 6,
                    duration: 1500
                  });
                }
              },
              (error) => {
                console.log('Geolocation error:', error.message);
              },
              { enableHighAccuracy: false, timeout: 10000 }
            );
          }
        });
      });
    }
  }, []);

  // Close search results when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-search-container]')) {
        setShowSearchResults(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Scan for available timesteps
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
      }, 1000); // 1 second per frame
    } else {
      if (playInterval.current) clearInterval(playInterval.current);
    }
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying, timesteps]);

  const searchLocation = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`
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
    if (mapInstance.current) {
      mapInstance.current.flyTo({ center: [lon, lat], zoom: 7 });
    }
    setSearchQuery(result.display_name.split(',')[0]);
    setShowSearchResults(false);
  };

  // Pre-fetch next logic
  useEffect(() => {
    if (!selectedStep || timesteps.length === 0) return;

    const currentIndex = timesteps.findIndex(s => s.filenameTime === selectedStep.filenameTime);
    const nextSteps = [
        timesteps[(currentIndex + 1) % timesteps.length],
        timesteps[(currentIndex + 2) % timesteps.length],
    ];

    nextSteps.forEach(async (step) => {
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

            // Pre-load image into browser cache
            const img = new (window as any).Image();
            img.src = imageUrl;

        } catch (e) {
            console.warn('Pre-fetch failed', e);
        }
    });

    // Cleanup old cache entries (keep last 20)
    if (Object.keys(prefetchedData).length > 30) {
        setPrefetchedData(prev => {
            const keys = Object.keys(prev);
            const newCache = { ...prev };
            keys.slice(0, keys.length - 10).forEach(k => delete newCache[k]);
            return newCache;
        });
    }

  }, [selectedStep, selectedChannel, timesteps]);

  // Update layer when selection changes
  useEffect(() => {
    if (mapInstance.current && mapInstance.current.isStyleLoaded() && selectedStep) {
      updateMapLayer();
    }
  }, [selectedStep, selectedChannel]);

  const updateMapLayer = async () => {
    if (!mapInstance.current || !selectedStep) return;
    const map = mapInstance.current;
    
    // Clean up previous layers/sources
    if (map.getLayer('forecast-layer')) map.removeLayer('forecast-layer');
    if (map.getSource('forecast-source')) map.removeSource('forecast-source');

    setIsLoading(true);
    try {
      const cacheKey = `${selectedStep.filenameTime}_${selectedChannel.id}`;
      let metaData;
      let imageUrl;

      if (prefetchedData[cacheKey]) {
        metaData = prefetchedData[cacheKey];
        imageUrl = metaData.url;
      } else {
        const tiffUrl = `${BASE_BUCKET_URL}/${selectedStep.dateFolder}/forecast_${selectedStep.filenameTime}_${selectedChannel.id}.tiff`;

        // 1. Get Metadata (Coordinates)
        const metaUrl = `${SERVER_URL}/metadata?url=${encodeURIComponent(tiffUrl)}`;
        const metaRes = await fetch(metaUrl);
        if (!metaRes.ok) throw new Error('Failed to fetch metadata');
        const data = await metaRes.json();
        metaData = { coordinates: data.coordinates };

        // 2. Set Image URL (Full Image)
        imageUrl = `${SERVER_URL}/image?url=${encodeURIComponent(tiffUrl)}&channel=${selectedChannel.id}`;
      }

      console.log('Using Image URL:', imageUrl);
      console.log('Coordinates:', metaData.coordinates);

      map.addSource('forecast-source', {
        type: 'image',
        url: imageUrl,
        coordinates: metaData.coordinates
      });

      map.addLayer({
        id: 'forecast-layer',
        type: 'raster',
        source: 'forecast-source',
        paint: {
          'raster-opacity': selectedChannel.id.startsWith('sat_') ? 0.8 : 0.8,
          'raster-fade-duration': 0
        }
      });

    } catch (error) {
      console.error('Error updating layer:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.page}>

      {/* Search Bar */}
      <View style={styles.searchContainer} data-search-container>
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

      {Platform.OS === 'web' ? (
        <div ref={mapRef} style={styles.map} />
      ) : (
        <View style={styles.map}>
           <Text style={{textAlign:'center', marginTop: 100}}>Map is Web-Only in this prototype</Text>
        </View>
      )}
      
      {/* Loading overlay removed - smooth playback with existing layer */}

      <View style={styles.controlsContainer}>
        {/* Channel Selector */}
        <View style={styles.controlsRow}>
            <TouchableOpacity 
              onPress={() => setIsPlaying(!isPlaying)}
              style={[styles.playBtn, isPlaying && styles.pauseBtn]}
            >
              <Text style={styles.playBtnText}>{isPlaying ? "⏸" : "▶"}</Text>
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
            <Text style={styles.scanningText}>Scanning for available timesteps...</Text>
          ) : timesteps.length === 0 ? (
            <Text style={styles.errorText}>No timesteps available</Text>
          ) : (
            <>
              <View style={styles.timeLabels}>
                <Text style={styles.timeLabel}>{timesteps[0]?.label}</Text>
                <Text style={styles.currentTimeLabel}>{selectedStep?.label}</Text>
                <Text style={styles.timeLabel}>{timesteps[timesteps.length - 1]?.label}</Text>
              </View>
              <input
                type="range"
                min={0}
                max={timesteps.length - 1}
                step={1}
                value={timesteps.findIndex(s => s.filenameTime === selectedStep?.filenameTime)}
                onChange={(e) => setSelectedStep(timesteps[parseInt(e.target.value)])}
                style={{
                  width: '100%',
                  height: 8,
                  borderRadius: 4,
                  background: 'linear-gradient(to right, #007AFF 0%, #007AFF ' +
                    ((timesteps.findIndex(s => s.filenameTime === selectedStep?.filenameTime) / (timesteps.length - 1)) * 100) +
                    '%, rgba(255,255,255,0.3) ' +
                    ((timesteps.findIndex(s => s.filenameTime === selectedStep?.filenameTime) / (timesteps.length - 1)) * 100) +
                    '%, rgba(255,255,255,0.3) 100%)',
                  cursor: 'pointer',
                  appearance: 'none' as any,
                  WebkitAppearance: 'none',
                  outline: 'none',
                }}
              />
            </>
          )}
        </View>
      </View>

      {/* Splash Screen */}
      {isSplashVisible && (
        <Animated.View 
          style={[
            styles.splashScreen, 
            { transform: [{ translateY: slideAnim }] }
          ]}
        >
          <Image
            source={require('./assets/icon.png')}
            style={styles.splashLogo}
            resizeMode="contain"
          />
          <Text style={styles.splashTitle}>by meteolibre</Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    height: '100%',
    backgroundColor: '#000' // Changed to black to match theme
  },
  map: {
    flex: 1,
    width: '100%',
    // Removed minHeight to allow flex layout with navbar
  },
  searchContainer: {
    position: 'absolute',
    top: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1500,
  },
  searchInput: {
    width: '50%',
    backgroundColor: 'white',
    borderRadius: 25,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#333',
    fontSize: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  searchResults: {
    width: '50%',
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
    alignSelf: 'center',
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
    bottom: 20,
    left: 10,
    right: 10,
    zIndex: 1000,
    alignItems: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    width: '100%',
    justifyContent: 'center',
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    elevation: 4,
  },
  pauseBtn: {
    backgroundColor: '#FF3B30',
  },
  playBtnText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  channelRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 25,
    padding: 4,
    elevation: 4,
  },
  channelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  selectedBtn: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  btnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
  selectedBtnText: {
    color: 'white',
  },
  timelineContainer: {
    width: '100%',
    maxWidth: 500,
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 15,
    padding: 15,
    borderWidth: 1,
    borderColor: '#333',
  },
  timeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 5,
    marginBottom: 10,
  },
  timeLabel: {
    color: '#888',
    fontSize: 12,
  },
  currentTimeLabel: {
    color: '#00FFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  scanningText: {
    color: '#00FFFF',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 10,
    textAlign: 'center',
  },
  errorText: {
    color: '#FF3B30',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 10,
    textAlign: 'center',
  },
  splashScreen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  splashLogo: {
    width: 150,
    height: 150,
    marginBottom: 20,
  },
  splashTitle: {
    fontFamily: 'Orbitron, sans-serif',
    color: '#00FFFF',
    fontSize: 48,
    fontWeight: '900',
    letterSpacing: 6,
    textShadowColor: 'rgba(0, 255, 255, 0.8)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 20,
    textTransform: 'uppercase',
  },
});
