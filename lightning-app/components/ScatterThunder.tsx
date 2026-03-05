import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { THUNDER_COLORS } from './ThunderLegend';

interface ThunderIconProps {
  size?: number;
  color?: string;
  style?: object;
}

const ThunderIcon: React.FC<ThunderIconProps> = ({ size = 20, color = '#fbbf24', style }) => (
  <View style={style}>
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
        fill={color}
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </Svg>
  </View>
);

interface ScatterThunderProps {
  count?: number;
}

// Fixed positions for scattered thunder icons (as percentages)
const SCATTER_POSITIONS = [
  { x: 5, y: 8, i: 2, s: 14 },
  { x: 12, y: 15, i: 3, s: 18 },
  { x: 20, y: 10, i: 1, s: 12 },
  { x: 28, y: 18, i: 4, s: 20 },
  { x: 35, y: 12, i: 2, s: 14 },
  { x: 42, y: 20, i: 3, s: 16 },
  { x: 50, y: 8, i: 1, s: 12 },
  { x: 58, y: 15, i: 2, s: 14 },
  { x: 65, y: 22, i: 3, s: 18 },
  { x: 72, y: 10, i: 1, s: 12 },
  { x: 80, y: 18, i: 2, s: 14 },
  { x: 88, y: 25, i: 3, s: 16 },
  { x: 8, y: 30, i: 2, s: 14 },
  { x: 15, y: 38, i: 4, s: 22 },
  { x: 25, y: 32, i: 1, s: 12 },
  { x: 32, y: 40, i: 3, s: 18 },
  { x: 42, y: 35, i: 2, s: 14 },
  { x: 52, y: 42, i: 1, s: 12 },
  { x: 60, y: 38, i: 4, s: 20 },
  { x: 68, y: 32, i: 2, s: 14 },
  { x: 78, y: 40, i: 3, s: 18 },
  { x: 85, y: 30, i: 1, s: 12 },
  { x: 10, y: 50, i: 2, s: 14 },
  { x: 18, y: 55, i: 3, s: 16 },
  { x: 28, y: 48, i: 1, s: 12 },
  { x: 35, y: 58, i: 4, s: 22 },
  { x: 45, y: 52, i: 2, s: 14 },
  { x: 55, y: 60, i: 3, s: 18 },
  { x: 62, y: 50, i: 1, s: 12 },
  { x: 72, y: 55, i: 2, s: 14 },
  { x: 82, y: 48, i: 4, s: 20 },
  { x: 15, y: 68, i: 2, s: 14 },
  { x: 22, y: 72, i: 3, s: 16 },
  { x: 32, y: 65, i: 1, s: 12 },
  { x: 40, y: 75, i: 2, s: 14 },
  { x: 50, y: 70, i: 4, s: 22 },
  { x: 58, y: 78, i: 3, s: 18 },
  { x: 68, y: 68, i: 1, s: 12 },
  { x: 75, y: 75, i: 2, s: 14 },
  { x: 85, y: 62, i: 3, s: 16 },
  { x: 20, y: 82, i: 2, s: 14 },
  { x: 30, y: 85, i: 1, s: 12 },
  { x: 42, y: 78, i: 3, s: 16 },
  { x: 52, y: 88, i: 4, s: 20 },
  { x: 62, y: 80, i: 2, s: 14 },
  { x: 72, y: 85, i: 1, s: 12 },
  { x: 80, y: 75, i: 2, s: 14 },
];

const ScatterThunder: React.FC<ScatterThunderProps> = () => {
  return (
    <View style={styles.container} pointerEvents="none">
      {SCATTER_POSITIONS.map((pos, index) => (
        <View
          key={index}
          style={[
            styles.iconContainer,
            {
              left: `${pos.x}%`,
              top: `${pos.y}%`,
            },
          ]}
        >
          <ThunderIcon
            size={pos.s}
            color={THUNDER_COLORS[pos.i]}
          />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  iconContainer: {
    position: 'absolute',
  },
});

export default ScatterThunder;
