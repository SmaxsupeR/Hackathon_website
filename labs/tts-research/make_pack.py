"""Packs a variant as a lab voice pack: model files, voices, license, notices and a manifest with SHA-256.
Usage: make_pack.py <variant dir> <id> <name> <out zip>"""
import hashlib, json, os, sys, zipfile
import onnx

vdir, pid, name, out = sys.argv[1:5]
NOTICE = f"""Namu voice pack "{name}" ({pid})

This pack contains a modified version (a "Derivative of the Model") of Supertonic 3 by Supertone Inc.,
https://huggingface.co/Supertone/supertonic-3 (commit 3cadd1ee6394adea1bd021217a0e650ede09a323),
licensed under the BigScience OpenRAIL-M License (see LICENSE).

Changes made by the Namu project (2026-11-17):
- onnx/duration_predictor.onnx, onnx/text_encoder.onnx, onnx/vector_estimator.onnx, onnx/vocoder.onnx:
  weights of Conv/MatMul/Gemm layers are stored as INT8 (symmetric, per output channel) or FP16 and
  expanded back to float32 by DequantizeLinear/Cast nodes when the model is loaded. The network
  architecture and the voice style files are unchanged.

Use-based restrictions (paragraph 5 and Attachment A of the License) apply to this pack and to every
use of it. In particular you must not use it to impersonate others without consent, or to publish
generated speech without clearly disclosing that it is machine-generated. Every user of the pack
must comply with these restrictions.
"""
files = []
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as z:
    def add(path, data):
        z.writestr(path, data)
        files.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
    add('LICENSE', open(os.path.join(vdir, 'LICENSE'), 'rb').read())
    add('NOTICE.txt', NOTICE.encode())
    for f in ['tts.json', 'unicode_indexer.json']:
        add(f'onnx/{f}', open(os.path.join(vdir, 'onnx', f), 'rb').read())
    for p in ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']:
        m = onnx.load(os.path.join(vdir, 'onnx', f'{p}.onnx'))
        for k, v in [('modified_by', 'Namu project, 2026-11-17'), ('modification', 'weight-only compression; see NOTICE.txt'),
                     ('original_model', 'Supertone/supertonic-3@3cadd1ee6394adea1bd021217a0e650ede09a323'), ('license', 'BigScience OpenRAIL-M')]:
            e = m.metadata_props.add(); e.key = k; e.value = v
        add(f'onnx/{p}.onnx', m.SerializeToString())
    for v in sorted(os.listdir(os.path.join(vdir, 'voice_styles'))):
        add(f'voice_styles/{v}', open(os.path.join(vdir, 'voice_styles', v), 'rb').read())
    manifest = {'id': pid, 'name': name, 'quantizedWeights': True, 'source': 'Namu stage C, from Supertone/supertonic-3@3cadd1e', 'files': files}
    z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=1))
print(out, f'{os.path.getsize(out)/1e6:.1f} MB', len(files), 'files')
