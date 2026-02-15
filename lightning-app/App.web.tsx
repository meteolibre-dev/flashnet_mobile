import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Platform, View, Text, TouchableOpacity, TextInput, Animated, Dimensions, Easing, Image, ScrollView } from 'react-native';
import 'maplibre-gl/dist/maplibre-gl.css';
import { webStyles } from './styles';
import PlayButton from './components/PlayButton';
import ThunderLegend from './components/ThunderLegend';
import {
  scanAvailableTimesteps,
  Timestep,
  BANDS,
  SERVER_URL,
  REGION,
  getTileUrl,
  fetchPointForecast,
} from './dataService';

const CARTOLIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

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
  const [selectedBand, setSelectedBand] = useState(BANDS[0]);
  const mapRef = useRef<any>(null);
  const mapInstance = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(true);

  const [activeLayerIndex, setActiveLayerIndex] = useState(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const playInterval = useRef<NodeJS.Timeout | null>(null);
  const cachedTileUrls = useRef<Map<string, string>>(new Map());

  const [prefetchedData, setPrefetchedData] = useState<Record<string, any>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);

  const [pointForecastData, setPointForecastData] = useState<any>(null);
  const [pointForecastLoading, setPointForecastLoading] = useState(false);
  const [showPointForecast, setShowPointForecast] = useState(false);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  const [currentTab, setCurrentTab] = useState<'map' | 'local'>('map');

  const computedTime = useMemo(() => {
    if (timesteps.length === 0) return null;
    const firstStep = timesteps[0]?.fullDate;
    if (!firstStep) return null;
    return new Date(firstStep.getTime() - 10 * 60 * 1000);
  }, [timesteps]);

  const computedTimeString = useMemo(() => {
    if (!computedTime) return '';
    return computedTime.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
  }, [computedTime]);

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
    return timesteps.findIndex(s => s.timestamp === selectedStep.timestamp);
  }, [selectedStep, timesteps]);

  const progressPercent = useMemo(() => {
    if (timesteps.length <= 1) return 0;
    return (currentIndex / (timesteps.length - 1)) * 100;
  }, [currentIndex, timesteps.length]);

  const prefetchTimestep = useCallback(async (step: Timestep) => {
    if (!step) return;
  }, [selectedBand.id]);

  const slideAnim = useRef(new Animated.Value(0)).current;
  const [isSplashVisible, setIsSplashVisible] = useState(true);

  useEffect(() => {
    const link = document.createElement('link');
    link.href = "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);

    const timer = setTimeout(() => {
      Animated.timing(slideAnim, {
        toValue: -Dimensions.get('window').height,
        duration: 800,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        useNativeDriver: false,
      }).start(() => {
        setIsSplashVisible(false);
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

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
          [0, 1].forEach(idx => {
            map.addSource(`forecast-source-${idx}`, {
              type: 'raster',
              tiles: [''],
              tileSize: 256,
              attribution: 'FlashNet'
            });

            map.addLayer({
              id: `forecast-layer-${idx}`,
              type: 'raster',
              source: `forecast-source-${idx}`,
              paint: {
                'raster-opacity': 0,
                'raster-fade-duration': 0
              }
            });
          });

          updateMapLayer();

          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (position) => {
                const { longitude, latitude } = position.coords;

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
                console.log('Geolocation Error:', error.message);
              },
              { enableHighAccuracy: false, timeout: 10000 }
            );
          }
        });
      });
    }
  }, []);

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

  const prefetchTilesForBand = useCallback(async (bandId: string) => {
    if (timesteps.length === 0) return;

    setIsDownloading(true);
    setDownloadProgress(0);

    const map = mapInstance.current;
    let bounds: any = null;
    // Only prefetch at current zoom level (not all zoom levels)
    const zoom = map ? Math.round(map.getZoom()) : 5;

    if (map) {
      bounds = map.getBounds();
    } else {
      bounds = { _sw: { lng: REGION.west, lat: REGION.south }, _ne: { lng: REGION.east, lat: REGION.north } };
    }

    const n = Math.pow(2, zoom);
    const minTileX = Math.max(0, Math.floor((bounds._sw.lng + 180) / 360 * n));
    const maxTileX = Math.min(n - 1, Math.floor((bounds._ne.lng + 180) / 360 * n));
    const minTileY = Math.max(0, Math.floor((1 - Math.log(Math.tan(bounds._ne.lat * Math.PI / 180) + 1 / Math.cos(bounds._ne.lat * Math.PI / 180)) / Math.PI) / 2 * n));
    const maxTileY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(bounds._sw.lat * Math.PI / 180) + 1 / Math.cos(bounds._sw.lat * Math.PI / 180)) / Math.PI) / 2 * n));

    const visibleTileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
    console.log(`[Prefetch] Visible tiles at zoom ${zoom}: ${visibleTileCount}`);

    // Limit to max 6 tiles per timestep
    const maxTilesPerTimestep = 6;
    const totalSteps = timesteps.length;
    let completedSteps = 0;

    for (const step of timesteps) {
      const tileUrlTemplate = getTileUrl(step.timestamp, bandId);

      cachedTileUrls.current.set(step.timestamp, tileUrlTemplate);

      try {
        const warmupPromises: Promise<void>[] = [];

        // Only fetch at current zoom level, limit to maxTilesPerTimestep
        let tilesFetched = 0;
        for (let x = minTileX; x <= maxTileX && tilesFetched < maxTilesPerTimestep; x++) {
          for (let y = minTileY; y <= maxTileY && tilesFetched < maxTilesPerTimestep; y++) {
            const tileUrl = tileUrlTemplate.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
            warmupPromises.push(
              fetch(tileUrl).then(r => r.blob()).then(() => {}).catch(() => {})
            );
            tilesFetched++;
          }
        }

        const batchSize = 10;
        for (let i = 0; i < warmupPromises.length; i += batchSize) {
          await Promise.all(warmupPromises.slice(i, i + batchSize));
        }
      } catch (error) {
        console.log('Cache warmup error:', error);
      }

      completedSteps++;
      setDownloadProgress(completedSteps / totalSteps);
    }

    setIsDownloading(false);
  }, [timesteps]);

  const handlePlayPress = useCallback(async () => {
    if (isPlaying) {
      if (playInterval.current) {
        clearInterval(playInterval.current);
        playInterval.current = null;
      }
      setIsPlaying(false);
      cachedTileUrls.current.clear();
      setPrefetchedData({});
      setDownloadProgress(0);
      return;
    }

    const hasCache = cachedTileUrls.current.has(timesteps[0]?.timestamp);

    if (!hasCache) {
      await prefetchTilesForBand(selectedBand.id);
    }

    setIsPlaying(true);
    let idx = timesteps.findIndex(s => s.timestamp === selectedStep?.timestamp);
    if (idx === -1) idx = 0;

    playInterval.current = setInterval(() => {
      idx = (idx + 1) % timesteps.length;
      setSelectedStep(timesteps[idx]);
    }, 1000);

  }, [isPlaying, selectedBand.id, timesteps, selectedStep, prefetchTilesForBand]);

  useEffect(() => {
    if (isPlaying) {
      if (playInterval.current) {
        clearInterval(playInterval.current);
        playInterval.current = null;
      }
      setIsPlaying(false);
      setDownloadProgress(0);
      cachedTileUrls.current.clear();
      setPrefetchedData({});
    }
  }, [selectedBand.id]);

  useEffect(() => {
    return () => {
      if (playInterval.current) {
        clearInterval(playInterval.current);
      }
    };
  }, []);

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

  const handleFetchPointForecast = async (lat: number, lon: number, bandId: string) => {
    try {
      setPointForecastLoading(true);
      const data = await fetchPointForecast(lat, lon, bandId);
      if (data) {
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
              handleFetchPointForecast(latitude, longitude, selectedBand.id);
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

  useEffect(() => {
    if (userLocation && (showPointForecast || currentTab === 'local')) {
      handleFetchPointForecast(userLocation[1], userLocation[0], selectedBand.id);
    }
  }, [selectedBand.id, userLocation, showPointForecast, currentTab]);

  useEffect(() => {
    if (!isPlaying || !selectedStep || timesteps.length === 0) return;

    const idx = timesteps.findIndex(s => s.timestamp === selectedStep.timestamp);

    const nextSteps = [
        timesteps[(idx + 1) % timesteps.length],
        timesteps[(idx + 2) % timesteps.length],
        timesteps[(idx + 3) % timesteps.length],
    ].filter(Boolean);

    Promise.all(nextSteps.map(step => prefetchTimestep(step)));

    if (Object.keys(prefetchedData).length > 30) {
        setPrefetchedData(prev => {
            const keys = Object.keys(prev);
            const newCache = { ...prev };
            keys.slice(0, keys.length - 15).forEach(k => delete newCache[k]);
            return newCache;
        });
    }

  }, [isPlaying, selectedStep, selectedBand, timesteps, prefetchTimestep, prefetchedData]);

  useEffect(() => {
    if (mapInstance.current && mapInstance.current.isStyleLoaded() && selectedStep) {
      updateMapLayer();
    }
  }, [selectedStep, selectedBand, activeLayerIndex]);

  const updateMapLayer = async () => {
    if (!mapInstance.current || !selectedStep) return;
    const map = mapInstance.current;
    if (!map.isStyleLoaded()) return;

    const nextIndex = activeLayerIndex === 0 ? 1 : 0;
    const currentLayerId = `forecast-layer-${nextIndex}`;
    const currentSourceId = `forecast-source-${nextIndex}`;
    const oldLayerId = `forecast-layer-${activeLayerIndex}`;

    setIsLoading(true);
    try {
      const tileUrlTemplate = getTileUrl(selectedStep.timestamp, selectedBand.id);

      const source: any = map.getSource(currentSourceId);
      if (source) {
        source.setTiles([tileUrlTemplate]);

        const onSourceData = (e: any) => {
          if (e.sourceId === currentSourceId && e.isSourceLoaded) {
            map.off('sourcedata', onSourceData);

            map.setPaintProperty(oldLayerId, 'raster-opacity', 0);
            map.setPaintProperty(currentLayerId, 'raster-opacity', 0.8);
            setActiveLayerIndex(nextIndex);
            setIsLoading(false);
          }
        };

        const timeout = setTimeout(() => {
          map.off('sourcedata', onSourceData);
          map.setPaintProperty(oldLayerId, 'raster-opacity', 0);
          map.setPaintProperty(currentLayerId, 'raster-opacity', 0.8);
          setActiveLayerIndex(nextIndex);
          setIsLoading(false);
        }, 3000);

        map.on('sourcedata', onSourceData);

        return () => {
          clearTimeout(timeout);
          map.off('sourcedata', onSourceData);
        };
      }
    } catch (error) {
      console.error('Error updating layer:', error);
      setIsLoading(false);
    }
  };

  return (
    <View style={webStyles.page}>

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

        {currentTab === 'map' && timesteps.length > 0 && computedTimeString && (
          <View style={webStyles.computedTimeBadge}>
            <Text style={webStyles.computedTimeText}>
              Computed at {computedTimeString} UTC
            </Text>
          </View>
        )}
      </View>

      {showPointForecast && pointForecastData && currentTab === 'map' && (
        <View style={webStyles.pointForecastPanel}>
          <View style={webStyles.pointForecastHeader}>
            <Text style={webStyles.pointForecastTitle}>{selectedBand.label} Forecast</Text>
            <Text style={webStyles.pointForecastSubtitle}>
              {pointForecastData.coordinates?.lat?.toFixed(4) || 'N/A'}°N, {pointForecastData.coordinates?.lon?.toFixed(4) || 'N/A'}°E
            </Text>
          </View>

          <ScrollView horizontal style={webStyles.pointForecastData} showsHorizontalScrollIndicator={true}>
            {pointForecastData.timesteps?.slice(-18).reverse().map((step: any, index: number) => (
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
        </View>
      )}

      {Platform.OS === 'web' ? (
        <View style={webStyles.mapContainer}>
          <div ref={mapRef} style={webStyles.map} />
        </View>
      ) : (
        <View style={webStyles.mapContainer}>
          <View style={webStyles.map}>
            <Text style={{textAlign:'center', marginTop: 100}}>Map is Web-Only in this prototype</Text>
          </View>
        </View>
      )}

      {currentTab === 'local' && (
        <View style={webStyles.localView}>
          <View style={webStyles.localHeader}>
            <Text style={webStyles.localTitle}>{selectedBand.label} Local Forecast</Text>
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
                {selectedBand.id === 'lightning' ? (
                  <ThunderLegend size={16} />
                ) : (
                  <Text style={webStyles.localLegendText}>{selectedBand.label} Probability (0-4)</Text>
                )}
              </View>
              <ScrollView horizontal style={webStyles.localScrollView} contentContainerStyle={webStyles.localScrollContent}>
                {pointForecastData.timesteps?.slice(-18).reverse().map((step: any, index: number) => (
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

      {currentTab === 'map' && (
      <View style={webStyles.controlsContainer}>
        <View style={webStyles.controlsRow}>
            <View style={webStyles.channelRow}>
              {BANDS.map((band) => (
                <TouchableOpacity
                  key={band.id}
                  onPress={() => setSelectedBand(band)}
                  style={[webStyles.channelBtn, selectedBand.id === band.id && webStyles.selectedBtn]}
                >
                  <Text style={[webStyles.btnText, selectedBand.id === band.id && webStyles.selectedBtnText]}>
                    {band.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
        </View>

        <View style={webStyles.playButtonRow}>
          <PlayButton
            isPlaying={isPlaying}
            isDownloading={isDownloading}
            progress={downloadProgress}
            onPress={handlePlayPress}
            size={50}
          />
        </View>

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