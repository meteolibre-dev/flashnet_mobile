import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';
import 'forecast_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // Pass your Mapbox token at build time:
  //   flutter run --dart-define=MAPBOX_TOKEN=pk.eyJ1...
  const token = String.fromEnvironment(
    'MAPBOX_TOKEN',
    defaultValue: 'pk.eyJ1IjoiYWRyaWVuYnVmb3J0IiwiYSI6ImNta283bDZvYzA0MHMzZXFyMWZ2Nm8yazAifQ.X0pxUQsHOyd4INio6_BiKA',
  );
  MapboxOptions.setAccessToken(token);

  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
  ));

  runApp(const FlashNetApp());
}

class FlashNetApp extends StatelessWidget {
  const FlashNetApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FlashNet',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: Colors.black,
        colorScheme: const ColorScheme.dark(primary: Color(0xFF14b8a6)),
      ),
      home: const ForecastScreen(),
    );
  }
}
