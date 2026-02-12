import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { View, StyleSheet, PanResponder, Animated, LayoutChangeEvent } from 'react-native';
import Svg, { Rect, Circle, Line, LinearGradient, Defs, Stop, G } from 'react-native-svg';
import { Timestep } from '../dataService';

interface RainbowSliderProps {
  data: Timestep[];
  value: number;
  onChange: (index: number) => void;
  forecastValues?: number[];
}

const SIDE_PADDING = 20;
const SLIDER_HEIGHT = 40;
const BAR_MAX_HEIGHT = 20;

const RainbowSlider: React.FC<RainbowSliderProps> = ({
  data,
  value,
  onChange,
  forecastValues,
}) => {
  const [layoutWidth, setLayoutWidth] = useState(0);
  const translateX = useRef(new Animated.Value(0)).current;

  const trackWidth = useMemo(() => Math.max(0, layoutWidth - 2 * SIDE_PADDING), [layoutWidth]);
  const stepSize = useMemo(() => (data.length > 1 ? trackWidth / (data.length - 1) : 0), [data.length, trackWidth]);

  // Use refs to avoid stale closures in PanResponder
  const trackWidthRef = useRef(trackWidth);
  const stepSizeRef = useRef(stepSize);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    trackWidthRef.current = trackWidth;
    stepSizeRef.current = stepSize;
  }, [trackWidth, stepSize]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Sync animated value with prop value
  useEffect(() => {
    if (stepSize > 0) {
      translateX.setValue(value * stepSize);
    }
  }, [value, stepSize]);

  const onLayout = (event: LayoutChangeEvent) => {
    setLayoutWidth(event.nativeEvent.layout.width);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: (evt) => {
        if (stepSizeRef.current <= 0) return;
        const x = Math.max(0, Math.min(trackWidthRef.current, evt.nativeEvent.locationX - SIDE_PADDING));
        const index = Math.round(x / stepSizeRef.current);
        if (!isNaN(index) && isFinite(index)) {
          onChangeRef.current(index);
        }
      },
      onPanResponderMove: (evt) => {
        if (stepSizeRef.current <= 0) return;
        const x = Math.max(0, Math.min(trackWidthRef.current, evt.nativeEvent.locationX - SIDE_PADDING));
        const index = Math.round(x / stepSizeRef.current);
        if (!isNaN(index) && isFinite(index)) {
          onChangeRef.current(index);
        }
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    })
  ).current;

  const renderIntensityBars = () => {
    if (!forecastValues || forecastValues.length === 0 || stepSize === 0) return null;

    const maxValue = Math.max(...forecastValues, 1);

    return forecastValues.map((val, i) => {
      if (i >= data.length) return null;
      const barHeight = (val / maxValue) * BAR_MAX_HEIGHT;
      const x = i * stepSize;

      return (
        <Rect
          key={i}
          x={x}
          y={SLIDER_HEIGHT - barHeight}
          width={2}
          height={barHeight}
          fill="white"
          opacity={0.5}
          rx={1}
        />
      );
    });
  };

  return (
    <View
      style={styles.container}
      onLayout={onLayout}
      {...panResponder.panHandlers}
      collapsable={false}
    >
      <Svg height={SLIDER_HEIGHT} width={layoutWidth} pointerEvents="none">
        <Defs>
          <LinearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#8b5cf6" stopOpacity="1" />
            <Stop offset="0.5" stopColor="#3b82f6" stopOpacity="1" />
            <Stop offset="1" stopColor="#2dd4bf" stopOpacity="1" />
          </LinearGradient>
        </Defs>

        <G x={SIDE_PADDING}>
          {/* Background Track */}
          <Rect
            x={0}
            y={SLIDER_HEIGHT / 2 - 4}
            width={trackWidth}
            height={8}
            rx={4}
            fill="url(#grad)"
            opacity={0.3}
          />

          {/* Intensity Bars */}
          {renderIntensityBars()}

          {/* Scrubber */}
          <AnimatedLine
            x1={translateX}
            y1={0}
            x2={translateX}
            y2={SLIDER_HEIGHT}
            stroke="white"
            strokeWidth={2}
          />
          <AnimatedCircle
            cx={translateX}
            cy={SLIDER_HEIGHT / 2}
            r={10}
            fill="white"
            stroke="#007AFF"
            strokeWidth={2}
          />
        </G>
      </Svg>
    </View>
  );
};

const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: SLIDER_HEIGHT,
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
});

export default RainbowSlider;
