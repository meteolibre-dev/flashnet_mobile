import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Platform, StatusBar, Image } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';

// Set access token if needed (null for MapLibre/OpenStreetMap)
MapLibreGL.setAccessToken(null);

// --- Configuration ---
const COORDINATES = [
  [-81.2778265, 77.3564187], // TL
  [81.2904694, 77.3564187],  // TR
  [81.2904694, -77.3690833], // BR
  [-81.2778265, -77.3690833] // BL
];

// Simplified Dark Style derived from demotiles
const MAP_STYLE = {
  "version": 8,
  "name": "Simplified Dark",
  "sources": {
    "maplibre": {
      "type": "vector",
      "url": "https://demotiles.maplibre.org/tiles/tiles.json"
    }
  },
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": {
        "background-color": "#000000"
      }
    },
    {
      "id": "coastline",
      "type": "line",
      "source": "maplibre",
      "source-layer": "countries",
      "paint": {
        "line-color": "#333333",
        "line-width": 1
      }
    },
    {
      "id": "countries-boundary",
      "type": "line",
      "source": "maplibre",
      "source-layer": "countries",
      "paint": {
        "line-color": "#FFFFFF",
        "line-width": 1,
        "line-opacity": 0.5
      }
    },
    {
      "id": "countries-label",
      "type": "symbol",
      "source": "maplibre",
      "source-layer": "centroids",
      "minzoom": 2,
      "layout": {
        "text-field": "{NAME}",
        "text-font": ["Open Sans Semibold"],
        "text-transform": "uppercase",
        "text-size": 12
      },
      "paint": {
        "text-color": "#FFFFFF",
        "text-halo-color": "#000000",
        "text-halo-width": 1
      }
    }
  ]
};

// --- Local Data Files ---
// Hardcoded requires as requested
const LOCAL_FILES: { [key: string]: any } = {
  '20250725180000': require('./assets/data/forecast_20250725180000_lightning.png'),
  '20250725181000': require('./assets/data/forecast_20250725181000_lightning.png'),
  '20250725182000': require('./assets/data/forecast_20250725182000_lightning.png'),
};

interface Timestep {
  id: string;
  label: string;
  imageSource: any;
}

const TIMESTEPS: Timestep[] = Object.keys(LOCAL_FILES).sort().map(key => {
  const hour = key.substring(8, 10);
  const minute = key.substring(10, 12);
  return {
    id: key,
    label: `${hour}:${minute}`,
    imageSource: LOCAL_FILES[key]
  };
});

export default function App() {
  const [selectedStep, setSelectedStep] = useState<Timestep>(TIMESTEPS[0]);
  const [isPlaying, setIsPlaying] = useState(false);
  const playInterval = useRef<any>(null);

  // Playback Logic
  useEffect(() => {
    if (isPlaying) {
      playInterval.current = setInterval(() => {
        setSelectedStep((prevStep) => {
          const currentIndex = TIMESTEPS.findIndex(s => s.id === prevStep.id);
          const nextIndex = (currentIndex + 1) % TIMESTEPS.length;
          return TIMESTEPS[nextIndex];
        });
      }, 1000);
    } else {
      if (playInterval.current) clearInterval(playInterval.current);
    }
    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying]);

  return (
    <View style={styles.page}>
      <StatusBar barStyle="light-content" />
      
      {/* Navbar */}
      <View style={styles.navbar}>
        <Text style={styles.title}>FlashNet</Text>
      </View>

      {/* Map */}
      <MapLibreGL.MapView
        style={styles.map}
        styleJSON={JSON.stringify(MAP_STYLE)}
        logoEnabled={false}
        attributionEnabled={false}
      >
        <MapLibreGL.Camera
          defaultSettings={{
            centerCoordinate: [0, 0],
            zoomLevel: 1
          }}
        />

        {/* Lightning Overlay */}
        {selectedStep && (
          <MapLibreGL.ImageSource
            id="lightning-source"
            coordinates={COORDINATES}
            url={Image.resolveAssetSource(selectedStep.imageSource).uri}
          >
            <MapLibreGL.RasterLayer
              id="lightning-layer"
              style={{
                rasterOpacity: 0.8,
                rasterFadeDuration: 0
              }}
            />
          </MapLibreGL.ImageSource>
        )}
      </MapLibreGL.MapView>
      
      {/* Controls */}
      <View style={styles.controlsContainer}>
        <View style={styles.controlsRow}>
            <TouchableOpacity 
              onPress={() => setIsPlaying(!isPlaying)}
              style={[styles.playBtn, isPlaying && styles.pauseBtn]}
            >
              <Text style={styles.playBtnText}>{isPlaying ? "II" : "▶"}</Text>
            </TouchableOpacity>

             <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.timeScroll}
              contentContainerStyle={styles.scrollContent}
            >
              {TIMESTEPS.map((step) => (
                <TouchableOpacity
                  key={step.id}
                  onPress={() => setSelectedStep(step)}
                  style={[styles.timeBtn, selectedStep.id === step.id && styles.selectedBtn]}
                >
                  <Text style={[styles.btnText, selectedStep.id === step.id && styles.selectedBtnText]}>
                    {step.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
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
  title: {
    color: '#00FFFF',
    fontSize: 20,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  map: {
    flex: 1,
  },
  controlsContainer: {
    position: 'absolute',
    bottom: 30,
    left: 10,
    right: 10,
    zIndex: 100,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 20,
    padding: 10,
    borderWidth: 1,
    borderColor: '#333'
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
  timeScroll: {
    flex: 1,
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
  }
});
