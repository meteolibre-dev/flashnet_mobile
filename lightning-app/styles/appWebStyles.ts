import { StyleSheet } from 'react-native';

// ============================================================================
// Web-Specific Styles (App.web.tsx)
// ============================================================================

export const webStyles = StyleSheet.create({
  // Page
  page: {
    flex: 1,
    height: '100%',
    backgroundColor: '#000',
  },
  map: {
    flex: 1,
    width: '100%',
  },

  // Search
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
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
    top: 100,
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
    color: '#fff',
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
    bottom: 100,
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

  // Timeline
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

  // Splash Screen
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
    marginVertical: 10,
    paddingVertical: 10,
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
    paddingHorizontal: 3,
    justifyContent: 'center',
  },
  localTime: {
    color: '#888',
    fontSize: 13,
    marginBottom: 8,
  },
  localValue: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 6,
    minWidth: 42,
    alignItems: 'center',
  },
  localValueActive: {
    backgroundColor: 'rgba(255, 200, 0, 0.3)',
  },
  localValueText: {
    color: '#666',
    fontSize: 14,
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
    paddingBottom: 20,
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
    marginBottom: 4,
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

// ============================================================================
// Type Export
// ============================================================================

export type WebStyles = typeof webStyles;
