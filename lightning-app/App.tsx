import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Platform, StatusBar, Image, TextInput, Dimensions } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import * as GeoTIFF from 'geotiff';
import { Buffer } from 'buffer';

// Polyfill Buffer for GeoTIFF if needed
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

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

// --- BMP Generation Helper ---
// Creates an uncompressed BMP image from RGBA data
const createBmpUri = (width: number, height: number, rgbaData: Uint8Array): string => {
  const headerSize = 54; // 14 (file header) + 40 (info header)
  const fileSize = headerSize + rgbaData.length;
  const buffer = new Uint8Array(fileSize);
  const view = new DataView(buffer.buffer);

  // Bitmap File Header
  view.setUint16(0, 0x424D, false); // "BM" signature
  view.setUint32(2, fileSize, true); // File size
  view.setUint32(6, 0, true); // Reserved
  view.setUint32(10, headerSize, true); // Offset to pixel data

  // DIB Header (BITMAPINFOHEADER)
  view.setUint32(14, 40, true); // Header size
  view.setInt32(18, width, true); // Width
  view.setInt32(22, -height, true); // Height (negative for top-down)
  view.setUint16(26, 1, true); // Planes
  view.setUint16(28, 32, true); // Bits per pixel (32 for RGBA)
  view.setUint32(30, 0, true); // Compression (BI_RGB - no compression)
  view.setUint32(34, rgbaData.length, true); // Image size
  view.setInt32(38, 2835, true); // X pixels per meter (approx 72 DPI)
  view.setInt32(42, 2835, true); // Y pixels per meter
  view.setUint32(46, 0, true); // Colors used
  view.setUint32(50, 0, true); // Important colors

  // Pixel Data
  // BMP stores color as BGRA, but our input is RGBA. We need to swap R and B.
  // Also, MapLibre might expect RGBA or BGRA depending on implementation, but standard BMP is BGRA.
  // Let's copy and swap.
  let ptr = headerSize;
  for (let i = 0; i < rgbaData.length; i += 4) {
    buffer[ptr] = rgbaData[i + 2];     // B
    buffer[ptr + 1] = rgbaData[i + 1]; // G
    buffer[ptr + 2] = rgbaData[i];     // R
    buffer[ptr + 3] = rgbaData[i + 3]; // A
    ptr += 4;
  }

  // Convert to Base64
  const binary = String.fromCharCode(...buffer);
  const base64 = global.btoa ? global.btoa(binary) : Buffer.from(buffer).toString('base64');
  return `data:image/bmp;base64,${base64}`;
};

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
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [layerUrl, setLayerUrl] = useState<string | null>(null);
  const [layerCoordinates, setLayerCoordinates] = useState<any>(null);

  const cameraRef = useRef<MapLibreGL.Camera>(null);

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
          const url = `${BASE_BUCKET_URL}/${selectedStep.dateFolder}/forecast_${selectedStep.filenameTime}_${selectedChannel.id}.tiff`;
          console.log('Fetching:', url);
    
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch TIFF: ${response.statusText}`);
          
          const arrayBuffer = await response.arrayBuffer();
          const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
          const image = await tiff.getImage();
          const bbox = image.getBoundingBox();
          const [minX, minY, maxX, maxY] = bbox;
    
          // Process TIFF Data
          const rasters = await image.readRasters();
          const data: any = rasters[0];
          const width = image.getWidth();
          const height = image.getHeight();
          const resolution = image.getResolution();
          const [scaleX, scaleY] = resolution;
          const needsVerticalFlip = scaleY > 0;

          // NoData handling
          const fileDirectory = image.getFileDirectory();
          let noDataValue = null;
          if (fileDirectory.GDAL_NODATA) {
             const cleanStr = String(fileDirectory.GDAL_NODATA).replace(/\0/g, '').trim();
             noDataValue = cleanStr.toLowerCase() === 'nan' ? NaN : parseFloat(cleanStr);
          }

          // Ranges
          const RANGES: { [key: string]: { min: number, max: number } } = {
            'lightning': { min: 0, max: 20 },
            'sat_ch0': { min: -2, max: 15 },
            'sat_ch1': { min: -3, max: 120 },
          };
          const { min, max } = RANGES[selectedChannel.id] || { min: 0, max: 1 };
          const range = max - min;
          const rgba = new Uint8ClampedArray(width * height * 4);

          // Reprojection logic (Simplified for performance, similar to Web)
          // Note: In a real native app, consider doing this in C++ or using a shader if performance is bad.
          // For now, we stick to JS logic matching the web version.
          
          const latRad = (lat: number) => lat * Math.PI / 180;
          const mercY = (lat: number) => Math.log(Math.tan(latRad(lat) / 2 + Math.PI / 4));
          const yMaxMerc = mercY(maxY);
          const yMinMerc = mercY(minY);
          const mercHeight = yMaxMerc - yMinMerc;

          for (let y = 0; y < height; y++) {
            const v = y / height;
            const currentMercY = yMaxMerc - v * mercHeight;
            const currentLat = (2 * Math.atan(Math.exp(currentMercY)) - Math.PI / 2) * 180 / Math.PI;
            const sourceV = (maxY - currentLat) / (maxY - minY);
            let sourceRow = Math.floor(sourceV * height);
            sourceRow = Math.max(0, Math.min(height - 1, sourceRow));
            if (needsVerticalFlip) sourceRow = height - 1 - sourceRow;

            const sourceRowOffset = sourceRow * width;
            const targetRowOffset = y * width * 4;

            for (let x = 0; x < width; x++) {
                const val = data[sourceRowOffset + x];
                const idx = targetRowOffset + x * 4;
                const isNoData = isNaN(val) || (noDataValue !== null && !isNaN(noDataValue) && val === noDataValue);

                if (isNoData) {
                    rgba[idx] = 0; rgba[idx+1] = 0; rgba[idx+2] = 0; rgba[idx+3] = 0;
                    continue;
                }

                const clampedVal = Math.max(min, Math.min(max, val));
                const normalized = range === 0 ? 0 : (clampedVal - min) / range;
                const pixelVal = Math.floor(normalized * 255);

                if (selectedChannel.id === 'lightning') {
                    if (pixelVal < 5) {
                        rgba[idx] = 0; rgba[idx+1] = 0; rgba[idx+2] = 0; rgba[idx+3] = 0;
                    } else {
                        const p = pixelVal / 255;
                        rgba[idx] = 255;
                        rgba[idx+1] = Math.floor(255 * (1 - p));
                        rgba[idx+2] = 0;
                        rgba[idx+3] = Math.floor(Math.min(255, 100 + pixelVal * 2));
                    }
                } else {
                    rgba[idx] = pixelVal; rgba[idx+1] = pixelVal; rgba[idx+2] = pixelVal; rgba[idx+3] = 255;
                }
            }
          }

          // Generate BMP
          const bmpUri = createBmpUri(width, height, rgba);
          setLayerUrl(bmpUri);
          
          // Coordinates: [TL, TR, BR, BL]
          setLayerCoordinates([
            [minX, maxY],
            [maxX, maxY],
            [maxX, minY],
            [minX, minY]
          ]);

        } catch (error) {
            console.error('Error updating layer:', error);
        } finally {
            setIsLoading(false);
        }
    };

    updateLayer();
  }, [selectedStep, selectedChannel]);


  // Map Style - Using OpenStreetMap Raster to match Web
  const MAP_STYLE = {
    "version": 8,
    "name": "OSM",
    "sources": {
      "osm": {
        "type": "raster",
        "tiles": ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        "tileSize": 256,
        "attribution": "© OpenStreetMap contributors"
      }
    },
    "layers": [
      {
        "id": "osm",
        "type": "raster",
        "source": "osm",
        "minzoom": 0,
        "maxzoom": 19
      }
    ]
  };

  return (
    <View style={styles.page}>
      <StatusBar barStyle="light-content" />
      
      {/* Navbar */}
      <View style={styles.navbar}>
        <Image 
            source={require('./assets/icon.png')} // Assuming icon exists, or use a placeholder
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
        styleJSON={JSON.stringify(MAP_STYLE)}
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

        {/* Overlay */}
        {layerUrl && layerCoordinates && (
          <MapLibreGL.ImageSource
            id="forecast-source"
            coordinates={layerCoordinates}
            url={layerUrl}
          >
            <MapLibreGL.RasterLayer
              id="forecast-layer"
              style={{
                rasterOpacity: selectedChannel.id.startsWith('sat_') ? 0.8 : 0.8,
                rasterFadeDuration: 0
              }}
            />
          </MapLibreGL.ImageSource>
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
