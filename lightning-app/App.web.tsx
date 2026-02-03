import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Platform, View, Text, TouchableOpacity, TextInput, Animated, Dimensions, Easing, Image, ScrollView } from 'react-native';
import 'maplibre-gl/dist/maplibre-gl.css';
import { webStyles } from './styles';

// --- Configuration ---
const REGION = {
  west: -10.0,
  north: 65.0,
  east: 33.0,
  south: 33.0,
};

const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";
// In development: use local server, in production: use Cloud Run endpoint
const SERVER_URL = "https://lightning-server-935480850831.europe-west3.run.app";

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

// --- Icons ---
const MapIcon = ({ active }: { active: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

const LocationIcon = ({ active }: { active: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

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

  // Point Forecast state
  const [pointForecastData, setPointForecastData] = useState<any>(null);
  const [pointForecastLoading, setPointForecastLoading] = useState(false);
  const [showPointForecast, setShowPointForecast] = useState(false);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  // Tab state: 'map' or 'local'
  const [currentTab, setCurrentTab] = useState<'map' | 'local'>('map');

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

  const currentIndex = useMemo(() => {
    if (!selectedStep || timesteps.length === 0) return 0;
    return timesteps.findIndex(s => s.filenameTime === selectedStep.filenameTime);
  }, [selectedStep, timesteps]);

  const progressPercent = useMemo(() => {
    if (timesteps.length <= 1) return 0;
    return (currentIndex / (timesteps.length - 1)) * 100;
  }, [currentIndex, timesteps.length]);

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

      // Pre-load image into browser cache
      const img = new (window as any).Image();
      img.src = imageUrl;
    } catch (e) {
      console.warn('Pre-fetch failed', e);
    }
  }, [selectedChannel.id, prefetchedData]);

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

  const fetchPointForecast = async (lat: number, lon: number, channelId: string) => {
    try {
      setPointForecastLoading(true);
      const response = await fetch(
        `${SERVER_URL}/point?lat=${lat}&lon=${lon}&channel=${channelId}`
      );
      if (response.ok) {
        const data = await response.json();
        setPointForecastData(data);
        setShowPointForecast(true);
      } else {
        alert('No forecast data available for this location');
      }
    } catch (error) {
      console.error('Error fetching point forecast:', error);
      alert('Failed to fetch forecast data');
    } finally {
      setPointForecastLoading(false);
    }
  };

  const handleLocationPress = async () => {
    if (!userLocation) {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const { longitude, latitude } = position.coords;
            if (longitude >= REGION.west && longitude <= REGION.east &&
                latitude >= REGION.south && latitude <= REGION.north) {
              setUserLocation([longitude, latitude]);
              fetchPointForecast(latitude, longitude, selectedChannel.id);
            } else {
              alert('Your location is outside the forecast area (Europe)');
            }
          },
          (error) => {
            alert('Unable to get your location. Please enable location services.');
          },
          { enableHighAccuracy: false, timeout: 10000 }
        );
      } else {
        alert('Geolocation is not supported by your browser');
      }
    } else {
      setShowPointForecast(!showPointForecast);
    }
  };

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
    <View style={webStyles.page}>

      {/* Search Bar Row */}
      <View style={webStyles.searchContainer} data-search-container>
        <View style={webStyles.searchRow}>
          <TextInput
            style={webStyles.searchInput}
            placeholder="Search location..."
            placeholderTextColor="#888"
            value={searchQuery}
            onChangeText={handleSearchChange}
            onFocus={() => searchResults.length > 0 && setShowSearchResults(true)}
          />
          <TouchableOpacity
            style={webStyles.locationBtn}
            onPress={handleLocationPress}
          >
            <Text style={webStyles.locationBtnText}>
              {pointForecastLoading ? '...' : showPointForecast ? '✕' : '📍'}
            </Text>
          </TouchableOpacity>
        </View>

        {showSearchResults && searchResults.length > 0 && (
          <View style={webStyles.searchResults}>
            {searchResults.map((result, index) => (
              <TouchableOpacity
                key={index}
                style={webStyles.searchResultItem}
                onPress={() => selectLocation(result)}
              >
                <Text style={webStyles.searchResultText} numberOfLines={1}>
                  {result.display_name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Computation Time Badge - below search bar */}
        {timesteps.length > 0 && computedTimeString && (
          <View style={webStyles.computedTimeBadge}>
            <Text style={webStyles.computedTimeText}>
              Computed at {computedTimeString} UTC
            </Text>
          </View>
        )}
      </View>

      {/* Point Forecast Panel */}
      {showPointForecast && pointForecastData && currentTab === 'map' && (
        <View style={webStyles.pointForecastPanel}>
          <View style={webStyles.pointForecastHeader}>
            <Text style={webStyles.pointForecastTitle}>Lightning Forecast</Text>
            <Text style={webStyles.pointForecastSubtitle}>
              {pointForecastData.coordinates.lat.toFixed(4)}°N, {pointForecastData.coordinates.lon.toFixed(4)}°E
            </Text>
          </View>

          <ScrollView horizontal style={webStyles.pointForecastData} showsHorizontalScrollIndicator={true}>
            {pointForecastData.timesteps.map((step: any, index: number) => (
              <View key={index} style={webStyles.pointForecastColumn}>
                <Text style={webStyles.pointForecastTime}>
                  {step.timestamp ? `${step.timestamp.substring(8, 10)}:${step.timestamp.substring(10, 12)}` : 'N/A'}
                </Text>
                <View style={[webStyles.pointForecastValue, step.value !== null && step.value >= 1 && webStyles.pointForecastValueActive]}>
                  <Text style={[webStyles.pointForecastValueText, step.value !== null && step.value >= 1 && webStyles.pointForecastValueTextActive]}>
                    {step.value !== null ? step.value.toFixed(1) : '--'}
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={webStyles.pointForecastLegend}>
            <Text style={webStyles.pointForecastLegendText}>
              Values: 0-4 (higher = more lightning)
            </Text>
          </View>
        </View>
      )}

      {Platform.OS === 'web' ? (
        <div ref={mapRef} style={webStyles.map} />
      ) : (
        <View style={webStyles.map}>
           <Text style={{textAlign:'center', marginTop: 100}}>Map is Web-Only in this prototype</Text>
        </View>
      )}

      {/* Local View */}
      {currentTab === 'local' && (
        <View style={webStyles.localView}>
          <View style={webStyles.localHeader}>
            <Text style={webStyles.localTitle}>Local Forecast</Text>
            <Text style={webStyles.localSubtitle}>
              {userLocation ? `${userLocation[1].toFixed(4)}°N, ${userLocation[0].toFixed(4)}°E` : 'Location not set'}
            </Text>
          </View>

          {pointForecastLoading ? (
            <View style={webStyles.loadingContainer}>
              <Text style={webStyles.loadingText}>Loading forecast...</Text>
            </View>
          ) : pointForecastData ? (
            <View style={{ flex: 1 }}>
              <View style={webStyles.localLegend}>
                <Text style={webStyles.localLegendText}>Lightning Probability (0-4)</Text>
              </View>
              <ScrollView horizontal style={webStyles.localScrollView} contentContainerStyle={webStyles.localScrollContent}>
                {pointForecastData.timesteps.map((step: any, index: number) => (
                  <View key={index} style={webStyles.localColumn}>
                    <Text style={webStyles.localTime}>
                      {step.timestamp ? `${step.timestamp.substring(8, 10)}:${step.timestamp.substring(10, 12)}` : 'N/A'}
                    </Text>
                    <View style={[webStyles.localValue, step.value !== null && step.value >= 1 && webStyles.localValueActive]}>
                      <Text style={[webStyles.localValueText, step.value !== null && step.value >= 1 && webStyles.localValueTextActive]}>
                        {step.value !== null ? step.value.toFixed(1) : '--'}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : (
            <View style={webStyles.emptyState}>
              <Text style={webStyles.emptyStateText}>Press 📍 to get your local forecast</Text>
            </View>
          )}
        </View>
      )}

      {/* Loading overlay removed - smooth playback with existing layer */}

      {/* Controls - Only show on Map tab */}
      {currentTab === 'map' && (
      <View style={webStyles.controlsContainer}>
        {/* Channel Selector */}
        <View style={webStyles.controlsRow}>
            <TouchableOpacity 
              onPress={() => setIsPlaying(!isPlaying)}
              style={[webStyles.playBtn, isPlaying && webStyles.pauseBtn]}
            >
              <Text style={webStyles.playBtnText}>{isPlaying ? "⏸" : "▶"}</Text>
            </TouchableOpacity>

            <View style={webStyles.channelRow}>
              {CHANNELS.map((ch) => (
                <TouchableOpacity
                  key={ch.id}
                  onPress={() => setSelectedChannel(ch)}
                  style={[webStyles.channelBtn, selectedChannel.id === ch.id && webStyles.selectedBtn]}
                >
                  <Text style={[webStyles.btnText, selectedChannel.id === ch.id && webStyles.selectedBtnText]}>
                    {ch.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
        </View>

        {/* Timeline Slider */}
        <View style={webStyles.timelineContainer}>
          {isScanning ? (
            <Text style={webStyles.scanningText}>Scanning for available timesteps...</Text>
          ) : timesteps.length === 0 ? (
            <Text style={webStyles.errorText}>No timesteps available</Text>
          ) : (
            <>
              <View style={webStyles.timeLabels}>
                <Text style={webStyles.timeLabel}>{timesteps[0]?.label}</Text>
                <Text style={webStyles.currentTimeLabel}>{fullDateString}</Text>
                <Text style={webStyles.timeLabel}>{timesteps[timesteps.length - 1]?.label}</Text>
              </View>
              <input
                type="range"
                min={0}
                max={timesteps.length - 1}
                step={1}
                value={currentIndex}
                onChange={(e) => setSelectedStep(timesteps[parseInt(e.target.value)])}
                style={{
                  width: '100%',
                  height: 8,
                  borderRadius: 4,
                  background: `linear-gradient(to right, #007AFF 0%, #007AFF ${progressPercent}%, #444 ${progressPercent}%, #444 100%)`,
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
      )}

      {/* Bottom Tab Bar */}
      <View style={webStyles.tabBar}>
        <TouchableOpacity
          style={[webStyles.tabItem, currentTab === 'map' && webStyles.tabItemActive]}
          onPress={() => setCurrentTab('map')}
        >
          <View style={webStyles.tabIcon}>
            <MapIcon active={currentTab === 'map'} />
          </View>
          <Text style={[webStyles.tabLabel, currentTab === 'map' && webStyles.tabLabelActive]}>Map</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[webStyles.tabItem, currentTab === 'local' && webStyles.tabItemActive]}
          onPress={() => {
            setCurrentTab('local');
            if (!userLocation) {
              handleLocationPress();
            }
          }}
        >
          <View style={webStyles.tabIcon}>
            <LocationIcon active={currentTab === 'local'} />
          </View>
          <Text style={[webStyles.tabLabel, currentTab === 'local' && webStyles.tabLabelActive]}>Local</Text>
        </TouchableOpacity>
      </View>

      {/* Splash Screen */}
      {isSplashVisible && (
        <Animated.View 
          style={[
            webStyles.splashScreen, 
            { transform: [{ translateY: slideAnim }] }
          ]}
        >
          <Image
            source={require('./assets/icon.png')}
            style={webStyles.splashLogo}
            resizeMode="contain"
          />
          <Text style={webStyles.splashTitle}>by meteolibre</Text>
        </Animated.View>
      )}
    </View>
  );
}

// Styles are imported from ./styles/appWebStyles.ts
