import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart' as geo;
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';
import 'api_service.dart';
import 'models.dart';

// Europe bounding box
const _west = -10.0;
const _east = 33.0;
const _south = 33.0;
const _north = 65.0;

class ForecastScreen extends StatefulWidget {
  const ForecastScreen({super.key});

  @override
  State<ForecastScreen> createState() => _ForecastScreenState();
}

class _ForecastScreenState extends State<ForecastScreen> {
  MapboxMap? _mapboxMap;

  // Timesteps state
  List<Timestep> _timesteps = [];
  List<String> _availableBands = [];
  int _currentIndex = 0;
  bool _isScanning = true;
  bool _isRefreshing = false;

  // Playback
  Timer? _playbackTimer;
  bool _isPlaying = false;

  // User marker
  CircleAnnotationManager? _circleManager;

  // Layer management
  String? _activeSourceId;
  String? _activeLayerId;
  final Set<String> _addedSourceIds = {};
  final Set<String> _addedLayerIds = {};

  // Channel selection
  Channel _selectedChannel = primaryChannels[1];
  bool _showSecondaryMenu = false;

  // Location
  geo.Position? _userPosition;
  bool _isLoadingLayer = false;

  // Time display
  bool _useLocalTime = true;

  // Splash
  bool _showSplash = true;

  @override
  void initState() {
    super.initState();
    _loadTimesteps();
    _requestLocation();
    Future.delayed(const Duration(milliseconds: 3000), () {
      if (mounted) setState(() => _showSplash = false);
    });
  }

  @override
  void dispose() {
    _playbackTimer?.cancel();
    super.dispose();
  }

  // ───────────────────────── Data ─────────────────────────

  Future<void> _loadTimesteps() async {
    setState(() => _isScanning = true);
    try {
      final result = await fetchAvailableTimesteps();
      if (!mounted) return;
      setState(() {
        _timesteps = result.timesteps;
        _availableBands = result.availableBands;
        _currentIndex = 0;
      });
      if (_timesteps.isNotEmpty && _mapboxMap != null) {
        _updateLayer();
      }
    } catch (e) {
      debugPrint('Error loading timesteps: $e');
    } finally {
      if (mounted) setState(() => _isScanning = false);
    }
  }

  Future<void> _refresh() async {
    setState(() => _isRefreshing = true);
    try {
      await _clearAllTileLayers();
      final result = await fetchAvailableTimesteps();
      if (!mounted) return;
      setState(() {
        _timesteps = result.timesteps;
        _availableBands = result.availableBands;
        _currentIndex = 0;
      });
      if (_timesteps.isNotEmpty) _updateLayer();
    } catch (e) {
      debugPrint('Error refreshing: $e');
    } finally {
      if (mounted) setState(() => _isRefreshing = false);
    }
  }

  Future<void> _clearAllTileLayers() async {
    final map = _mapboxMap;
    if (map == null) return;
    for (final layerId in List.of(_addedLayerIds)) {
      try {
        if (await map.style.styleLayerExists(layerId)) {
          await map.style.removeStyleLayer(layerId);
        }
      } catch (_) {}
    }
    for (final sourceId in List.of(_addedSourceIds)) {
      try {
        if (await map.style.styleSourceExists(sourceId)) {
          await map.style.removeStyleSource(sourceId);
        }
      } catch (_) {}
    }
    _addedLayerIds.clear();
    _addedSourceIds.clear();
    _activeSourceId = null;
    _activeLayerId = null;
  }

  // ───────────────────────── Map setup ─────────────────────────

  void _onMapCreated(MapboxMap map) {
    _mapboxMap = map;
    map.scaleBar.updateSettings(ScaleBarSettings(
      enabled: true,
      position: OrnamentPosition.BOTTOM_RIGHT,
    ));
    // Sources/layers are added in _onStyleLoaded once the style is ready
  }

  Future<void> _onStyleLoaded(StyleLoadedEventData _) async {
    final map = _mapboxMap;
    if (map == null) return;

    // Style was (re)loaded — all previously added sources/layers are gone
    _activeSourceId = null;
    _activeLayerId = null;

    await map.style.addSource(GeoJsonSource(
      id: 'region-boundary',
      data: '{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[$_west,$_north],[$_east,$_north],[$_east,$_south],[$_west,$_south],[$_west,$_north]]}}',
    ));
    await map.style.addLayer(LineLayer(
      id: 'region-boundary-line',
      sourceId: 'region-boundary',
      lineColor: 0xFFFF0000,
      lineWidth: 2.0,
      lineDasharray: [4.0, 4.0],
    ));

    if (_timesteps.isNotEmpty) _updateLayer();

    if (_userPosition != null) {
      _flyToUserPosition(_userPosition!);
    }
  }

  // ───────────────────────── Tile layer ─────────────────────────

  int _layerGeneration = 0;

  Future<void> _updateLayer() async {
    final map = _mapboxMap;
    if (map == null || _timesteps.isEmpty) return;

    final step = _timesteps[_currentIndex];
    final channelId = _selectedChannel.id;

    final newSourceId = 'forecast-$channelId-${step.filenameTime}';
    final newLayerId = 'layer-$channelId-${step.filenameTime}';

    // Already showing this exact layer — nothing to do
    if (_activeSourceId == newSourceId) return;

    final gen = ++_layerGeneration;
    setState(() => _isLoadingLayer = true);

    try {
      final url = tileUrl(step, channelId);

      // Add source only if it doesn't already exist
      final sourceExists = await map.style.styleSourceExists(newSourceId);
      if (!sourceExists) {
        await map.style.addSource(RasterSource(
          id: newSourceId,
          tiles: [url],
          tileSize: 512,
          minzoom: 3,
          maxzoom: 10,
          volatile: false,
        ));
        _addedSourceIds.add(newSourceId);
      }

      // Stale check — a newer update was requested while we awaited
      if (gen != _layerGeneration) return;

      // Add layer only if it doesn't already exist
      final layerExists = await map.style.styleLayerExists(newLayerId);
      if (!layerExists) {
        await map.style.addLayer(RasterLayer(
          id: newLayerId,
          sourceId: newSourceId,
          rasterOpacity: 0,
          rasterFadeDuration: 0,
        ));
        _addedLayerIds.add(newLayerId);
      }

      if (gen != _layerGeneration) return;

      // Fade in new layer
      await map.style.setStyleLayerProperty(
          newLayerId, 'raster-opacity-transition', '{"duration":300}');
      await map.style.setStyleLayerProperty(
          newLayerId, 'raster-opacity', 0.8);

      // Fade out & remove old layer
      final oldSourceId = _activeSourceId;
      final oldLayerId = _activeLayerId;
      if (oldLayerId != null && oldSourceId != null) {
        await map.style.setStyleLayerProperty(
            oldLayerId, 'raster-opacity-transition', '{"duration":300}');
        await map.style.setStyleLayerProperty(oldLayerId, 'raster-opacity', 0);
        Future.delayed(const Duration(milliseconds: 350), () async {
          try {
            await map.style.removeStyleLayer(oldLayerId);
            await map.style.removeStyleSource(oldSourceId);
          } catch (_) {}
        });
      }

      _activeSourceId = newSourceId;
      _activeLayerId = newLayerId;
    } catch (e) {
      debugPrint('Error updating layer: $e');
    } finally {
      if (gen == _layerGeneration && mounted) {
        setState(() => _isLoadingLayer = false);
      }
    }
  }

  // ───────────────────────── Playback ─────────────────────────

  void _togglePlayback() {
    if (_isPlaying) {
      _playbackTimer?.cancel();
      _playbackTimer = null;
      setState(() => _isPlaying = false);
    } else {
      setState(() => _isPlaying = true);
      _playbackTimer = Timer.periodic(const Duration(seconds: 3), (_) {
        if (_timesteps.isEmpty) return;
        setState(() {
          _currentIndex = (_currentIndex + 1) % _timesteps.length;
        });
        _updateLayer();
      });
    }
  }

  // ───────────────────────── Location ─────────────────────────

  Future<void> _requestLocation() async {
    try {
      geo.LocationPermission permission = await geo.Geolocator.checkPermission();
      if (permission == geo.LocationPermission.denied) {
        permission = await geo.Geolocator.requestPermission();
      }
      if (permission == geo.LocationPermission.denied ||
          permission == geo.LocationPermission.deniedForever) {
        return;
      }

      final pos = await geo.Geolocator.getCurrentPosition(
        locationSettings: const geo.LocationSettings(
          accuracy: geo.LocationAccuracy.medium,
        ),
      );

      if (!mounted) return;
      setState(() => _userPosition = pos);

      if (_mapboxMap != null) _flyToUserPosition(pos);
    } catch (e) {
      debugPrint('Location error: $e');
    }
  }

  bool _inBounds(double lon, double lat) =>
      lon >= _west && lon <= _east && lat >= _south && lat <= _north;

  void _flyToUserPosition(geo.Position pos) {
    if (!_inBounds(pos.longitude, pos.latitude)) return;
    _mapboxMap?.flyTo(
      CameraOptions(
        center: Point(coordinates: Position(pos.longitude, pos.latitude)),
        zoom: 6,
      ),
      MapAnimationOptions(duration: 1500),
    );
    _addUserMarker(pos);
  }

  Future<void> _addUserMarker(geo.Position pos) async {
    final map = _mapboxMap;
    if (map == null) return;
    try {
      _circleManager ??= await map.annotations.createCircleAnnotationManager();
      await _circleManager!.deleteAll();
      await _circleManager!.create(CircleAnnotationOptions(
        geometry: Point(coordinates: Position(pos.longitude, pos.latitude)),
        circleRadius: 8.0,
        circleColor: Colors.teal.toARGB32(),
        circleStrokeWidth: 2.0,
        circleStrokeColor: Colors.white.toARGB32(),
      ));
    } catch (e) {
      debugPrint('Marker error: $e');
    }
  }

  void _recenter() {
    final pos = _userPosition;
    if (pos == null) {
      _requestLocation();
      return;
    }
    _mapboxMap?.flyTo(
      CameraOptions(
        center: Point(coordinates: Position(pos.longitude, pos.latitude)),
        zoom: 6,
      ),
      MapAnimationOptions(duration: 1500),
    );
  }

  // ───────────────────────── Helpers ─────────────────────────

  String _p(int n) => n.toString().padLeft(2, '0');

  String _formatDate(DateTime utcDate) {
    final d = _useLocalTime ? utcDate.toLocal() : utcDate;
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    return '${_p(d.day)} ${months[d.month - 1]}  ${_p(d.hour)}:${_p(d.minute)}';
  }

  String _formatTime(DateTime utcDate) {
    final d = _useLocalTime ? utcDate.toLocal() : utcDate;
    return '${_p(d.hour)}:${_p(d.minute)}';
  }

  bool _isChannelAvailable(Channel ch) =>
      _availableBands.isEmpty || _availableBands.contains(ch.id);

  // ───────────────────────── Build ─────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // ── Map ──
          MapWidget(
            key: const ValueKey('mapbox-map'),
            styleUri: MapboxStyles.DARK,
            cameraOptions: CameraOptions(
              center: Point(
                coordinates: Position(
                  (_west + _east) / 2,
                  (_north + _south) / 2,
                ),
              ),
              zoom: 4,
            ),
            onMapCreated: _onMapCreated,
            onStyleLoadedListener: _onStyleLoaded,
          ),

          // ── Top controls (hidden during splash) ──
          if (!_showSplash)
          SafeArea(
            child: Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _iconButton(
                      icon: _isRefreshing
                          ? const _SpinningIcon(icon: Icon(Icons.refresh))
                          : const Icon(Icons.refresh),
                      onTap: _isRefreshing ? null : _refresh,
                      tooltip: 'Refresh',
                    ),
                    const SizedBox(height: 8),
                    _iconButton(
                      icon: Icon(
                        Icons.my_location,
                        color: _userPosition != null
                            ? Colors.white
                            : Colors.white38,
                      ),
                      onTap: _recenter,
                      tooltip: 'Recenter',
                    ),
                  ],
                ),
              ),
            ),
          ),

          // ── Loading indicator ──
          if (!_showSplash && _isLoadingLayer)
            Positioned(
              top: MediaQuery.of(context).padding.top + 12,
              left: 12,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.7),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Color(0xFF14b8a6),
                      ),
                    ),
                    SizedBox(width: 8),
                    Text('Loading…',
                        style: TextStyle(color: Colors.white, fontSize: 12)),
                  ],
                ),
              ),
            ),

          // ── Left badge ──
          if (!_showSplash && _timesteps.isNotEmpty)
            Positioned(
              left: 0,
              top: 0,
              bottom: 200,
              child: Align(
                alignment: Alignment.center,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _rotatedBadge(
                      color: const Color(0xFFDC2626),
                      child: Text(
                        'Computed at ${_formatTime(DateTime.fromMillisecondsSinceEpoch(_timesteps[0].fullDate.millisecondsSinceEpoch - 10 * 60 * 1000, isUtc: true))}${_useLocalTime ? '' : ' UTC'}',
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.w500),
                      ),
                    ),
                    const SizedBox(height: 8),
                    _rotatedBadge(
                      color: const Color(0xFF2563EB).withValues(alpha: 0.9),
                      child: const Text(
                        'EUMETSAT data source',
                        style: TextStyle(
                            color: Colors.white,
                            fontSize: 9,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 1),
                      ),
                    ),
                    // Intensity legend (only for rain/thunder)
                    if (_selectedChannel.id == 'lightning' ||
                        _selectedChannel.id == 'radar') ...[
                      const SizedBox(height: 8),
                      _buildInlineLegend(),
                    ],
                  ],
                ),
              ),
            ),

          // ── Right badge ──
          if (!_showSplash)
          Positioned(
            right: 0,
            top: 0,
            bottom: 0,
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  RotatedBox(
                    quarterTurns: 3,
                    child: ShaderMask(
                      shaderCallback: (bounds) => const LinearGradient(
                        colors: [Colors.white, Color(0xFFb2f5ea), Color(0xFF67e8f9)],
                      ).createShader(bounds),
                      child: const Text(
                        'meteolibre.dev',
                        style: TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.bold),
                      ),
                    ),
                  ),
                  if (_timesteps.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    RotatedBox(
                      quarterTurns: 3,
                      child: Text(
                        'Forecast: ${_formatDate(_timesteps[_currentIndex].fullDate)}${_useLocalTime ? '' : ' UTC'}',
                        style: const TextStyle(
                            color: Colors.white, fontSize: 10),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),

          // ── Bottom controls ──
          if (!_showSplash)
          Positioned(
            left: 0,
            right: 0,
            bottom: 24 + MediaQuery.of(context).padding.bottom,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Play + channel selector
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // Play/Pause button
                      GestureDetector(
                        onTap: _togglePlayback,
                        child: Container(
                          width: 48,
                          height: 48,
                          decoration: BoxDecoration(
                            color: _isPlaying
                                ? const Color(0xFFEF4444)
                                : const Color(0xFF14b8a6),
                            shape: BoxShape.circle,
                          ),
                          child: Icon(
                            _isPlaying ? Icons.pause : Icons.play_arrow,
                            color: Colors.white,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),

                      // Channel pills
                      Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(24),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            ...primaryChannels.map((ch) =>
                                _channelPill(ch, onTap: () => setState(() {
                                      _selectedChannel = ch;
                                      _showSecondaryMenu = false;
                                      _updateLayer();
                                    }))),
                            _moreButton(),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),

                  // Timeline box
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.8),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                          color: Colors.white.withValues(alpha: 0.1)),
                    ),
                    child: _buildTimeline(),
                  ),
                ],
              ),
            ),
          ),

          // ── Secondary channel dropdown ──
          if (_showSecondaryMenu) _buildSecondaryMenu(),

          // ── In-app splash ──
          if (_showSplash)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black,
                child: AnimatedOpacity(
                  opacity: _showSplash ? 1.0 : 0.0,
                  duration: const Duration(milliseconds: 400),
                  child: Image.asset(
                    'assets/splash.png',
                    fit: BoxFit.cover,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTimeline() {
    if (_isScanning) {
      return const Center(
        child: Text('Scanning for available timesteps…',
            style: TextStyle(color: Color(0xFF14b8a6), fontSize: 13)),
      );
    }
    if (_timesteps.isEmpty) {
      return const Center(
        child: Text('No timesteps available',
            style: TextStyle(color: Color(0xFFEF4444), fontSize: 13)),
      );
    }

    final first = _timesteps.first.fullDate;
    final last = _timesteps.last.fullDate;
    final current = _timesteps[_currentIndex].fullDate;

    return Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(_formatTime(first),
                style:
                    const TextStyle(color: Colors.white54, fontSize: 11)),
            Column(
              children: [
                Text(
                  _formatDate(current),
                  style: const TextStyle(
                      color: Color(0xFF14b8a6),
                      fontSize: 17,
                      fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    const Text('UTC',
                        style:
                            TextStyle(color: Colors.white38, fontSize: 10)),
                    const SizedBox(width: 6),
                    GestureDetector(
                      onTap: () =>
                          setState(() => _useLocalTime = !_useLocalTime),
                      child: Container(
                        width: 36,
                        height: 20,
                        decoration: BoxDecoration(
                          color: _useLocalTime
                              ? const Color(0xFF14b8a6)
                              : Colors.white24,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: AnimatedAlign(
                          duration: const Duration(milliseconds: 200),
                          alignment: _useLocalTime
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: Container(
                            width: 16,
                            height: 16,
                            margin: const EdgeInsets.symmetric(horizontal: 2),
                            decoration: const BoxDecoration(
                              color: Colors.white,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text('Local',
                        style: TextStyle(
                            color: _useLocalTime
                                ? const Color(0xFF14b8a6)
                                : Colors.white38,
                            fontSize: 10)),
                  ],
                ),
              ],
            ),
            Text(_formatTime(last),
                style:
                    const TextStyle(color: Colors.white54, fontSize: 11)),
          ],
        ),
        const SizedBox(height: 10),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            activeTrackColor: const Color(0xFF14b8a6),
            inactiveTrackColor: Colors.white24,
            thumbColor: const Color(0xFF14b8a6),
            overlayColor: const Color(0x2914b8a6),
            thumbShape:
                const RoundSliderThumbShape(enabledThumbRadius: 12),
            trackHeight: 6,
          ),
          child: Slider(
            min: 0,
            max: (_timesteps.length - 1).toDouble(),
            divisions: _timesteps.length - 1,
            value: _currentIndex.toDouble(),
            onChanged: (v) {
              final idx = v.round();
              if (idx != _currentIndex) {
                setState(() => _currentIndex = idx);
              }
            },
            onChangeEnd: (v) {
              _updateLayer();
            },
          ),
        ),
      ],
    );
  }

  Color _channelSelectedColor(Channel ch) {
    if (ch.id == 'lightning') return const Color(0xFFEAB308); // yellow
    if (ch.id == 'radar') return const Color(0xFF2563EB);     // blue
    return const Color(0xFF14b8a6);                           // teal fallback
  }

  Widget _channelPill(Channel ch, {required VoidCallback onTap}) {
    final isSelected = _selectedChannel.id == ch.id;
    final isAvailable = _isChannelAvailable(ch);
    return GestureDetector(
      onTap: isAvailable ? onTap : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: isSelected ? _channelSelectedColor(ch) : Colors.black,
          borderRadius: BorderRadius.circular(20),
        ),
        child: _channelPillContent(ch, isAvailable, isSelected),
      ),
    );
  }

  Widget _channelPillContent(Channel ch, bool isAvailable, bool isSelected) {
    final color = isAvailable ? Colors.white : Colors.white38;
    if (ch.id == 'lightning') {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.bolt_outlined, color: color, size: 18),
          if (isSelected) ...[
            const SizedBox(width: 6),
            Text(ch.label,
                style: TextStyle(
                    color: color, fontSize: 13, fontWeight: FontWeight.w500)),
          ],
        ],
      );
    } else if (ch.id == 'radar') {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.grain, color: color, size: 18),
          if (isSelected) ...[
            const SizedBox(width: 6),
            Text(ch.label,
                style: TextStyle(
                    color: color, fontSize: 13, fontWeight: FontWeight.w500)),
          ],
        ],
      );
    }
    return Text(
      ch.label,
      style: TextStyle(color: color, fontSize: 13, fontWeight: FontWeight.w500),
    );
  }

  Widget _moreButton() {
    return GestureDetector(
      onTap: () => setState(() => _showSecondaryMenu = !_showSecondaryMenu),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: _showSecondaryMenu
              ? const Color(0xFF14b8a6)
              : Colors.black,
          borderRadius: BorderRadius.circular(20),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.add, size: 14, color: Colors.white),
            SizedBox(width: 4),
            Text('More',
                style: TextStyle(color: Colors.white, fontSize: 13)),
          ],
        ),
      ),
    );
  }

  Widget _buildSecondaryMenu() {
    return Positioned(
      bottom: 180 + MediaQuery.of(context).padding.bottom,
      left: 0,
      right: 0,
      child: Center(
        child: GestureDetector(
          onTap: () {}, // prevent tap-through
          child: Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.9),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.white12),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: secondaryChannels.map((ch) {
                final isAvailable = _isChannelAvailable(ch);
                return GestureDetector(
                  onTap: isAvailable
                      ? () => setState(() {
                            _selectedChannel = ch;
                            _showSecondaryMenu = false;
                            _updateLayer();
                          })
                      : null,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 20, vertical: 10),
                    child: Text(
                      ch.label,
                      style: TextStyle(
                        color: _selectedChannel.id == ch.id
                            ? const Color(0xFF14b8a6)
                            : isAvailable
                                ? Colors.white
                                : Colors.white38,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildInlineLegend() {
    final isRain = _selectedChannel.id == 'radar';
    final gradientColors = isRain
        ? const [
            Color(0x0004E200), // transparent green (light)
            Color(0xFF01A501), // green
            Color(0xFFFFF700), // yellow
            Color(0xFFFF9000), // orange
            Color(0xFFFF0000), // red
            Color(0xFFD70000), // dark red (heavy)
          ]
        : const [
            Color(0x00FFFF00), // transparent yellow (low)
            Color(0xFFFFFF00), // yellow
            Color(0xFFFFA500), // orange
            Color(0xFFFF4500), // orange-red
            Color(0xFFFF0000), // red
            Color(0xFF8B0000), // dark red (high)
          ];
    final label = isRain ? 'Rain' : 'Thunder';

    return RotatedBox(
      quarterTurns: 3,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.8),
          borderRadius: const BorderRadius.only(
            bottomLeft: Radius.circular(6),
            bottomRight: Radius.circular(6),
          ),
          border: Border.all(color: Colors.white.withValues(alpha: 0.15)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: const TextStyle(
                  color: Colors.white, fontSize: 9, fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: 6),
            // Horizontal gradient bar (will be rotated vertical)
            ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: Container(
                width: 120,
                height: 12,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.centerLeft,
                    end: Alignment.centerRight,
                    colors: gradientColors,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
            const Text('Low',
                style: TextStyle(color: Colors.white54, fontSize: 8)),
            const Text(' → ',
                style: TextStyle(color: Colors.white38, fontSize: 8)),
            const Text('High',
                style: TextStyle(color: Colors.white70, fontSize: 8)),
          ],
        ),
      ),
    );
  }

  Widget _iconButton({
    required Widget icon,
    VoidCallback? onTap,
    required String tooltip,
  }) {
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.7),
            shape: BoxShape.circle,
          ),
          child: Center(child: icon),
        ),
      ),
    );
  }

  Widget _rotatedBadge({required Color color, required Widget child}) {
    return RotatedBox(
      quarterTurns: 3,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: color,
          borderRadius: const BorderRadius.only(
            bottomLeft: Radius.circular(6),
            bottomRight: Radius.circular(6),
          ),
        ),
        child: child,
      ),
    );
  }
}

class _SpinningIcon extends StatefulWidget {
  final Widget icon;
  const _SpinningIcon({required this.icon});

  @override
  State<_SpinningIcon> createState() => _SpinningIconState();
}

class _SpinningIconState extends State<_SpinningIcon>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
        vsync: this, duration: const Duration(seconds: 1))
      ..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RotationTransition(
      turns: _ctrl,
      child: widget.icon,
    );
  }
}
