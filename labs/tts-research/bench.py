"""Runs one model variant over the test set in its own process.
Usage: bench.py <variant dir> <out dir> <voice> <steps> <threads>
Noise is seeded per text, so every variant starts from the same random latent."""
import json, os, resource, sys, time, zlib
import numpy as np, onnxruntime as ort, soundfile as sf
from supertonic.core import Style, Supertonic, UnicodeProcessor
from supertonic.loader import load_voice_style_from_json_file

vdir, out, voice, steps, threads = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
here = os.path.dirname(os.path.abspath(__file__))
tests = json.load(open(os.path.join(here, 'test_set.json')))
os.makedirs(out, exist_ok=True)

def rss_peak_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

def rss_now_mb():
    with open('/proc/self/status') as f:
        for line in f:
            if line.startswith('VmRSS:'):
                return int(line.split()[1]) / 1024

base_rss = rss_now_mb()
opts = ort.SessionOptions()
opts.intra_op_num_threads = threads
opts.inter_op_num_threads = 1
# Lets ONNX Runtime fold weight-only DequantizeLinear nodes into float32 weights at load time.
opts.add_session_config_entry('session.disable_quant_qdq', '1')
t0 = time.perf_counter()
sess = {}
for p in ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']:
    sess[p] = ort.InferenceSession(os.path.join(vdir, 'onnx', f'{p}.onnx'), opts, providers=['CPUExecutionProvider'])
cfg = json.load(open(os.path.join(vdir, 'onnx', 'tts.json')))
proc = UnicodeProcessor(os.path.join(vdir, 'onnx', 'unicode_indexer.json'))
eng = Supertonic(cfg, proc, sess['duration_predictor'], sess['text_encoder'], sess['vector_estimator'], sess['vocoder'])
style = load_voice_style_from_json_file(os.path.join(vdir, 'voice_styles', f'{voice}.json'))
load_s = time.perf_counter() - t0
rss_loaded = rss_now_mb()

def synth(text, speed=1.0):
    text_ids, text_mask = proc([text], 'ko')
    dur, *_ = sess['duration_predictor'].run(None, {'text_ids': text_ids, 'style_dp': style.dp, 'text_mask': text_mask})
    dur = dur / speed
    emb, *_ = sess['text_encoder'].run(None, {'text_ids': text_ids, 'style_ttl': style.ttl, 'text_mask': text_mask})
    rng = np.random.default_rng(zlib.crc32(text.encode()))
    np.random.seed(zlib.crc32(text.encode()))
    xt, latent_mask = eng.sample_noisy_latent(dur)
    xt = (rng.standard_normal(xt.shape).astype(np.float32)) * latent_mask
    total = np.array([steps], dtype=np.float32)
    for s in range(steps):
        xt, *_ = sess['vector_estimator'].run(None, {'noisy_latent': xt, 'text_emb': emb, 'style_ttl': style.ttl, 'text_mask': text_mask,
                                                      'latent_mask': latent_mask, 'current_step': np.array([s], dtype=np.float32), 'total_step': total})
    wav, *_ = sess['vocoder'].run(None, {'latent': xt})
    n = int(eng.sample_rate * float(dur[0]))
    return wav[0, :n]

results = []
first_latency = None
for rnd in range(3):
    for t in tests:
        a = time.perf_counter()
        wav = synth(t['text'])
        el = time.perf_counter() - a
        if first_latency is None:
            first_latency = el
        audio_s = len(wav) / eng.sample_rate
        if rnd == 0:
            sf.write(os.path.join(out, f"{t['id']}.wav"), wav, eng.sample_rate)
            results.append({'id': t['id'], 'synth_s': [el], 'audio_s': audio_s})
        else:
            results[[r['id'] for r in results].index(t['id'])]['synth_s'].append(el)
    if rnd == 0:
        rss_after_first = rss_now_mb()
rss_end = rss_now_mb()
summary = {
    'variant': os.path.basename(vdir.rstrip('/')), 'voice': voice, 'steps': steps, 'threads': threads,
    'size_mb': round(sum(os.path.getsize(os.path.join(vdir, 'onnx', f'{p}.onnx')) for p in sess) / 1e6, 1),
    'load_s': round(load_s, 2), 'first_request_s': round(first_latency, 3),
    'median_synth_s': round(float(np.median([np.median(r['synth_s']) for r in results])), 3),
    'rtf': round(sum(np.median(r['synth_s']) for r in results) / sum(r['audio_s'] for r in results), 3),
    'rss_base_mb': round(base_rss), 'rss_loaded_mb': round(rss_loaded), 'rss_after_round1_mb': round(rss_after_first),
    'rss_after_round3_mb': round(rss_end), 'rss_peak_mb': round(rss_peak_mb()),
}
json.dump({'summary': summary, 'items': results}, open(os.path.join(out, 'bench.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(summary))
