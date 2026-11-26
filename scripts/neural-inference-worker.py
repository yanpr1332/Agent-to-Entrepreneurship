#!/usr/bin/env python3
"""Study Anchor fixed local neural embedding worker. No model download/network.

Dependencies supplied by the user's dedicated Python environment:
numpy, transformers (for local tokenizer only), onnxruntime (CPU execution).
Do NOT use trust_remote_code or execute scripts from the chosen model folder.
All requests and replies are JSON-lines over a private child process pipe.
"""
import json
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["NO_PROXY"] = "*"

def send(response):
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()

if len(sys.argv) != 4 or sys.argv[2] not in ("e5", "bge"):
    send({"ready": False, "error": "Unsupported pinned local neural model"})
    sys.exit(2)

model_dir, kind, dim_arg = sys.argv[1:]
try:
    dim = int(dim_arg)
    if dim not in (384, 512):
        raise ValueError()
except ValueError:
    send({"ready": False, "error": "Unsupported model dimension"})
    sys.exit(2)

try:
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer
except Exception:
    send({"ready": False, "error": "Local Python runtime needs numpy, onnxruntime and transformers"})
    sys.exit(3)

try:
    tokenizer = AutoTokenizer.from_pretrained(
        model_dir, use_fast=True, local_files_only=True, trust_remote_code=False
    )
    options = ort.SessionOptions()
    # Predictable CPU footprint on student laptops; never choose a GPU or
    # auto-enable unbounded per-core native thread pools.
    options.intra_op_num_threads = min(4, max(1, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        os.path.join(model_dir, "model.onnx"),
        sess_options=options, providers=["CPUExecutionProvider"]
    )
    names = {item.name for item in session.get_inputs()}
    # Unknown ONNX inputs must NOT be filled with a zero tensor. Some graph
    # exports require position_ids with increasing positions, and silently
    # providing zeros would make genuinely wrong neural embeddings.
    allowed_inputs = {"input_ids", "attention_mask", "token_type_ids"}
    if not {"input_ids", "attention_mask"}.issubset(names) or not names.issubset(allowed_inputs):
        raise ValueError("Unsupported model inputs")
    for item in session.get_inputs():
        if item.type != "tensor(int64)":
            raise ValueError("Unsupported tokenizer input dtype")
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise ValueError("CPU runtime was not selected")
    # Validate graph output shape with a local synthetic test string.
    tokens = tokenizer(["test"], padding=True, truncation=True,
                       max_length=512, return_tensors="np")
    inputs = {key: np.asarray(tokens.get(key,
              np.zeros_like(tokens["input_ids"])), dtype=np.int64)
              for key in names}
    output = session.run(None, inputs)[0]
    if output.ndim != 3 or output.shape[0] != 1 or output.shape[-1] != dim:
        raise ValueError("Wrong last-hidden-state dimension")
except Exception:
    send({"ready": False, "error": "The local ONNX graph/tokenizer failed CPU preflight"})
    sys.exit(4)

send({"ready": True, "dimension": dim, "engine": "onnx-" + kind})

for line in sys.stdin:
    req_id = None
    try:
        if len(line) > 44000:
            raise ValueError("Request too large")
        req = json.loads(line)
        req_id = req.get("id")
        texts = req.get("texts")
        request_kind = req.get("kind")
        if (not isinstance(req_id, int) or isinstance(req_id, bool)
                or req_id < 1 or request_kind not in ("query", "passage")
                or not isinstance(texts, list) or not (1 <= len(texts) <= 16)
                or any(not isinstance(t, str) or not (1 <= len(t) <= 2200)
                       for t in texts)):
            raise ValueError("Malformed request")
        if kind == "e5":
            prefix = "query: " if request_kind == "query" else "passage: "
            inputs_text = [prefix + t for t in texts]
        else:
            # BGE-small-zh-v1.5 works for retrieval without E5 prefixes.
            inputs_text = texts
        tokens = tokenizer(inputs_text, padding=True, truncation=True,
                           max_length=512, return_tensors="np")
        feeds = {key: np.asarray(tokens.get(key,
                 np.zeros_like(tokens["input_ids"])), dtype=np.int64)
                 for key in names}
        hidden = session.run(None, feeds)[0]
        if (hidden.ndim != 3 or hidden.shape[0] != len(texts)
                or hidden.shape[1] != tokens["attention_mask"].shape[1]
                or hidden.shape[2] != dim):
            raise ValueError("Unexpected ONNX model output shape")
        if kind == "e5":
            mask = tokens["attention_mask"][..., None]
            vectors = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1)
        else:
            vectors = hidden[:, 0, :]
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if not np.all(np.isfinite(vectors)) or np.any(norms < 1e-10):
            raise ValueError("Invalid model output values")
        normalized = vectors / norms
        send({"id": req_id, "ok": True, "values": normalized.astype("float32").tolist()})
    except Exception:
        # Never echo private text, model paths, environment, or raw traceback.
        send({"id": req_id, "ok": False, "error": "Offline inference failed"})
