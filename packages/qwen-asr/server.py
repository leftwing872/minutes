"""SageMaker 비동기 추론 컨테이너: 요청 본문 = 오디오 바이트(audio/wav 등), 응답 = {"text","language"}.
화자 이름 등 힌트는 X-Amzn-SageMaker-Custom-Attributes 헤더(context=...)로 받는다."""
import json, logging, os, tempfile, threading, time
from urllib.parse import parse_qs

import torch
from fastapi import FastAPI, Request, Response
from starlette.concurrency import run_in_threadpool
log = logging.getLogger("qwen-asr")
logging.basicConfig(level=logging.INFO)
MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen3-ASR-1.7B")
DEVICE = os.environ.get("QWEN_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
if not DEVICE.startswith("cuda"):
    # GPU 인스턴스인데 여기로 오면 드라이버/CUDA 빌드 불일치다 (CPU 는 240초 조각당 ~8분 소요)
    log.warning("CUDA not available (torch %s, cuda build %s) — running on %s", torch.__version__, torch.version.cuda, DEVICE)

app = FastAPI()
_model = None
_lock = threading.Lock()
_err = None


def load_model():
    global _model, _err
    try:
        from qwen_asr import Qwen3ASRModel
        t0 = time.time()
        dtype = {"bf16": torch.bfloat16, "fp32": torch.float32, "fp16": torch.float16}[os.environ.get("QWEN_DTYPE", "bf16" if DEVICE.startswith("cuda") else "fp32")]
        _model = Qwen3ASRModel.from_pretrained(MODEL_ID, dtype=dtype, device_map=DEVICE)
        log.info("model loaded in %.1fs on %s", time.time() - t0, DEVICE)
    except Exception as e:  # noqa: BLE001
        _err = repr(e)
        log.exception("model load failed")


@app.on_event("startup")
def _startup():
    threading.Thread(target=load_model, daemon=True).start()


@app.get("/ping")
def ping():
    if _model is not None:
        return Response(status_code=200)
    return Response(status_code=503, content=_err or "loading")


def _as_text(result):
    """qwen-asr 반환 형태(단일/리스트, 속성/딕셔너리)를 관대하게 처리"""
    if isinstance(result, (list, tuple)):
        result = result[0] if result else None
    if result is None:
        return "", None
    if isinstance(result, dict):
        return result.get("text", ""), result.get("language")
    return getattr(result, "text", str(result)), getattr(result, "language", None)


@app.post("/invocations")
async def invocations(request: Request):
    """본문만 비동기로 읽고, 수십 초~수 분 걸리는 추론은 스레드풀에서 돌린다.
    (이벤트 루프 안에서 락을 잡고 추론하면 /ping 이 막혀 SageMaker 가 컨테이너를 교체한다)"""
    if _model is None:
        return Response(status_code=503, content=json.dumps({"error": _err or "model loading"}), media_type="application/json")
    body = await request.body()
    return await run_in_threadpool(_invoke, body, request.headers)


def _invoke(body: bytes, headers) -> Response:
    attrs = parse_qs(headers.get("x-amzn-sagemaker-custom-attributes", ""))
    context = (attrs.get("context") or [""])[0]
    language = (attrs.get("language") or [None])[0]
    ctype = headers.get("content-type", "audio/wav")
    suffix = ".wav" if "wav" in ctype else ".m4a" if "mp4" in ctype else ".webm" if "webm" in ctype else ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(body)
        path = f.name
    try:
        t0 = time.time()
        with _lock:
            kwargs = {"audio": path, "language": language}
            if context:
                kwargs["context"] = context
            result = _model.transcribe(**kwargs)
        text, lang = _as_text(result)
        log.info("transcribed %d bytes in %.1fs", len(body), time.time() - t0)
        return Response(content=json.dumps({"text": text, "language": lang}, ensure_ascii=False), media_type="application/json")
    except Exception as e:  # noqa: BLE001
        log.exception("inference failed")
        return Response(status_code=500, content=json.dumps({"error": repr(e)}), media_type="application/json")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
