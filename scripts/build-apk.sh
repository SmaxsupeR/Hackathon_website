#!/usr/bin/env bash
# Builds a release APK (signed with the debug key) into ./build/namu.apk
# Needs: JDK 17 + 21, Android SDK (ANDROID_HOME), Node.
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
ARCHS="${ARCHS:-arm64-v8a,armeabi-v7a}"

[ -d android ] || npx expo prebuild --platform android --no-install

# Maven Central sometimes answers 429; retry a few times.
for attempt in 1 2 3 4; do
  if (cd android && ./gradlew assembleRelease -PreactNativeArchitectures="$ARCHS" --console=plain); then
    mkdir -p build
    cp android/app/build/outputs/apk/release/app-release.apk build/namu.apk
    ls -la build/namu.apk
    exit 0
  fi
  echo "Build attempt $attempt failed, retrying in 60s..." >&2
  sleep 60
done
exit 1
