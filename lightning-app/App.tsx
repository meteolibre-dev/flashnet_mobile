import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Platform, StyleSheet, View, Text, TouchableOpacity, ScrollView, Image } from 'react-native';
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

// --- Helpers ---
const generateTimesteps = (startDateStr, count, intervalMinutes) => {
  const year = parseInt(startDateStr.substring(0, 4));
  const month = parseInt(startDateStr.substring(4, 6)) - 1;
  const day = parseInt(startDateStr.substring(6, 8));
  const hour = parseInt(startDateStr.substring(8, 10));
  const minute = parseInt(startDateStr.substring(10, 12));

  const startTime = new Date(Date.UTC(year, month, day, hour, minute));
  const steps = [];

  const baseDateFolder = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  for (let i = 0; i < count; i++) {
    // Forward in time: startTime + i * interval
    const t = new Date(startTime.getTime() + i * intervalMinutes * 60 * 1000);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    const h = String(t.getUTCHours()).padStart(2, '0');
    const min = String(t.getUTCMinutes()).padStart(2, '0');
    
    steps.push({
      dateFolder: baseDateFolder,
      filenameTime: `${y}${m}${d}${h}${min}`,
      label: `${h}:${min}`,
      fullDate: t
    });
  }
  return steps;
};

const TIMESTEPS = generateTimesteps(LATEST_DATE_STR, TIMESTEP_COUNT, INTERVAL_MINUTES);

export default function App() {
  const [selectedStep, setSelectedStep] = useState(TIMESTEPS[TIMESTEPS.length - 1]);
  const [selectedChannel, setSelectedChannel] = useState(CHANNELS[0]);
  const [isPlaying, setIsPlaying] = useState(false);
  const playInterval = useRef<any>(null);
  const mapRef = useRef<any>(null);
  const mapInstance = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(false);

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

  // Playback Logic
  useEffect(() => {
    if (isPlaying) {
      playInterval.current = setInterval(() => {
        setSelectedStep((prevStep) => {
          const currentIndex = TIMESTEPS.findIndex(s => s.filenameTime === prevStep.filenameTime);
          const nextIndex = (currentIndex + 1) % TIMESTEPS.length;
          return TIMESTEPS[nextIndex];
        });
      }, 1000); // 1 second per frame
    } else {
      if (playInterval.current) clearInterval(playInterval.current);
    }
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying]);

  // Update layer when selection changes
  useEffect(() => {
    if (mapInstance.current && mapInstance.current.isStyleLoaded()) {
      updateMapLayer();
    }
  }, [selectedStep, selectedChannel]);

  const updateMapLayer = async () => {
    if (!mapInstance.current) return;
    const map = mapInstance.current;
    
    setIsLoading(true);
    try {
      const url = `${BASE_BUCKET_URL}/${selectedStep.dateFolder}/forecast_${selectedStep.filenameTime}_${selectedChannel.id}.tiff`;
      console.log('Fetching:', url);

      const dataUrl = await fetchAndProcessTiff(url, selectedChannel.id);

      const coordinates = [
        [REGION.west, REGION.north], // TL
        [REGION.east, REGION.north], // TR
        [REGION.east, REGION.south], // BR
        [REGION.west, REGION.south]  // BL
      ];

      const sourceId = 'forecast-source';
      const layerId = 'forecast-layer';

      const source = map.getSource(sourceId);
      if (source) {
        source.updateImage({ url: dataUrl, coordinates });
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
            'raster-opacity': 0.8,
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

  const fetchAndProcessTiff = async (url, channelId) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch TIFF: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const rasters = await image.readRasters(); // returns list of typed arrays
    const data: any = rasters[0]; // Assuming single band for these files
    const width = image.getWidth();
    const height = image.getHeight();

    // Normalization logic
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    
    const range = max - min;
    const rgba = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      const idx = i * 4;
      
      if (isNaN(val)) {
        rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
        continue;
      }
      
      const normalized = range === 0 ? 0 : (val - min) / range;
      const pixelVal = Math.floor(normalized * 255);
      
      // Color Mapping
      if (channelId === 'lightning') {
        // Lightning: Transparent to Yellow/Red
        if (pixelVal < 5) { // Threshold for transparency
            rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
        } else {
            // Heatmap: Yellow (255, 255, 0) to Red (255, 0, 0)
            // Normalized 0-1
            const p = pixelVal / 255;
            rgba[idx] = 255; // R
            rgba[idx + 1] = Math.floor(255 * (1 - p)); // G (Decreases as value increases)
            rgba[idx + 2] = 0; // B
            rgba[idx + 3] = Math.floor(Math.min(255, pixelVal * 2)); // Alpha (More opaque as value increases)
        }
      } else {
        // Satellite: Grayscale
        // Invert for IR? Usually IR is inverted (Cold=White), but let's stick to standard first.
        // If Ch1 is IR, usually lighter = colder (clouds). 
        // Assuming raw values are scaled such that interesting features are visible.
        rgba[idx] = pixelVal;
        rgba[idx + 1] = pixelVal;
        rgba[idx + 2] = pixelVal;
        rgba[idx + 3] = 255;
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
          {TIMESTEPS.map((step) => (
            <TouchableOpacity
              key={step.filenameTime}
              onPress={() => setSelectedStep(step)}
              style={[styles.timeBtn, selectedStep.filenameTime === step.filenameTime && styles.selectedBtn]}
            >
              <Text style={[styles.btnText, selectedStep.filenameTime === step.filenameTime && styles.selectedBtnText]}>
                {step.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
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
    borderBottomColor: '#00FFFF', // Cyan border
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
});
