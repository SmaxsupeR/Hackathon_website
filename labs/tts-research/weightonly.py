"""Weight-only compression: weights are stored small and expanded to float32 when the model
is loaded, so compute stays float32. Usage: weightonly.py <src variant dir> <out root>"""
import os, shutil, sys
import numpy as np, onnx
from onnx import helper, numpy_helper, TensorProto
from onnxconverter_common import float16

src, root = sys.argv[1], sys.argv[2]
PARTS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']

def consumers(model):
    c = {}
    for node in model.graph.node:
        for i, inp in enumerate(node.input):
            c.setdefault(inp, []).append((node, i))
    return c

def weight_only(model, mode):
    cons = consumers(model)
    keep, add_init, add_nodes = [], [], []
    for init in model.graph.initializer:
        w = numpy_helper.to_array(init)
        users = cons.get(init.name, [])
        is_weight = w.dtype == np.float32 and w.size >= 1024 and users and all(n.op_type in ('Conv', 'MatMul', 'Gemm', 'ConvTranspose') and i == 1 for n, i in users)
        if not is_weight:
            keep.append(init)
            continue
        if mode == 'fp16':
            add_init.append(numpy_helper.from_array(w.astype(np.float16), init.name + '__fp16'))
            add_nodes.append(helper.make_node('Cast', [init.name + '__fp16'], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
        else:
            op = users[0][0].op_type
            axis = 0 if op in ('Conv', 'ConvTranspose') else w.ndim - 1
            red = tuple(a for a in range(w.ndim) if a != axis)
            scale = np.maximum(np.abs(w).max(axis=red), 1e-12) / 127.0
            q = np.clip(np.round(w / np.expand_dims(scale, red)), -127, 127).astype(np.int8)
            add_init += [numpy_helper.from_array(q, init.name + '__q'), numpy_helper.from_array(scale.astype(np.float32), init.name + '__s'),
                         numpy_helper.from_array(np.zeros_like(scale, dtype=np.int8), init.name + '__z')]
            add_nodes.append(helper.make_node('DequantizeLinear', [init.name + '__q', init.name + '__s', init.name + '__z'], [init.name], axis=axis, name=init.name + '__dq'))
    del model.graph.initializer[:]
    model.graph.initializer.extend(keep + add_init)
    nodes = list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend(add_nodes + nodes)
    return model

for variant, mode in [('fp16w', 'fp16'), ('int8w', 'int8')]:
    d = os.path.join(root, variant)
    if os.path.exists(d):
        shutil.rmtree(d)
    shutil.copytree(src, d, ignore=shutil.ignore_patterns('*.onnx'))
    for p in PARTS:
        m = onnx.load(os.path.join(src, 'onnx', f'{p}.onnx'))
        onnx.save(weight_only(m, mode), os.path.join(d, 'onnx', f'{p}.onnx'))
    print(variant, f"{sum(os.path.getsize(os.path.join(d, 'onnx', f'{p}.onnx')) for p in PARTS)/1e6:.1f} MB", flush=True)

# True float16 compute, with Cast kept in float32 to avoid the type mismatch of the default conversion.
d = os.path.join(root, 'fp16')
for p in PARTS:
    m = onnx.load(os.path.join(src, 'onnx', f'{p}.onnx'))
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=list(float16.DEFAULT_OP_BLOCK_LIST) + ['Cast', 'Range', 'CumSum', 'RandomNormalLike'])
    onnx.save(m16, os.path.join(d, 'onnx', f'{p}.onnx'))
print('fp16', f"{sum(os.path.getsize(os.path.join(d, 'onnx', f'{p}.onnx')) for p in PARTS)/1e6:.1f} MB")
