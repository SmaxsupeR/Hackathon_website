#!/usr/bin/env bash
# Builds the experimental TTS lab APK into ./build/namu-tts-lab.apk (signed with the debug key).
# Separate app id (app.namu.ttslab): it installs next to the main app and does not change it.
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
ARCHS="${ARCHS:-arm64-v8a,armeabi-v7a}"
[ -d android ] || npx expo prebuild --platform android --no-install
for attempt in 1 2 3; do
  if (cd android && ./gradlew assembleRelease -PreactNativeArchitectures="$ARCHS" --console=plain); then
    mkdir -p build
    cp android/app/build/outputs/apk/release/app-release.apk build/namu-tts-lab.apk
    ls -la build/namu-tts-lab.apk
    exit 0
  fi
  echo "Build attempt $attempt failed, retrying in 60s..." >&2
  sleep 60
done
exit 1
