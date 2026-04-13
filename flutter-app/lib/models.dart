class Timestep {
  final String dateFolder;
  final String filenameTime;
  final DateTime fullDate;
  final List<String> availableBands;

  const Timestep({
    required this.dateFolder,
    required this.filenameTime,
    required this.fullDate,
    required this.availableBands,
  });

  String get label {
    final h = filenameTime.substring(8, 10);
    final m = filenameTime.substring(10, 12);
    return '$h:$m';
  }
}

class Channel {
  final String id;
  final String label;
  final bool isPrimary;

  const Channel({
    required this.id,
    required this.label,
    required this.isPrimary,
  });
}

const primaryChannels = [
  Channel(id: 'lightning', label: 'Thunder', isPrimary: true),
  Channel(id: 'radar', label: 'Rain', isPrimary: true),
];

const secondaryChannels = [
  Channel(id: 'sat_ch0', label: 'VIS', isPrimary: false),
  Channel(id: 'sat_ch1', label: 'IR', isPrimary: false),
];
