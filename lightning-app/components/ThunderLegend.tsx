import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

interface ThunderIconProps {
  size?: number;
  color?: string;
}

// Simple lightning bolt SVG icon
const ThunderIcon: React.FC<ThunderIconProps> = ({ size = 20, color = '#fbbf24' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
      fill={color}
      stroke={color}
      strokeWidth="1"
      strokeLinejoin="round"
    />
  </Svg>
);

// Color scale for intensity (0-4)
export const THUNDER_COLORS = [
  '#6b7280', // 0: No activity - gray
  '#fbbf24', // 1: Low - yellow
  '#f97316', // 2: Medium-Low - orange
  '#ef4444', // 3: Medium-High - red
  '#b91c1c', // 4: High - deep red
];

interface ThunderLegendProps {
  showLabels?: boolean;
  size?: number;
}

const ThunderLegend: React.FC<ThunderLegendProps> = ({ showLabels = true, size = 18 }) => {
  return (
    <View style={styles.container}>
      <View style={styles.iconsRow}>
        {[0, 1, 2, 3, 4].map((level) => (
          <View key={level} style={styles.iconContainer}>
            <ThunderIcon size={size} color={THUNDER_COLORS[level]} />
            {showLabels && (
              <Text style={[styles.label, { color: THUNDER_COLORS[level] }]}>{level}</Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    marginTop: 4,
  },
  iconsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  iconContainer: {
    alignItems: 'center',
    width: 28,
  },
  label: {
    fontSize: 10,
    fontWeight: 'bold',
    marginTop: 2,
  },
});

export default ThunderLegend;
