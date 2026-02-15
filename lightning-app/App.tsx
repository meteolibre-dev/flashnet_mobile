import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, Platform, StatusBar, TextInput, Image, ScrollView, StyleSheet } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import Svg, { Circle, Path, Polygon, Line } from 'react-native-svg';
import RainbowSlider from './components/RainbowSlider';
import PlayButton from './components/PlayButton';
import * as SplashScreen from 'expo-splash-screen';
import * as Location from 'expo-location';
import * as Font from 'expo-font';
import {
  scanAvailableTimesteps,
  Timestep,
  BANDS,
  SERVER_URL,
  REGION,
  getTileUrl,
  getAnimationUrl,
  fetchPointForecast as fetchPointForecastFromService
} from './dataService';
import { styles } from './styles';

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

// Tile calculation utilities
const latLngToTile = (lat: number, lng: number, zoom: number) => {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
};

const getTileBounds = (zoom: number) => {
  const n = Math.pow(2, zoom);
  return {
    minX: 0, maxX: n - 1,
    minY: 0, maxY: n - 1
  };
};

// --- Icons ---
const MapIcon = ({ active }: { active: boolean }) => (
  <Svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <Polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <Line x1="8" y1="2" x2="8" y2="18" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <Line x1="16" y1="6" x2="16" y2="22" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const LocationIcon = ({ active }: { active: boolean }) => (
  <Svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <Circle cx="12" cy="10" r="3" stroke={active ? "#fff" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export default function App() {
  const [timesteps, setTimesteps] = useState<Timestep[]>([]);
  const [selectedStep, setSelectedStep] = useState<Timestep | null>(null);
  const [selectedBand, setSelectedBand] = useState(BANDS[0]);
  const [isScanning, setIsScanning] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [isLoading, setIsLoading] = useState(false); // internal, not shown in UI
  const [isAppReady, setIsAppReady] = useState(false);
  const [isLocalTime, setIsLocalTime] = useState(true);

  // Double buffering for smooth playback
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const activeLayerIndexRef = useRef(0);
  const [bufferUrls, setBufferUrls] = useState<[string | null, string | null]>([null, null]);
  const lastProcessedUrl = useRef<string | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    activeLayerIndexRef.current = activeLayerIndex;
  }, [activeLayerIndex]);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const playInterval = useRef<NodeJS.Timeout | null>(null);
  const cachedTileUrls = useRef<Map<string, string>>(new Map());
  const pendingFrame = useRef<boolean>(false); // Track if a frame is waiting to be displayed
  const currentLoadedTimestamp = useRef<number | null>(null); // Track the timestamp of the currently loaded frame

  // Animation overlay state
  const [animationUrl, setAnimationUrl] = useState<string | null>(null);

  // Load custom font for splash screen
  useEffect(() => {
    Font.loadAsync({
      'Orbitron': require('./assets/Orbitron-Regular.ttf'),
    }).catch(e => {
      console.warn('Font loading failed:', e);
    });
  }, []);

  const cameraRef = useRef<any>(null);
  const mapRef = useRef<any>(null);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [mapBounds, setMapBounds] = useState<{ ne: [number, number], sw: [number, number] } | null>(null);
  const [mapZoom, setMapZoom] = useState(4);

  // Region boundary GeoJSON
  const regionGeoJSON = useMemo(() => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[
        [REGION.west, REGION.south],
        [REGION.east, REGION.south],
        [REGION.east, REGION.north],
        [REGION.west, REGION.north],
        [REGION.west, REGION.south],
      ]],
    },
    properties: {},
  }), []);

  // User location GeoJSON
  const userLocationGeoJSON = useMemo(() => {
    if (!userLocation) return null;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: userLocation,
      },
      properties: {},
    };
  }, [userLocation]);

  // Tab state: 'map' or 'local'
  const [currentTab, setCurrentTab] = useState<'map' | 'local'>('map');

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
  const formatTime = useCallback((date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: isLocalTime ? undefined : 'UTC'
    });
  }, [isLocalTime]);

  const computedTimeString = useMemo(() => formatTime(computedTime), [computedTime, formatTime]);

  // Full date string for display (just time)
  const fullDateString = useMemo(() => formatTime(selectedStep?.fullDate || null), [selectedStep, formatTime]);

  // Just the day/month
  const selectedDateString = useMemo(() => {
    if (!selectedStep?.fullDate) return '';
    return selectedStep.fullDate.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      timeZone: isLocalTime ? undefined : 'UTC'
    });
  }, [selectedStep, isLocalTime]);

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

  // Refresh point forecast when band changes
  useEffect(() => {
    if (userLocation && (showPointForecast || currentTab === 'local')) {
      fetchPointForecast(userLocation[1], userLocation[0], selectedBand.id);
    }
  }, [selectedBand.id, userLocation, showPointForecast, currentTab]);

  // Playback Logic
  useEffect(() => {
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, []);

  // Prefetch tiles - optimized to only fetch visible tiles at current zoom level
  const prefetchTilesForBand = useCallback(async (bandId: string, zoom: number, bounds: { ne: [number, number], sw: [number, number] } | null) => {
    if (timesteps.length === 0) return;

    setIsDownloading(true);
    setDownloadProgress(0);

    let visibleTiles: { x: number, y: number }[] = [];

    // Calculate visible tiles from current map bounds
    if (bounds) {
      const { ne, sw } = bounds;
      const topLeft = latLngToTile(ne[1], sw[0], zoom);
      const bottomRight = latLngToTile(sw[1], ne[0], zoom);

      // Generate all visible tile coordinates
      for (let x = topLeft.x; x <= bottomRight.x; x++) {
        for (let y = topLeft.y; y <= bottomRight.y; y++) {
          visibleTiles.push({ x, y });
        }
      }

      console.log(`[Prefetch] Viewport: zoom=${zoom}, tiles in view: ${visibleTiles.length}, bounds: NE(${ne[0].toFixed(2)},${ne[1].toFixed(2)}) SW(${sw[0].toFixed(2)},${sw[1].toFixed(2)})`);

      // Limit tiles to reasonable number (covers most viewports without long download)
      const maxTilesPerTimestep = 16;
      if (visibleTiles.length > maxTilesPerTimestep) {
        const centerX = Math.floor((topLeft.x + bottomRight.x) / 2);
        const centerY = Math.floor((topLeft.y + bottomRight.y) / 2);

        visibleTiles.sort((a, b) => {
          const distA = Math.abs(a.x - centerX) + Math.abs(a.y - centerY);
          const distB = Math.abs(b.x - centerX) + Math.abs(b.y - centerY);
          return distA - distB;
        });

        visibleTiles = visibleTiles.slice(0, maxTilesPerTimestep);
      }
    } else {
      // Fallback: fetch a small region at zoom level 4 (Europe center)
      const center = latLngToTile(50, 10, zoom);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          visibleTiles.push({ x: center.x + dx, y: center.y + dy });
        }
      }
    }

    console.log(`[Prefetch] Fetching ${visibleTiles.length} tiles at zoom ${zoom}`);

    const totalSteps = timesteps.length;
    const BATCH_SIZE = 4; // Download 4 timesteps in parallel

    // Download tiles in parallel batches
    for (let i = 0; i < timesteps.length; i += BATCH_SIZE) {
      const batch = timesteps.slice(i, i + BATCH_SIZE);
      
      const batchPromises = batch.map(step => {
        const tileUrlTemplate = getTileUrl(step.timestamp, bandId);
        cachedTileUrls.current.set(step.timestamp, tileUrlTemplate);

        return visibleTiles.map(({ x, y }: { x: number, y: number }) => {
          const tileUrl = tileUrlTemplate
            .replace('{z}', String(zoom))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
          return fetch(tileUrl).catch(() => {});
        });
      });

      // Flatten and run all in parallel
      const allPromises = batchPromises.flat();
      await Promise.all(allPromises);

      setDownloadProgress(Math.min((i + BATCH_SIZE) / totalSteps, 1));
    }

    setIsDownloading(false);
  }, [timesteps]);

  // Handle play button press
  const handlePlayPress = useCallback(async () => {
    if (isPlaying) {
      // Stop playback - clear state
      if (playInterval.current) {
        clearInterval(playInterval.current);
        playInterval.current = null;
      }
      setIsPlaying(false);
      pendingFrame.current = false;
      // Clear cache when stopping - only show current frame
      cachedTileUrls.current.clear();
      setDownloadProgress(0);
      setAnimationUrl(null);
      return;
    }

    // Capture current map bounds and zoom before prefetching
    let currentBounds = mapBounds;
    let currentZoom = mapZoom;
    if (mapRef.current) {
      try {
        const bounds = await mapRef.current?.getVisibleBounds();
        if (bounds && bounds.length === 2) {
          currentBounds = {
            ne: [bounds[0][0], bounds[0][1]],
            sw: [bounds[1][0], bounds[1][1]]
          };
        }
        const zoom = await mapRef.current?.getZoom();
        if (zoom !== undefined) {
          // Use minimum zoom 6 to avoid downloading too many tiles when zoomed out
          currentZoom = Math.max(Math.round(zoom), 6);
        }
      } catch (e) {
        console.log('Could not get map bounds:', e);
      }
    }

    // Calculate visible tile range
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    if (currentBounds) {
      const { ne, sw } = currentBounds;
      const topLeft = latLngToTile(ne[1], sw[0], currentZoom);
      const bottomRight = latLngToTile(sw[1], ne[0], currentZoom);
      minX = topLeft.x;
      maxX = bottomRight.x;
      minY = topLeft.y;
      maxY = bottomRight.y;
    } else {
      // Fallback: Europe center
      const center = latLngToTile(50, 10, currentZoom);
      minX = center.x - 2;
      maxX = center.x + 2;
      minY = center.y - 2;
      maxY = center.y + 2;
    }

    const tileCount = (maxX - minX + 1) * (maxY - minY + 1);
    console.log(`[Play] Viewport: ${tileCount} tiles at zoom ${currentZoom}`);

    // Use animation mode if viewport is reasonable (16 tiles or fewer)
    if (tileCount <= 16 && timesteps.length > 0) {
      const startTime = timesteps[0]?.timestamp;
      const endTime = timesteps[timesteps.length - 1]?.timestamp;

      if (startTime && endTime) {
        console.log(`[Play] Using animated WebP mode: ${startTime} to ${endTime}`);
        const animUrl = getAnimationUrl(
          minX, maxX, minY, maxY,
          currentZoom,
          selectedBand.id,
          startTime,
          endTime,
          10
        );
        setAnimationUrl(animUrl);
        setIsPlaying(true);
        return;
      }
    }

    // Fall back to tile prefetch mode for larger viewports
    // Clear cache before starting new download
    cachedTileUrls.current.clear();

    console.log(`[Play] Starting tile prefetch with zoom=${currentZoom}, bounds=${currentBounds ? `NE(${currentBounds.ne[0].toFixed(2)},${currentBounds.ne[1].toFixed(2)}) SW(${currentBounds.sw[0].toFixed(2)},${currentBounds.sw[1].toFixed(2)})` : 'null'}`);

    // Check if we need to download
    const hasCache = cachedTileUrls.current.has(timesteps[0]?.timestamp);

    if (!hasCache) {
      // Download tiles first
      await prefetchTilesForBand(selectedBand.id, currentZoom, currentBounds);
    }

    // Start playback
    setIsPlaying(true);
    let currentIndex = timesteps.findIndex(s => s.timestamp === selectedStep?.timestamp);
    if (currentIndex === -1) currentIndex = 0;
    pendingFrame.current = false; // Reset pending state

    playInterval.current = setInterval(() => {
      // Skip this tick if previous frame is still loading
      if (pendingFrame.current) {
        return;
      }
      currentIndex = (currentIndex + 1) % timesteps.length;
      pendingFrame.current = true; // Mark that we're waiting for this frame
      setSelectedStep(timesteps[currentIndex]);
    }, 1000);

  }, [isPlaying, selectedBand.id, timesteps, selectedStep, prefetchTilesForBand]);

  // Stop playback when band changes
  useEffect(() => {
    if (isPlaying) {
      if (playInterval.current) {
        clearInterval(playInterval.current);
        playInterval.current = null;
      }
      setIsPlaying(false);
      pendingFrame.current = false;
      setDownloadProgress(0);
      cachedTileUrls.current.clear();
    }
  }, [selectedBand.id]);

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
          await fetchPointForecast(latitude, longitude, selectedBand.id);
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
        await fetchPointForecast(userLocation[1], userLocation[0], selectedBand.id);
      }
    }
  };

  // Tiling Update Logic - No longer manual coordinate fetching needed
  // Tiles are fetched automatically by MapLibre from the tile server
  const tileUrl = useMemo(() => {
    if (!selectedStep) return null;
    const url = getTileUrl(selectedStep.timestamp, selectedBand.id);
    console.log('[TileDebug] Generated Tile URL Template:', url);
    return url;
  }, [selectedStep, selectedBand]);

  // Update buffers for native double-buffering
  useEffect(() => {
    if (tileUrl && tileUrl !== lastProcessedUrl.current) {
      lastProcessedUrl.current = tileUrl;
      const frameTimestamp = Date.now();
      currentLoadedTimestamp.current = frameTimestamp;
      
      // Update the buffer with new tile URL but don't switch active layer yet
      // This prevents showing partial tiles
      const nextIndex = activeLayerIndexRef.current === 0 ? 1 : 0;
      setBufferUrls(prev => {
        const next = [...prev] as [string | null, string | null];
        next[nextIndex] = tileUrl;
        return next;
      });
      
      // Wait for tiles to load before switching to the new layer
      // This ensures the full image appears at once instead of tiles loading progressively
      const loadDelay = isPlaying ? 800 : 1500;
      setTimeout(() => {
        // Only switch if this is still the current frame (not superseded by another)
        if (currentLoadedTimestamp.current === frameTimestamp) {
          setActiveLayerIndex(nextIndex);
          pendingFrame.current = false;
        }
      }, loadDelay);
    }
  }, [tileUrl, isPlaying]);

  return (
    <View style={styles.page}>
      {/* Custom Splash Screen */}
      {!isAppReady && (
        <View style={styles.splashContainer}>
          <Image
            source={require('./assets/mainimage_highres.png')}
            style={styles.splashImage}
          />
        </View>
      )}

      <StatusBar barStyle="light-content" />

      {/* Search Bar Row */}
      <View style={styles.searchContainer}>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search location..."
            placeholderTextColor="#888"
            value={searchQuery}
            onChangeText={handleSearchChange}
            onFocus={() => searchResults.length > 0 && setShowSearchResults(true)}
          />
          <TouchableOpacity
            style={styles.locationBtn}
            onPress={handleLocationPress}
          >
            <Text style={styles.locationBtnText}>
              {pointForecastLoading ? '...' : showPointForecast ? '✕' : '📍'}
            </Text>
          </TouchableOpacity>
        </View>

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
        {currentTab === 'map' && timesteps.length > 0 && computedTimeString && (
          <View style={styles.computedTimeBadge}>
            <Text style={styles.computedTimeText}>
              Computed at {computedTimeString}
            </Text>
            <TouchableOpacity
              style={styles.timezoneToggle}
              onPress={() => setIsLocalTime(!isLocalTime)}
            >
              <Text style={styles.timezoneToggleText}>
                {isLocalTime ? 'Local' : 'UTC'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Point Forecast Panel */}
      {showPointForecast && pointForecastData && currentTab === 'map' && (
        <View style={styles.pointForecastPanel}>
          <View style={styles.pointForecastHeader}>
            <Text style={styles.pointForecastTitle}>{selectedBand.label} Forecast</Text>
            <Text style={styles.pointForecastSubtitle}>
              {pointForecastData.coordinates.lat.toFixed(4)}°N, {pointForecastData.coordinates.lon.toFixed(4)}°E
            </Text>
          </View>

          <ScrollView horizontal style={styles.pointForecastData} showsHorizontalScrollIndicator={true}>
            {pointForecastData.timesteps.slice(-18).reverse().map((step: any, index: number) => {
              const date = step.timestamp ? new Date(
                parseInt(step.timestamp.substring(0, 4)),
                parseInt(step.timestamp.substring(4, 6)) - 1,
                parseInt(step.timestamp.substring(6, 8)),
                parseInt(step.timestamp.substring(8, 10)),
                parseInt(step.timestamp.substring(10, 12))
              ) : null;
              const displayTime = date ? date.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: isLocalTime ? undefined : 'UTC'
              }) : 'N/A';

              return (
                <View key={index} style={styles.pointForecastColumn}>
                  <Text style={styles.pointForecastTime}>
                    {displayTime}
                  </Text>
                  <View style={[styles.pointForecastValue, step.value !== null && step.value >= 1 && styles.pointForecastValueActive]}>
                    <Text style={[styles.pointForecastValueText, step.value !== null && step.value >= 1 && styles.pointForecastValueTextActive]}>
                      {step.value !== null ? step.value.toFixed(1) : '--'}
                    </Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.pointForecastLegend}>
            <Text style={styles.pointForecastLegendText}>
              Values: 0-4 (higher = more lightning)
            </Text>
          </View>
        </View>
      )}

      {/* Map View */}
      {currentTab === 'map' && (
        <>
          <MapLibreGL.MapView
            ref={mapRef}
            style={styles.map}
            mapStyle={CARTOLIGHT_STYLE}
            logoEnabled={false}
            attributionEnabled={true}
            onRegionIsChanging={async (evt: any) => {
              try {
                const bounds = await mapRef.current?.getVisibleBounds();
                if (bounds && bounds.length === 2) {
                  setMapBounds({
                    ne: [bounds[0][0], bounds[0][1]],
                    sw: [bounds[1][0], bounds[1][1]]
                  });
                }
                const props = evt.nativeEvent?.properties;
                if (props?.zoom) {
                  setMapZoom(Math.round(props.zoom));
                }
              } catch (e) {}
            }}
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

            {userLocationGeoJSON && (
              <MapLibreGL.ShapeSource id="userLocationSource" shape={userLocationGeoJSON}>
                <MapLibreGL.CircleLayer
                  id="userLocationCircle"
                  style={{
                    circleRadius: 6,
                    circleColor: '#2dd4bf', // cyan/teal to match themed elements
                    circleStrokeWidth: 2,
                    circleStrokeColor: '#ffffff',
                  }}
                />
              </MapLibreGL.ShapeSource>
            )}

            <MapLibreGL.ShapeSource id="regionSource" shape={regionGeoJSON}>
              <MapLibreGL.LineLayer
                id="regionBoundary"
                style={{
                  lineColor: '#000000',
                  lineWidth: 2,
                  lineDasharray: [4, 4],
                }}
              />
            </MapLibreGL.ShapeSource>

            {/* Overlay Layers - Double Buffering for Smooth Playback */}
            {[0, 1].map((idx) => {
              const isActive = activeLayerIndex === idx;
              const url = bufferUrls[idx];
              if (!url) return null;

              return (
                <MapLibreGL.RasterSource
                  key={`forecast-source-${idx}-${selectedBand.id}-${url.slice(-50)}`}
                  id={`forecast-source-${idx}`}
                  tileUrlTemplates={[url]}
                  tileSize={256}
                >
                  <MapLibreGL.RasterLayer
                    id={`forecast-layer-${idx}`}
                    style={{
                      rasterOpacity: isActive ? 0.8 : 0,
                      rasterFadeDuration: 0, // No fade - instant switch when active
                    }}
                  />
                </MapLibreGL.RasterSource>
              );
            })}
          </MapLibreGL.MapView>

          {/* Animated WebP Overlay - Full screen on top of map */}
          {animationUrl && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <Image
                source={{ uri: animationUrl }}
                style={{ width: '100%', height: '100%', resizeMode: 'cover' }}
              />
            </View>
          )}
        </>
      )}

      {/* Local View */}
      {currentTab === 'local' && (
        <View style={styles.localView}>
          <View style={styles.localHeader}>
            <Text style={styles.localTitle}>{selectedBand.label} Local Forecast</Text>
            <Text style={styles.localSubtitle}>
              {userLocation ? `${userLocation[1].toFixed(4)}°N, ${userLocation[0].toFixed(4)}°E` : 'Location not set'}
            </Text>
          </View>

          {pointForecastLoading ? (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>Loading forecast...</Text>
            </View>
          ) : pointForecastData ? (
            <View style={{ flex: 1 }}>
              <View style={styles.localLegend}>
                <Text style={styles.localLegendText}>Lightning Probability (0-4)</Text>
              </View>
              <ScrollView horizontal style={styles.localScrollView} contentContainerStyle={styles.localScrollContent}>
                {pointForecastData.timesteps.slice(-18).reverse().map((step: any, index: number) => {
                  const date = step.timestamp ? new Date(
                    parseInt(step.timestamp.substring(0, 4)),
                    parseInt(step.timestamp.substring(4, 6)) - 1,
                    parseInt(step.timestamp.substring(6, 8)),
                    parseInt(step.timestamp.substring(8, 10)),
                    parseInt(step.timestamp.substring(10, 12))
                  ) : null;
                  const displayTime = date ? date.toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: isLocalTime ? undefined : 'UTC'
                  }) : 'N/A';

                  return (
                    <View key={index} style={styles.localColumn}>
                      <Text style={styles.localTime}>
                        {displayTime}
                      </Text>
                      <View style={[styles.localValue, step.value !== null && step.value >= 1 && styles.localValueActive]}>
                        <Text style={[styles.localValueText, step.value !== null && step.value >= 1 && styles.localValueTextActive]}>
                          {step.value !== null ? step.value.toFixed(1) : '--'}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>Press 📍 to get your local forecast</Text>
            </View>
          )}
        </View>
      )}

      {/* Remove loading overlay during playback - double buffering prevents blanks */}

      {/* Controls - Only show on Map tab */}
      {currentTab === 'map' && (
      <View style={styles.controlsContainer}>
        {/* Channel Selection + Play Button Row */}
        <View style={styles.controlsRow}>
          <PlayButton
            isPlaying={isPlaying}
            isDownloading={isDownloading}
            progress={downloadProgress}
            onPress={handlePlayPress}
            size={40}
          />
          <View style={styles.channelRow}>
            {BANDS.map((band) => (
              <TouchableOpacity
                key={band.id}
                onPress={() => setSelectedBand(band)}
                style={[styles.channelBtn, selectedBand.id === band.id && styles.selectedBtn]}
              >
                <Text style={[styles.btnText, selectedBand.id === band.id && styles.selectedBtnText]}>
                  {band.label}
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
              <Text style={styles.dateLabel}>{selectedDateString}</Text>
              <View style={styles.timeLabels}>
                <Text style={styles.timeLabel}>{formatTime(timesteps[0]?.fullDate || null)}</Text>
                <Text style={styles.currentTimeLabel}>{fullDateString}</Text>
                <Text style={styles.timeLabel}>{formatTime(timesteps[timesteps.length - 1]?.fullDate || null)}</Text>
              </View>
              <RainbowSlider
                data={timesteps}
                value={timesteps.findIndex(s => s.timestamp === selectedStep?.timestamp)}
                onChange={(index) => setSelectedStep(timesteps[Math.round(index)])}
                forecastValues={pointForecastData?.timesteps.slice(-18).reverse().map((s: any) => s.value)}
              />
            </>
          )}
        </View>
      </View>
      )}

      {/* Bottom Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, currentTab === 'map' && styles.tabItemActive]}
          onPress={() => setCurrentTab('map')}
        >
          <MapIcon active={currentTab === 'map'} />
          <Text style={[styles.tabLabel, currentTab === 'map' && styles.tabLabelActive]}>Map</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, currentTab === 'local' && styles.tabItemActive]}
          onPress={() => {
            setCurrentTab('local');
            if (!userLocation) {
              handleLocationPress();
            }
          }}
        >
          <LocationIcon active={currentTab === 'local'} />
          <Text style={[styles.tabLabel, currentTab === 'local' && styles.tabLabelActive]}>Local</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Styles are imported from ./styles/appStyles.ts
// - sharedStyles: shared styles used by both native and web
// - nativeStyles: native-specific styles (splash screen)
