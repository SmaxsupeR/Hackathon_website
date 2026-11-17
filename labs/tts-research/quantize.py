"""Builds the model variants compared in stage C. Usage: quantize.py <original model dir> <output root>"""
import os, shutil, sys, time
import onnx
from onnxconverter_common import float16
from onnxruntime.quantization import QuantType, quantize_dynamic

src, root = sys.argv[1], sys.argv[2]
PARTS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']

def base(variant):
    d = os.path.join(root, variant)
    os.makedirs(os.path.join(d, 'onnx'), exist_ok=True)
    for f in ['tts.json', 'unicode_indexer.json']:
        shutil.copy(os.path.join(src, 'onnx', f), os.path.join(d, 'onnx', f))
    if not os.path.exists(os.path.join(d, 'voice_styles')):
        shutil.copytree(os.path.join(src, 'voice_styles'), os.path.join(d, 'voice_styles'))
    for f in ['LICENSE', 'config.json']:
        shutil.copy(os.path.join(src, f), os.path.join(d, f))
    return d

def fp16(inp, out):
    m = onnx.load(inp)
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=False)
    onnx.save(m16, out)

def int8(inp, out):
    quantize_dynamic(inp, out, weight_type=QuantType.QInt8, per_channel=True, op_types_to_quantize=['MatMul', 'Gemm', 'Conv'])

plans = {
    'fp32': {p: 'copy' for p in PARTS},
    'fp16': {p: 'fp16' for p in PARTS},
    'int8_voc16': {'duration_predictor': 'copy', 'text_encoder': 'int8', 'vector_estimator': 'int8', 'vocoder': 'fp16'},
    'int8_all': {'duration_predictor': 'copy', 'text_encoder': 'int8', 'vector_estimator': 'int8', 'vocoder': 'int8'},
}
for variant, plan in plans.items():
    d = base(variant)
    for part, how in plan.items():
        inp, out = os.path.join(src, 'onnx', f'{part}.onnx'), os.path.join(d, 'onnx', f'{part}.onnx')
        if os.path.exists(out):
            continue
        t = time.time()
        if how == 'copy':
            os.link(inp, out) if not os.path.exists(out) else None
        elif how == 'fp16':
            fp16(inp, out)
        else:
            int8(inp, out)
        print(variant, part, how, f'{os.path.getsize(out)/1e6:.1f} MB', f'{time.time()-t:.0f}s', flush=True)
    total = sum(os.path.getsize(os.path.join(d, 'onnx', f'{p}.onnx')) for p in PARTS)
    print(f'== {variant}: {total/1e6:.1f} MB', flush=True)
