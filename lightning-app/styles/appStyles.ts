import { Platform, StyleSheet, Dimensions } from 'react-native';

const { width, height } = Dimensions.get('screen');

// ============================================================================
// Combined Styles for App.tsx (Native)
// ============================================================================

export const styles = StyleSheet.create({
  // Page/Layout
  page: {
    flex: 1,
    backgroundColor: '#000',
  },
  map: {
    flex: 1,
  },

  // Search
  searchContainer: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 40 : 50,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1500,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    width: 250,
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
    width: 250,
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
  locationBtn: {
    width: 40,
    height: 40,
    backgroundColor: 'white',
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  locationBtnText: {
    fontSize: 18,
  },

  // Computed Time Badge
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

  // Point Forecast Panel
  pointForecastPanel: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 100 : 110,
    right: 10,
    left: 10,
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
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pointForecastTitle: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  pointForecastSubtitle: {
    color: '#888',
    fontSize: 10,
  },
  pointForecastData: {
    paddingVertical: 12,
  },
  pointForecastColumn: {
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  pointForecastTime: {
    color: '#888',
    fontSize: 12,
    marginBottom: 4,
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

  // Controls
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

  // Timeline
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

  // Splash Screen
  splashContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 9999,
  },
  splashImage: {
    width: width,
    height: height,
    resizeMode: 'cover',
  },

  // Local View
  localView: {
    flex: 1,
    backgroundColor: '#111',
    padding: 20,
    paddingTop: 80,
  },
  localHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  localTitle: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  localSubtitle: {
    color: '#888',
    fontSize: 14,
    marginTop: 4,
  },
  localContent: {
    backgroundColor: '#222',
    borderRadius: 12,
    overflow: 'hidden',
  },
  localLegend: {
    padding: 12,
    alignItems: 'center',
  },
  localLegendText: {
    color: '#888',
    fontSize: 12,
  },
  localColumn: {
    alignItems: 'center',
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  localTime: {
    color: '#888',
    fontSize: 16,
    marginBottom: 8,
  },
  localValue: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 60,
    alignItems: 'center',
  },
  localValueActive: {
    backgroundColor: 'rgba(255, 200, 0, 0.3)',
  },
  localValueText: {
    color: '#666',
    fontSize: 16,
    fontWeight: 'bold',
  },
  localValueTextActive: {
    color: '#ffcc00',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#888',
    fontSize: 16,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyStateText: {
    color: '#666',
    fontSize: 16,
    textAlign: 'center',
  },

  // Tab Bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderTopWidth: 1,
    borderTopColor: '#333',
    paddingBottom: Platform.OS === 'android' ? 10 : 30,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  tabItemActive: {
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  tabIcon: {
    fontSize: 24,
    marginBottom: 4,
  },
  tabIconActive: {
    opacity: 1,
  },
  tabLabel: {
    color: '#666',
    fontSize: 12,
  },
  tabLabelActive: {
    color: '#fff',
    fontWeight: '600',
  },
});

// Type export for styles
export type AppStyles = typeof styles;
