import React from 'react';
import { TouchableOpacity, StyleSheet, Text } from 'react-native';
import Svg, { Circle, Path, G, Text as SvgText } from 'react-native-svg';

interface PlayButtonProps {
  isPlaying: boolean;
  isDownloading: boolean;
  progress: number; // 0 to 1
  onPress: () => void;
  size?: number;
}

const PlayButton: React.FC<PlayButtonProps> = ({
  isPlaying,
  isDownloading,
  progress,
  onPress,
  size = 50,
}) => {
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);
  const center = size / 2;
  const iconScale = size / 50; // Scale icons based on button size

  // Play icon path (centered triangle)
  const renderPlayIcon = () => (
    <Path
      d={`M${center - 5 * iconScale},${center - 8 * iconScale} L${center - 5 * iconScale},${center + 8 * iconScale} L${center + 8 * iconScale},${center} Z`}
      fill="white"
    />
  );

  // Pause icon (two vertical bars)
  const renderPauseIcon = () => (
    <>
      <Path
        d={`M${center - 6 * iconScale},${center - 7 * iconScale} L${center - 6 * iconScale},${center + 7 * iconScale} L${center - 2 * iconScale},${center + 7 * iconScale} L${center - 2 * iconScale},${center - 7 * iconScale} Z`}
        fill="white"
      />
      <Path
        d={`M${center + 2 * iconScale},${center - 7 * iconScale} L${center + 2 * iconScale},${center + 7 * iconScale} L${center + 6 * iconScale},${center + 7 * iconScale} L${center + 6 * iconScale},${center - 7 * iconScale} Z`}
        fill="white"
      />
    </>
  );

  // Download/spinner state
  const renderContent = () => {
    if (isDownloading) {
      // Show percentage text during download using SVG Text
      const percentage = Math.round(progress * 100);
      return (
        <SvgText
          x={center - 2}
          y={center}
          fill="white"
          fontSize={Math.round(12 * iconScale)}
          fontWeight="bold"
          textAnchor="middle"
          alignmentBaseline="central"
        >
          {percentage}%
        </SvgText>
      );
    }
    return isPlaying ? renderPauseIcon() : renderPlayIcon();
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.container, { width: size, height: size }]}
      activeOpacity={0.7}
    >
      <Svg width={size} height={size}>
        {/* Background circle */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="rgba(0,0,0,0.8)"
          stroke="#444"
          strokeWidth={1}
        />

        {/* Progress ring */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#007AFF"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          origin={`${center}, ${center}`}
          rotation={-90}
        />

        {/* Icon */}
        {renderContent()}
      </Svg>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default PlayButton;
