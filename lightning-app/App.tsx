import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View, Text, TouchableOpacity, ScrollView } from 'react-native';
import 'leaflet/dist/leaflet.css';

const pngFiles = [
  '20250725180000_lightning_0001.png',
  '20250725181000_lightning_0001.png',
  '20250725182000_lightning_0001.png',
  '20250725183000_lightning_0001.png',
  '20250725184000_lightning_0001.png',
  '20250725185000_lightning_0001.png',
  '20250725190000_lightning_0001.png',
  '20250725191000_lightning_0001.png',
  '20250725192000_lightning_0001.png',
  '20250725193000_lightning_0001.png',
  '20250725194000_lightning_0001.png',
  '20250725195000_lightning_0001.png',
  '20250725200000_lightning_0001.png',
  '20250725201000_lightning_0001.png',
  '20250725202000_lightning_0001.png',
  '20250725203000_lightning_0001.png',
  '20250725204000_lightning_0001.png',
  '20250725205000_lightning_0001.png',
  '20250725210000_lightning_0001.png',
  '20250725211000_lightning_0001.png',
  '20250725212000_lightning_0001.png',
  '20250725213000_lightning_0001.png'
];

export default function App() {
  const [selectedImage, setSelectedImage] = useState(pngFiles[pngFiles.length - 1]);
  const mapRef = useRef(null);
  const mapInstance = useRef(null);

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
          hash: true,
          center: [0, 15],
          zoom: 1
        });

        mapInstance.current = map;
        map.addControl(new NavigationControl());

        map.on('load', async () => {
          await loadImageLayer(map, selectedImage);
        });
      });
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' && mapInstance.current && mapInstance.current.isStyleLoaded()) {
      loadImageLayer(mapInstance.current, selectedImage);
    }
  }, [selectedImage]);

  const loadImageLayer = async (map, filename) => {
    try {
      console.log('Loading Image:', filename);
      
      // Remove existing layer if present
      if (map.getLayer('lightning-layer')) {
        map.removeLayer('lightning-layer');
      }
      if (map.getSource('lightning-canvas')) {
        map.removeSource('lightning-canvas');
      }

      // Mercator bounds derived from gdalinfo of the warped files
      // These are static because all files were warped to the same extent
      const west = -81.2778265;
      const north = 77.3564187; // Top
      const east = 81.2904694;  // Right
      const south = -77.3690833; // Bottom
      
      const coordinates = [
        [west, north], // Top-Left
        [east, north], // Top-Right
        [east, south], // Bottom-Right
        [west, south]  // Bottom-Left
      ];
      
      map.addSource('lightning-canvas', {
        type: 'image',
        url: `/data_tmp/${filename}`, // Serve PNG directly
        coordinates: coordinates
      });

      map.addLayer({
        id: 'lightning-layer',
        type: 'raster',
        source: 'lightning-canvas',
        paint: {
          'raster-opacity': 1.0,
          'raster-resampling': 'nearest'
        }
      });
      
    } catch (error) {
      console.error('Error loading image layer:', error);
    }
  };

  const switchImage = (img) => setSelectedImage(img);

  return (
    <View style={styles.page}>
      {Platform.OS === 'web' ? (
        <div ref={mapRef} style={styles.map} />
      ) : (
        <View style={styles.map} />
      )}
      
      <View style={styles.controls}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
        >
          {pngFiles.map((file) => (
            <TouchableOpacity
              key={file}
              onPress={() => switchImage(file)}
              style={[styles.button, selectedImage === file && styles.selected]}
            >
              <Text style={styles.buttonText}>{file.slice(0, 15)}</Text>
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
    height: '100vh',
  },
  map: {
    flex: 1,
    height: '100%',
    minHeight: '100vh',
    width: '100%',
  },
  controls: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    zIndex: 1000,
  },
  scroll: {
    maxHeight: 50,
  },
  scrollContent: {
    paddingHorizontal: 10,
  },
  button: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selected: {
    borderColor: '#007AFF',
    backgroundColor: 'white',
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
