import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

const _serverUrl =
    'https://lightning-server-v2-935480850831.europe-west3.run.app';

const _baseBucketUrl =
    'https://storage.googleapis.com/inference_result/forecasts';

Future<({List<Timestep> timesteps, List<String> availableBands})>
    fetchAvailableTimesteps({int maxTimesteps = 18}) async {
  final uri = Uri.parse('$_serverUrl/available?days=2&band=lightning');
  final response = await http.get(uri);

  if (response.statusCode != 200) {
    throw Exception('Failed to fetch timesteps: ${response.statusCode}');
  }

  final data = jsonDecode(response.body) as Map<String, dynamic>;
  final allBands = List<String>.from(data['all_bands'] ?? []);
  final rawTimesteps = data['timestamps'] as List<dynamic>? ?? [];

  final timesteps = rawTimesteps.map((ts) {
    final ft = ts['timestamp'] as String;
    final year = int.parse(ft.substring(0, 4));
    final month = int.parse(ft.substring(4, 6));
    final day = int.parse(ft.substring(6, 8));
    final hour = int.parse(ft.substring(8, 10));
    final minute = int.parse(ft.substring(10, 12));

    return Timestep(
      dateFolder: ts['date_folder'] as String,
      filenameTime: ft,
      fullDate: DateTime.utc(year, month, day, hour, minute),
      availableBands: List<String>.from(ts['available_bands'] ?? []),
    );
  }).toList()
    ..sort((a, b) => a.fullDate.compareTo(b.fullDate));

  final sliced = timesteps.length > maxTimesteps
      ? timesteps.sublist(timesteps.length - maxTimesteps)
      : timesteps;

  return (timesteps: sliced, availableBands: allBands);
}

String tileUrl(Timestep step, String channelId) =>
    '$_serverUrl/tiles/{z}/{x}/{y}.png?band=$channelId&time=${step.filenameTime}';

String boundsUrl(Timestep step, String channelId) =>
    '$_serverUrl/bounds?band=$channelId&time=${step.filenameTime}';

String tiffUrl(Timestep step, String channelId) =>
    '$_baseBucketUrl/${step.dateFolder}/forecast_${step.filenameTime}_$channelId.tiff';
