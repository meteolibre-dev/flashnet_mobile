const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Prefer browser entry points for libraries that support it (fixes web-worker/geotiff)
config.resolver.unstable_conditionNames = ['browser', 'require', 'react-native'];

module.exports = config;
