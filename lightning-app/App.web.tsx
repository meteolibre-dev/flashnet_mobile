import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Platform, StyleSheet, View, Text, TouchableOpacity, ScrollView, Image, TextInput, Animated, Dimensions, Easing } from 'react-native';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as GeoTIFF from 'geotiff';

// --- Configuration ---
const REGION = {
  west: -10.0,
  north: 65.0,
  east: 33.0,
  south: 33.0,
};

const LATEST_DATE_STR = "202601160050"; // YYYYMMDDHHmm
const TIMESTEP_COUNT = 18;
const INTERVAL_MINUTES = 10;

const CHANNELS = [
  { id: 'lightning', label: 'Lightning' },
  { id: 'sat_ch0', label: 'VIS (Ch0)' },
  { id: 'sat_ch1', label: 'IR (Ch1)' },
];

const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";

interface Timestep {
  dateFolder: string;
  filenameTime: string;
  label: string;
  fullDate: Date;
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
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Initialize Map (Web Only)
  useEffect(() => {
    if (Platform.OS === 'web' && mapRef.current) {
      import('maplibre-gl').then(({ Map, NavigationControl }) => {
        const map = new Map({
          container: mapRef.current,
          style: {
            version: 8,
            sources: {
              'osm': {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
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
          },
          center: [(REGION.west + REGION.east) / 2, (REGION.north + REGION.south) / 2],
          zoom: 3
        });

        mapInstance.current = map;
        map.addControl(new NavigationControl());

        map.on('load', () => {
          updateMapLayer();
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
          setSelectedStep(available[available.length - 1]);
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
    if (mapInstance.current) {
      mapInstance.current.flyTo({ center: [lon, lat], zoom: 7 });
    }
    setSearchQuery(result.display_name.split(',')[0]);
    setShowSearchResults(false);
  };

  // Update layer when selection changes
  useEffect(() => {
    if (mapInstance.current && mapInstance.current.isStyleLoaded() && selectedStep) {
      updateMapLayer();
    }
  }, [selectedStep, selectedChannel]);

  const updateMapLayer = async () => {
    if (!mapInstance.current || !selectedStep) return;
    const map = mapInstance.current;
    
    setIsLoading(true);
    try {
      const url = `${BASE_BUCKET_URL}/${selectedStep.dateFolder}/forecast_${selectedStep.filenameTime}_${selectedChannel.id}.tiff`;
      console.log('Fetching:', url);

      // Fetch and process TIFF
      // We need to get dimensions to calculate true bounds based on resolution
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch TIFF: ${response.statusText}`);
      
      const arrayBuffer = await response.arrayBuffer();
      const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
      const image = await tiff.getImage();
      // Get geo-information directly from the TIFF file
      const bbox = image.getBoundingBox();
      const [minX, minY, maxX, maxY] = bbox;

      const dataUrl = await processTiffData(image, selectedChannel.id);

      // MapLibre image source expects coordinates in order: [top-left, top-right, bottom-right, bottom-left]
      // For a standard north-up GeoTIFF:
      // - Canvas pixel (0,0) = top-left of image = northwest corner = [minX, maxY]
      // - Canvas pixel (width,0) = top-right = northeast = [maxX, maxY]
      // - Canvas pixel (width,height) = bottom-right = southeast = [maxX, minY]
      // - Canvas pixel (0,height) = bottom-left = southwest = [minX, minY]
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
        [minX, maxY], // TL (northwest)
        [maxX, maxY], // TR (northeast)
        [maxX, minY], // BR (southeast)
        [minX, minY]  // BL (southwest)
      ];
       
      const sourceId = 'forecast-source';
      const layerId = 'forecast-layer';

      const source = map.getSource(sourceId);
      const opacity = selectedChannel.id.startsWith('sat_') ? 0.8 : 0.8;
      if (source) {
        source.updateImage({ url: dataUrl, coordinates });
        map.setPaintProperty(layerId, 'raster-opacity', opacity);
      } else {
        map.addSource(sourceId, {
          type: 'image',
          url: dataUrl,
          coordinates: coordinates
        });

        map.addLayer({
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0
          }
        });
      }
    } catch (error) {
      console.error('Error updating layer:', error);
      // Optional: Show user feedback
    } finally {
      setIsLoading(false);
    }
  };

  const processTiffData = async (image: any, channelId: string): Promise<string> => {
    const rasters = await image.readRasters(); // returns list of typed arrays
    const data: any = rasters[0]; // Assuming single band for these files
    const width = image.getWidth();
    const height = image.getHeight();
    
    // Check if we need to flip the image vertically
    // GeoTIFF stores pixel data starting from the origin defined in the geotransform
    // Standard north-up GeoTIFFs have:
    // - Origin at top-left (northwest corner)
    // - Negative Y resolution (pixels go south as row index increases)
    // This matches HTML Canvas which also starts at top-left
    // 
    // However, some GeoTIFFs (especially from certain tools) may have:
    // - Origin at bottom-left (southwest corner)  
    // - Positive Y resolution (pixels go north as row index increases)
    // These need to be flipped to display correctly on Canvas
    const resolution = image.getResolution();
    const [scaleX, scaleY] = resolution;
    
    // Get the origin point to understand the data orientation
    const origin = image.getOrigin();
    const bbox = image.getBoundingBox();
    
    // If scaleY is positive, origin is at bottom-left, data goes bottom-to-top
    // Canvas expects top-to-bottom, so we need to flip
    // 
    // For standard north-up GeoTIFFs (negative scaleY), data is already top-to-bottom
    // which matches Canvas expectations, so no flip needed.
    const needsVerticalFlip = scaleY > 0;
    
    console.log('TIFF Resolution:', resolution);
    console.log('TIFF Origin:', origin);
    console.log('TIFF BBox:', bbox);
    console.log('needsVerticalFlip:', needsVerticalFlip);
    
    // Try to get NoData value from TIFF metadata
    const fileDirectory = image.getFileDirectory();
    let noDataValue: number | null = null;
    
    // Check standard GDAL_NODATA tag (42113) if available or parsed
    if (fileDirectory.GDAL_NODATA) {
      const cleanStr = String(fileDirectory.GDAL_NODATA).replace(/\0/g, '').trim();
      if (cleanStr.toLowerCase() === 'nan') {
        noDataValue = NaN;
      } else {
        noDataValue = parseFloat(cleanStr);
      }
    }
    
    // Also check GDALMetadata for nodata
    if (noDataValue === null && fileDirectory.GDALMetadata) {
      const metaStr = String(fileDirectory.GDALMetadata);
      const noDataMatch = metaStr.match(/<Item name="NODATA">([^<]+)<\/Item>/i);
      if (noDataMatch) {
        const val = noDataMatch[1].trim();
        noDataValue = val.toLowerCase() === 'nan' ? NaN : parseFloat(val);
      }
    }
    
    console.log('TIFF Processing - Channel:', channelId);
    console.log('TIFF FileDirectory keys:', Object.keys(fileDirectory));
    console.log('Detected NoData value:', noDataValue);
    console.log('Data type:', data.constructor.name);
    console.log('Image dimensions:', width, 'x', height);
    console.log('Data length:', data.length, 'Expected:', width * height);
    console.log('Data length matches:', data.length === width * height);
    console.log('First 10 pixel values:', Array.from(data.slice(0, 10)));
    console.log('Last 10 pixel values:', Array.from(data.slice(-10)));
    
    // Check TIFF structure (tiles vs strips)
    console.log('TIFF TileWidth:', fileDirectory.TileWidth);
    console.log('TIFF TileLength:', fileDirectory.TileLength);
    console.log('TIFF RowsPerStrip:', fileDirectory.RowsPerStrip);
    console.log('TIFF SamplesPerPixel:', fileDirectory.SamplesPerPixel);
    console.log('TIFF PlanarConfiguration:', fileDirectory.PlanarConfiguration);
    
    // Count NA values to understand data distribution
    let naCount = 0;
    let validCount = 0;
    for (let i = 0; i < data.length; i++) {
      if (isNaN(data[i]) || (noDataValue !== null && !isNaN(noDataValue) && data[i] === noDataValue)) {
        naCount++;
      } else {
        validCount++;
      }
    }
    console.log('NA pixel count:', naCount, 'Valid pixel count:', validCount, 'NA percentage:', (naCount / data.length * 100).toFixed(2) + '%');
    
    // Check NA distribution by row (first few and last few rows)
    const checkRowNA = (rowIdx: number) => {
      const start = rowIdx * width;
      let rowNA = 0;
      for (let c = 0; c < width; c++) {
        const val = data[start + c];
        if (isNaN(val) || (noDataValue !== null && !isNaN(noDataValue) && val === noDataValue)) rowNA++;
      }
      return rowNA;
    };
    console.log('NA count in row 0 (top):', checkRowNA(0));
    console.log('NA count in row', height - 1, '(bottom):', checkRowNA(height - 1));
    console.log('NA count in middle row', Math.floor(height / 2), ':', checkRowNA(Math.floor(height / 2)));

    // Normalization logic with fixed ranges for consistency across timesteps
    const RANGES: { [key: string]: { min: number, max: number } } = {
      'lightning': { min: 0, max: 20 },
      'sat_ch0': { min: -2, max: 15 },
      'sat_ch1': { min: -3, max: 120 },
    };

    const rangeConfig = RANGES[channelId] || { min: 0, max: 1 };
    const { min, max } = rangeConfig;
    const range = max - min;
    const rgba = new Uint8ClampedArray(width * height * 4);

    // --- REPROJECTION LOGIC ---
    // Reproject WGS84 (Linear Lat) to Web Mercator (Linear Y) vertically
    const [minLon, minLat, maxLon, maxLat] = bbox;
    
    const latRad = (lat: number) => lat * Math.PI / 180;
    const mercY = (lat: number) => Math.log(Math.tan(latRad(lat) / 2 + Math.PI / 4));
    
    const yMaxMerc = mercY(maxLat);
    const yMinMerc = mercY(minLat);
    const mercHeight = yMaxMerc - yMinMerc;

    for (let y = 0; y < height; y++) {
      // Calculate which Latitude this target row corresponds to
      const v = y / height;
      const currentMercY = yMaxMerc - v * mercHeight;
      const currentLat = (2 * Math.atan(Math.exp(currentMercY)) - Math.PI / 2) * 180 / Math.PI;
      
      // Find corresponding row in source data (Linear Latitude)
      // sourceV goes 0 (Top/MaxLat) to 1 (Bottom/MinLat)
      const sourceV = (maxLat - currentLat) / (maxLat - minLat);
      
      let sourceRow = Math.floor(sourceV * height);
      sourceRow = Math.max(0, Math.min(height - 1, sourceRow));
      
      // Handle vertical flip if source is bottom-up
      if (needsVerticalFlip) {
        sourceRow = height - 1 - sourceRow;
      }
      
      const sourceRowOffset = sourceRow * width;
      const targetRowOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const val = data[sourceRowOffset + x];
        const idx = targetRowOffset + x * 4;
        
        // Check for NoData or NaN
        const isNoData = isNaN(val) || (noDataValue !== null && !isNaN(noDataValue) && val === noDataValue);
        
        if (isNoData) {
          rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
          continue;
        }
        
        // Clamp value to fixed range then normalize
        const clampedVal = Math.max(min, Math.min(max, val));
        const normalized = range === 0 ? 0 : (clampedVal - min) / range;
        const pixelVal = Math.floor(normalized * 255);
        
        // Color Mapping
        if (channelId === 'lightning') {
          // Lightning: Transparent to Yellow/Red
          if (pixelVal < 5) { // Threshold for transparency
              rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
          } else {
              // Heatmap: Yellow (255, 255, 0) to Red (255, 0, 0)
              const p = pixelVal / 255;
              rgba[idx] = 255; // R
              rgba[idx + 1] = Math.floor(255 * (1 - p)); // G
              rgba[idx + 2] = 0; // B
              rgba[idx + 3] = Math.floor(Math.min(255, 100 + pixelVal * 2));
          }
        } else {
          // Satellite: Grayscale
          rgba[idx] = pixelVal;
          rgba[idx + 1] = pixelVal;
          rgba[idx + 2] = pixelVal;
          rgba[idx + 3] = 255;
        }
      }
    }

    // Create Canvas to convert to Data URL
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2d context');
    
    const imageData = new ImageData(rgba, width, height);
    ctx.putImageData(imageData, 0, 0);
    
    // Debug: Log canvas dimensions and check if image looks correct
    console.log('Canvas dimensions:', canvas.width, 'x', canvas.height);
    
    // Debug: Open canvas image in new tab to verify it looks correct
    // Uncomment the next line to see the raw processed image:
    // window.open(canvas.toDataURL(), '_blank');
    
    return canvas.toDataURL();
  };

  return (
    <View style={styles.page}>
      {/* Navbar */}
      <View style={styles.navbar}>
        <Image 
          source={{ uri: '/logo.png' }} 
          style={styles.logo} 
          resizeMode="contain" 
        />
        <Text style={styles.title}>FlashNet</Text>
      </View>

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
      
      {isLoading && (
        <View style={styles.loader}>
          <Text style={styles.loaderText}>Loading...</Text>
        </View>
      )}

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

        {/* Time Slider */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.timeScroll}
          contentContainerStyle={styles.scrollContent}
        >
          {isScanning ? (
            <Text style={styles.scanningText}>Scanning for available timesteps...</Text>
          ) : timesteps.length === 0 ? (
            <Text style={styles.errorText}>No timesteps available</Text>
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

      {/* Splash Screen */}
      {isSplashVisible && (
        <Animated.View 
          style={[
            styles.splashScreen, 
            { transform: [{ translateY: slideAnim }] }
          ]}
        >
          <Image 
            source={{ uri: '/logo.png' }} 
            style={styles.splashLogo} 
            resizeMode="contain" 
          />
          <Text style={styles.splashTitle}>FlashNet</Text>
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
  navbar: {
    height: 60,
    backgroundColor: '#000',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#00FFFF',
    zIndex: 2000,
  },
  logo: {
    width: 40,
    height: 40,
    marginRight: 10,
  },
  title: {
    color: '#00FFFF', // Cyan text
    fontSize: 20,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  map: {
    flex: 1,
    width: '100%',
    // Removed minHeight to allow flex layout with navbar
  },
  loader: {
    position: 'absolute',
    top: 80, // Moved down below navbar
    left: '50%',
    transform: [{ translateX: '-50%' }],
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 10,
    borderRadius: 8,
    zIndex: 2000,
  },
  loaderText: {
    color: 'white',
    fontWeight: 'bold',
  },
  searchContainer: {
    position: 'absolute',
    top: 70,
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
  timeScroll: {
    maxHeight: 50,
    width: '100%',
  },
  scrollContent: {
    paddingHorizontal: 10,
  },
  timeBtn: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    elevation: 2,
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
  scanningText: {
    color: '#00FFFF',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 10,
  },
  errorText: {
    color: '#FF3B30',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 10,
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
