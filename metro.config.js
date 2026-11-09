const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// expo-sqlite ships a WebAssembly build that is used when the app runs in a browser.
config.resolver.assetExts.push('wasm');

module.exports = config;
