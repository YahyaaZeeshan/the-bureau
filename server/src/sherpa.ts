/**
 * Sherpa-ONNX integration — local speech recognition with speaker diarization.
 *
 * Pipeline for a recorded meeting:
 *   1. ffmpeg transcodes browser WebM/Opus → 16 kHz mono WAV
 *   2. OfflineSpeakerDiarization splits the audio into speaker-labelled segments
 *   3. Whisper (multilingual base) transcribes each segment
 *   4. We return [{ speaker, start, end, text }] for the UI + LLM formatter
 *
 * Models are downloaded lazily on first use to data/sherpa-models/ (~250 MB
 * total, multilingual coverage including Urdu + Hindi). Subsequent runs read
 * straight from disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { DATA_DIR } from './config.js';

// sherpa-onnx-node is a CJS native binding — load it via createRequire since
// our server runs as ESM.
const req = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sherpa: any = null;
function sherpa(): any {
  if (!_sherpa) _sherpa = req('sherpa-onnx-node');
  return _sherpa;
}

export const MODELS_DIR = path.join(DATA_DIR, 'sherpa-models');

// ── model registry ──────────────────────────────────────────────────────
// Each entry: where it lives on disk, where to download it from, and how to
// recognize it (a sentinel file under the model dir indicates "fully extracted").
const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

interface ModelSpec {
  /** Sub-folder under data/sherpa-models/ where files end up. */
  dir: string;
  /** Archive URL (a .tar.bz2 or .onnx). */
  url: string;
  /** A path that EXISTS once the model is ready (sentinel). */
  sentinel: string;
  /** If true the URL is a tarball that needs extraction; else it's a single file. */
  archive?: 'tar.bz2';
}

const MODELS: Record<string, ModelSpec> = {
  whisper: {
    dir: 'sherpa-onnx-whisper-base',
    url: `${RELEASE}/asr-models/sherpa-onnx-whisper-base.tar.bz2`,
    sentinel: 'base-encoder.int8.onnx',
    archive: 'tar.bz2',
  },
  segmentation: {
    dir: 'sherpa-onnx-pyannote-segmentation-3-0',
    url: `${RELEASE}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    sentinel: 'model.onnx',
    archive: 'tar.bz2',
  },
  embedding: {
    dir: '.',
    url: `${RELEASE}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`,
    sentinel: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  },
  vad: {
    dir: '.',
    url: `${RELEASE}/asr-models/silero_vad.onnx`,
    sentinel: 'silero_vad.onnx',
  },
};

function modelPath(name: keyof typeof MODELS, file?: string): string {
  const m = MODELS[name];
  const base = path.join(MODELS_DIR, m.dir);
  return file ? path.join(base, file) : path.join(base, m.sentinel);
}

function modelReady(name: keyof typeof MODELS): boolean {
  return fs.existsSync(modelPath(name));
}

export function modelsStatus(): Record<string, boolean> {
  return Object.fromEntries(Object.keys(MODELS).map((k) => [k, modelReady(k as keyof typeof MODELS)]));
}

/** Find a binary on PATH or in known install dirs. Returns absolute path or null. */
function findBinary(name: string): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name + ext], { encoding: 'utf8' });
  const found = (r.stdout || '').split(/\r?\n/).find((l) => l.trim());
  return found ? found.trim() : null;
}

const FFMPEG_BIN = findBinary('ffmpeg');

// ── model download + extract ────────────────────────────────────────────
async function downloadFile(url: string, dest: string, onProgress?: (got: number, total: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const file = fs.createWriteStream(dest);
  const body = res.body!;
  const reader = (body as unknown as ReadableStream<Uint8Array>).getReader();
  const node = new Readable({
    read() {
      reader.read().then(({ done, value }) => {
        if (done) return this.push(null);
        got += value!.byteLength;
        onProgress?.(got, total);
        this.push(Buffer.from(value!));
      }).catch((e) => this.destroy(e));
    },
  });
  await pipeline(node, file);
}

/** Extract a .tar.bz2 using a portable subprocess (tar handles bz2 on modern systems). */
async function extractTarBz2(archive: string, outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  // Modern tar (bsdtar on macOS/Windows, GNU tar on Linux) handles -xjf bz2 natively.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', outDir, '--strip-components=1'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
  });
}

let _downloading = false;
let _downloadProgress = { stage: '', got: 0, total: 0 };
export function downloadStatus() {
  return { downloading: _downloading, ..._downloadProgress };
}

/** Ensure all models are on disk. Idempotent + serializable (one concurrent run). */
export async function ensureModels(onProgress?: (stage: string, got: number, total: number) => void): Promise<void> {
  if (_downloading) {
    while (_downloading) await new Promise((r) => setTimeout(r, 500));
    return;
  }
  _downloading = true;
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    for (const [name, spec] of Object.entries(MODELS)) {
      if (modelReady(name as keyof typeof MODELS)) continue;
      const stage = `downloading ${name}`;
      _downloadProgress = { stage, got: 0, total: 0 };
      onProgress?.(stage, 0, 0);
      if (spec.archive === 'tar.bz2') {
        const archive = path.join(MODELS_DIR, `${spec.dir}.tar.bz2`);
        await downloadFile(spec.url, archive, (g, t) => {
          _downloadProgress = { stage, got: g, total: t };
          onProgress?.(stage, g, t);
        });
        await extractTarBz2(archive, path.join(MODELS_DIR, spec.dir));
        fs.rmSync(archive, { force: true });
      } else {
        const dest = path.join(MODELS_DIR, spec.dir, spec.sentinel);
        await downloadFile(spec.url, dest, (g, t) => {
          _downloadProgress = { stage, got: g, total: t };
          onProgress?.(stage, g, t);
        });
      }
    }
    _downloadProgress = { stage: 'ready', got: 0, total: 0 };
  } finally {
    _downloading = false;
  }
}

// ── audio: transcode browser blob → 16 kHz mono WAV via ffmpeg ──────────
export async function transcodeToWav(inputPath: string, outWavPath: string): Promise<void> {
  if (!FFMPEG_BIN) throw new Error('ffmpeg not found on PATH');
  await new Promise<void>((resolve, reject) => {
    const args = ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWavPath];
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 400)}`)));
  });
}

// ── diarized transcription ──────────────────────────────────────────────
export interface DiarizedSegment {
  speaker: string;          // "Speaker A", "Speaker B", ...
  start: number;            // seconds
  end: number;              // seconds
  text: string;
}

const SPEAKER_LABEL = (n: number): string => `Speaker ${String.fromCharCode(65 + n)}`;

// Cached instances — model load is expensive, keep them warm.
let _diarizer: any = null;
let _recognizer: any = null;
const PUNCT_RE_END = /[.!?。！？]\s*$/;

function loadDiarizer(): any {
  if (_diarizer) return _diarizer;
  const cfg = {
    segmentation: {
      pyannote: { model: modelPath('segmentation', 'model.onnx') },
    },
    embedding: { model: modelPath('embedding') },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  };
  _diarizer = new (sherpa().OfflineSpeakerDiarization)(cfg);
  return _diarizer;
}

function loadRecognizer(): any {
  if (_recognizer) return _recognizer;
  // Shape matches OfflineRecognizerConfig in sherpa-onnx-node/types.js:
  //   { modelConfig: { whisper: {encoder,decoder,language,task}, tokens, numThreads } }
  // `tokens` is on modelConfig (NOT inside the whisper block). Empty language =
  // Whisper auto-detect, covering en + hi + ur in this multilingual base model.
  const cfg = {
    modelConfig: {
      whisper: {
        encoder: modelPath('whisper', 'base-encoder.int8.onnx'),
        decoder: modelPath('whisper', 'base-decoder.int8.onnx'),
        language: '',
        task: 'transcribe',
      },
      tokens: modelPath('whisper', 'base-tokens.txt'),
      numThreads: 2,
    },
  };
  _recognizer = new (sherpa().OfflineRecognizer)(cfg);
  return _recognizer;
}

/** Run the full pipeline on a 16 kHz mono WAV. */
export async function transcribeWav(wavPath: string): Promise<DiarizedSegment[]> {
  await ensureModels();
  const { samples, sampleRate } = sherpa().readWave(wavPath);
  if (sampleRate !== 16000) throw new Error(`expected 16 kHz, got ${sampleRate}`);
  const diarizer = loadDiarizer();
  const recognizer = loadRecognizer();
  // Diarize → list of { start, end, speaker } where speaker is a numeric id.
  const segs = diarizer.process(samples);
  const out: DiarizedSegment[] = [];
  for (const seg of segs) {
    const startIdx = Math.max(0, Math.floor(seg.start * sampleRate));
    const endIdx = Math.min(samples.length, Math.ceil(seg.end * sampleRate));
    if (endIdx - startIdx < 1600) continue; // <100 ms — skip
    const chunk = samples.subarray(startIdx, endIdx);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: chunk });
    recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text || '').trim();
    if (!text) continue;
    out.push({ speaker: SPEAKER_LABEL(seg.speaker), start: seg.start, end: seg.end, text });
  }
  return out;
}

/** Render diarized segments as a chronological transcript ready for the LLM / UI. */
export function formatTranscript(segments: DiarizedSegment[]): string {
  return segments
    .map((s) => `[${fmtTime(s.start)}] ${s.speaker}: ${s.text}${PUNCT_RE_END.test(s.text) ? '' : '.'}`)
    .join('\n');
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
