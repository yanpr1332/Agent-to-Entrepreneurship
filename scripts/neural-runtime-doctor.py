#!/usr/bin/env python3
"""Read-only local ONNX Python runtime doctor.

Only imports the operator-installed numpy, onnxruntime and transformers wheels.
No files or model weights are read, no subprocesses, no pip, no network calls.
Never emits Python installation paths or raw exception text to stdout.
"""
import contextlib
import io
import json
import sys

REQUIRED = ("numpy", "onnxruntime", "transformers")


def emit(status, missing=()):
    print(json.dumps({
        "schema": 1,
        "status": status,
        "pythonVersion": "%d.%d.%d" % sys.version_info[:3],
        "missing": list(missing),
    }, separators=(",", ":")))


def main():
    if sys.version_info[:2] < (3, 11) or sys.version_info[:2] >= (3, 14):
        emit("unsupported-python")
        return
    missing = []
    # Importing packages, not just inspecting their metadata, catches broken
    # native numpy/onnxruntime wheels early. Never print import exceptions.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            import numpy  # noqa: F401
        except Exception:
            missing.append("numpy")
        try:
            import onnxruntime as ort
        except Exception:
            ort = None
            missing.append("onnxruntime")
        try:
            from transformers import AutoTokenizer  # noqa: F401
        except Exception:
            missing.append("transformers")
    if missing:
        emit("missing-packages", missing)
        return
    try:
        providers = ort.get_available_providers()
    except Exception:
        emit("runtime-unavailable")
        return
    if "CPUExecutionProvider" not in providers:
        emit("cpu-provider-unavailable")
        return
    emit("ready")


if __name__ == "__main__":
    main()
