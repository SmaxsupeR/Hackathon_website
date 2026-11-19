import { NativeModule, requireNativeModule } from 'expo-modules-core';

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

export interface DownloadProgressEvent {
  url: string;
  bytes: number;
  total: number;
}

type OnnxTtsEvents = {
  onDownloadProgress: (e: DownloadProgressEvent) => void;
};

declare class OnnxTtsNative extends NativeModule<OnnxTtsEvents> {
  /** Downloads a file with resume (HTTP Range); resolves with the bytes on disk. */
  download(url: string, dest: string, expectedSize: number): Promise<number>;
  cancelDownload(): void;
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
