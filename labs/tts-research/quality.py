"""Intelligibility (Whisper) and closeness to the float32 output for every benchmarked variant.
Usage: quality.py <bench root> <whisper model> <variant>..."""
import json, os, re, subprocess, sys
import numpy as np, librosa
from faster_whisper import WhisperModel

root, model_name, variants = sys.argv[1], sys.argv[2], sys.argv[3:]
here = os.path.dirname(os.path.abspath(__file__))
tests = json.load(open(os.path.join(here, 'test_set.json')))
asr = WhisperModel(model_name, device='cpu', compute_type='int8')

def load16(path):
    raw = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', path, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768

def norm(t):
    return re.sub(r'[\s.,!?~·\-]', '', t)

def cer(ref, hyp):
    r, h = list(norm(ref)), list(norm(hyp))
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))

def logmel(path):
    y, sr = librosa.load(path, sr=22050)
    m = librosa.feature.melspectrogram(y=y, sr=sr, n_fft=1024, hop_length=256, n_mels=80)
    return librosa.power_to_db(m + 1e-10)

def mel_distance(a, b):
    """Mean absolute log-mel difference in dB after aligning frames with DTW."""
    _, wp = librosa.sequence.dtw(X=a, Y=b, metric='euclidean')
    return float(np.mean([np.mean(np.abs(a[:, i] - b[:, j])) for i, j in wp]))

ref = {t['id']: logmel(os.path.join(root, 'fp32-F1-s8', f"{t['id']}.wav")) for t in tests}
report = {}
for v in variants:
    rows = []
    for t in tests:
        path = os.path.join(root, v, f"{t['id']}.wav")
        segs, _ = asr.transcribe(load16(path), language='ko', beam_size=5, condition_on_previous_text=False, vad_filter=False)
        hyp = ' '.join(s.text.strip() for s in segs)
        targets = [t['text']] + ([t['say']] if 'say' in t else []) + ([t['pron']] if 'pron' in t else [])
        best = min(cer(x, hyp) for x in targets)
        rows.append({'id': t['id'], 'text': t['text'], 'hyp': hyp, 'cer': round(best, 3), 'pron_heard': 'pron' in t and norm(hyp) == norm(t['pron']),
                     'mel_db': round(mel_distance(ref[t['id']], logmel(path)), 2) if not v.startswith('fp32-F1') else 0.0})
    report[v] = {'mean_cer': round(float(np.mean([r['cer'] for r in rows])), 3), 'exact': sum(r['cer'] == 0 for r in rows),
                 'mean_mel_db': round(float(np.mean([r['mel_db'] for r in rows])), 2), 'rows': rows}
    print(v, 'mean CER', report[v]['mean_cer'], 'exact', report[v]['exact'], '/', len(rows), 'mel diff dB', report[v]['mean_mel_db'], flush=True)
json.dump(report, open(os.path.join(root, f'quality-{model_name}.json'), 'w'), ensure_ascii=False, indent=1)
