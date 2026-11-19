// Voice packs for the lab: the original model downloaded from Hugging Face (pinned to one
// commit and checked by SHA-256), or a compressed pack imported from a .zip file.
import { Directory, File, Paths } from 'expo-file-system';
import { OnnxTts } from '../modules/onnx-tts';

export interface PackFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PackInfo {
  id: string;
  name: string;
  files: PackFile[];
  /** Expand weight-only quantized weights at load (fast mode) by default. */
  quantizedWeights: boolean;
  source: string;
}

const COMMIT = '3cadd1ee6394adea1bd021217a0e650ede09a323';
export const HF_BASE = `https://huggingface.co/Supertone/supertonic-3/resolve/${COMMIT}/`;

const VOICES: [string, string, number][] = [
  ['F1', 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2', 292046],
  ['F2', '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6', 292423],
  ['F3', '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab', 290794],
  ['F4', 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b', 291808],
  ['F5', '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d', 291479],
  ['M1', 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b', 291748],
  ['M2', 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50', 292055],
  ['M3', 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b', 290198],
  ['M4', 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303', 291522],
  ['M5', 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2', 291469],
];

export const ORIGINAL: PackInfo = {
  id: 'original-fp32',
  name: 'Оригинал FP32 (Hugging Face)',
  quantizedWeights: false,
  source: HF_BASE,
  files: [
    { path: 'LICENSE', sha256: '0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f', size: 15007 },
    { path: 'onnx/tts.json', sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09', size: 8253 },
    { path: 'onnx/unicode_indexer.json', sha256: '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f', size: 277676 },
    { path: 'onnx/duration_predictor.onnx', sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db', size: 3700147 },
    { path: 'onnx/text_encoder.onnx', sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff', size: 36416150 },
    { path: 'onnx/vector_estimator.onnx', sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c', size: 256534781 },
    { path: 'onnx/vocoder.onnx', sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba', size: 101424195 },
    ...VOICES.map(([v, sha256, size]) => ({ path: `voice_styles/${v}.json`, sha256, size })),
  ],
};

export const packsDir = () => new Directory(Paths.document, 'voice-packs');
export const packDir = (id: string) => new Directory(packsDir(), id);
const plainPath = (uri: string) => uri.replace(/^file:\/\//, '');

export function packSize(p: PackInfo): number {
  return p.files.reduce((n, f) => n + f.size, 0);
}

/** Packs present on the device (original and imported). */
export function installedPacks(): PackInfo[] {
  const root = packsDir();
  if (!root.exists) return [];
  const out: PackInfo[] = [];
  for (const item of root.list()) {
    if (!(item instanceof Directory)) continue;
    const manifest = new File(item, 'manifest.json');
    if (manifest.exists) {
      try {
        out.push(JSON.parse(manifest.textSync()) as PackInfo);
      } catch {
        // A broken manifest: the pack is shown as missing and can be deleted or re-imported.
      }
    }
  }
  return out;
}

export interface Integrity {
  ok: boolean;
  missing: string[];
  corrupt: string[];
}

/** Checks every file of a pack: present, right size, right SHA-256. */
export async function verifyPack(p: PackInfo, onFile?: (path: string) => void): Promise<Integrity> {
  const res: Integrity = { ok: true, missing: [], corrupt: [] };
  for (const f of p.files) {
    onFile?.(f.path);
    const file = new File(packDir(p.id), f.path);
    if (!file.exists) {
      res.missing.push(f.path);
      continue;
    }
    if (file.size !== f.size || (await OnnxTts.sha256(plainPath(file.uri))) !== f.sha256) res.corrupt.push(f.path);
  }
  res.ok = res.missing.length === 0 && res.corrupt.length === 0;
  return res;
}

export interface Progress {
  file: string;
  done: number;
  total: number;
}

/** Catalog of Namu voice packs on GitHub (github.com/SmaxsupeR/namu-voices). */
export const VOICES_INDEX = 'https://raw.githubusercontent.com/SmaxsupeR/namu-voices/main/index.json';

export interface CatalogPack {
  id: string;
  version: number;
  name: string;
  path: string;
  manifest: string;
  size: number;
  ref: string;
  /** Where this pack's files live: base URL of the commit that published it. */
  base: string;
}

/** Packs offered in the catalog. Needs internet; returns an empty list offline. */
export async function fetchCatalog(): Promise<CatalogPack[]> {
  const res = await fetch(VOICES_INDEX);
  if (!res.ok) throw new Error(`Каталог недоступен: HTTP ${res.status}`);
  const idx = (await res.json()) as { baseUrl: string; packs: Omit<CatalogPack, 'base'>[] };
  return idx.packs.map((p) => ({ ...p, base: `${idx.baseUrl.replace('{ref}', p.ref)}${p.path}/` }));
}

/** Downloads a catalog pack: its manifest first, then every file, each checked by SHA-256. */
export async function downloadCatalogPack(c: CatalogPack, onProgress: (p: Progress) => void, shouldStop: () => boolean): Promise<Integrity> {
  const res = await fetch(`${c.base}manifest.json`);
  if (!res.ok) throw new Error(`Манифест недоступен: HTTP ${res.status}`);
  const info = (await res.json()) as PackInfo;
  if (info.id !== c.id) throw new Error('Манифест не совпадает с каталогом');
  return downloadPack(info, c.base, onProgress, shouldStop);
}

/** Downloads the original model from Hugging Face. */
export function downloadOriginal(onProgress: (p: Progress) => void, shouldStop: () => boolean): Promise<Integrity> {
  return downloadPack(ORIGINAL, HF_BASE, onProgress, shouldStop);
}

/**
 * Downloads a pack file by file. Files already complete (right size and hash) are skipped,
 * so an interrupted download continues where it stopped.
 */
export async function downloadPack(p: PackInfo, base: string, onProgress: (p: Progress) => void, shouldStop: () => boolean): Promise<Integrity> {
  const dir = packDir(p.id);
  dir.create({ intermediates: true, idempotent: true });
  const total = packSize(p);
  let done = 0;
  for (const f of p.files) {
    if (shouldStop()) break;
    const file = new File(dir, f.path);
    file.parentDirectory.create({ intermediates: true, idempotent: true });
    if (file.exists && file.size === f.size && (await OnnxTts.sha256(plainPath(file.uri))) === f.sha256) {
      done += f.size;
      onProgress({ file: f.path, done, total });
      continue;
    }
    if (file.exists) file.delete();
    const base = done;
    const task = File.createDownloadTask(base + f.path, file, {
      onProgress: ({ bytesWritten }) => onProgress({ file: f.path, done: base + bytesWritten, total }),
    });
    await task.downloadAsync();
    done += f.size;
  }
  new File(dir, 'manifest.json').write(JSON.stringify(p));
  return verifyPack(p);
}

/** Imports a pack from a .zip that contains manifest.json next to the model files. */
export async function importPack(zipUri: string): Promise<PackInfo> {
  const tmp = new Directory(Paths.cache, `import-${Date.now()}`);
  tmp.create({ intermediates: true });
  try {
    await OnnxTts.unzip(plainPath(zipUri), plainPath(tmp.uri));
    const manifest = new File(tmp, 'manifest.json');
    if (!manifest.exists) throw new Error('В архиве нет manifest.json');
    const info = JSON.parse(manifest.textSync()) as PackInfo;
    if (!info.id || !Array.isArray(info.files)) throw new Error('manifest.json повреждён');
    const dest = packDir(info.id);
    if (dest.exists) dest.delete();
    packsDir().create({ intermediates: true, idempotent: true });
    tmp.move(packsDir());
    tmp.rename(info.id);
    return info;
  } catch (e) {
    if (tmp.exists) tmp.delete();
    throw e;
  }
}

export function deletePack(id: string) {
  const d = packDir(id);
  if (d.exists) d.delete();
}

export function voicesOf(p: PackInfo): string[] {
  return p.files.filter((f) => f.path.startsWith('voice_styles/')).map((f) => f.path.slice('voice_styles/'.length, -'.json'.length));
}

export function packPath(id: string): string {
  return plainPath(packDir(id).uri);
}
