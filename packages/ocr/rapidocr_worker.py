"""RapidOCR 3.10.0 local-only worker. No image, question, or answer files are written."""
import base64
import contextlib
import importlib.metadata
import json
import pathlib
import sys


def main():
    if importlib.metadata.version("rapidocr") != "3.10.0":
        raise RuntimeError("OCR_VERSION_UNVERIFIED")
    # Redirect library messages; stdout is exclusively our bounded JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        import numpy as np
        import onnxruntime
        from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR

        onnxruntime.disable_telemetry_events()
        cv2.setNumThreads(1)

        request = json.loads(sys.stdin.buffer.read(6_000_001))
        directory = pathlib.Path(request["models"])
        params = {
            "Global.log_level": "critical",
            "EngineConfig.onnxruntime.intra_op_num_threads": 1,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            "Det.model_path": str(directory / "det.onnx"),
            "Cls.model_path": str(directory / "cls.onnx"),
            "Rec.model_path": str(directory / "rec.onnx"),
            "Rec.rec_keys_path": str(directory / "keys.txt"),
        }
        # v3.10.0 requires Enum values, and defaults to PP-OCRv6/small.
        # Match the fixed PP-OCRv4 mobile ONNX manifest explicitly.
        for stage in ("Det", "Cls", "Rec"):
            params[f"{stage}.engine_type"] = EngineType.ONNXRUNTIME
            params[f"{stage}.ocr_version"] = OCRVersion.PPOCRV4
            params[f"{stage}.model_type"] = ModelType.MOBILE
        image = cv2.imdecode(np.frombuffer(base64.b64decode(request["image"], validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("OCR_IMAGE_INVALID")
        result = RapidOCR(params=params)(image)
        text = "\n".join(result.txts or [])
        confidence = float(min(result.scores)) if result.scores is not None and len(result.scores) else 0
    print(json.dumps({"text": text, "confidence": confidence}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Avoid traceback text, model paths or recognized content leaking into application logs.
        print("OCR_WORKER_UNAVAILABLE", file=sys.stderr)
        sys.exit(2)
