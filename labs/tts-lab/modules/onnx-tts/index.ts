import { requireNativeModule } from 'expo-modules-core';

export interface Memory {
  rssMb: number;
  peakMb: number;
  nativeHeapMb: number;
}

export interface DeviceInfo {
  manufacturer: string;
  model: string;
  android: string;
  sdk: number;
  soc: string;
  abis: string;
  cores: number;
  totalRamMb: number;
  availRamMb: number;
  lowRamDevice: boolean;
  ortVersion: string;
}

export interface LoadResult {
  loadMs: number;
  before: Memory;
  after: Memory;
  peakReset: boolean;
}

export interface SynthResult {
  dpMs: number;
  encoderMs: number;
  flowMs: number;
  vocoderMs: number;
  totalMs: number;
  audioSec: number;
  playbackStartMs: number | null;
  memory: Memory;
}

interface OnnxTtsNative {
  deviceInfo(): Promise<DeviceInfo>;
  memory(): Promise<Memory>;
  sha256(file: string): Promise<string>;
  unzip(zip: string, dest: string): Promise<number>;
  load(dir: string, threads: number, foldWeights: boolean): Promise<LoadResult>;
  synth(text: string, voice: string, steps: number, speed: number, seed: number, play: boolean): Promise<SynthResult>;
  synthToFile(text: string, voice: string, steps: number, speed: number, seed: number, out: string): Promise<number>;
  release(): Promise<Memory>;
}

export const OnnxTts = requireNativeModule<OnnxTtsNative>('OnnxTts');
