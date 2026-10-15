# SageMaker 비동기 추론용 Qwen3-ASR 서버 (GPU). /ping, /invocations :8080
# SageMaker ml.g5 호스트의 NVIDIA 드라이버는 CUDA 11.4(470 계열)까지만 지원한다.
# cuda12.x 빌드의 torch 는 "driver too old" 로 GPU 초기화에 실패해 CPU 로 떨어지므로 cu118 빌드를 쓴다.
FROM pytorch/pytorch:2.6.0-cuda11.8-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/hf HF_HUB_DISABLE_TELEMETRY=1 MODEL_ID=Qwen/Qwen3-ASR-1.7B
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg sox libsndfile1 build-essential git \
    && rm -rf /var/lib/apt/lists/*
RUN pip install "qwen-asr==0.0.6" fastapi "uvicorn[standard]" python-multipart huggingface_hub
# 의존성 설치가 torch 를 cu12 빌드로 바꿔치기하지 않았는지 빌드 시점에 확인
RUN python -c "import torch; v=torch.version.cuda; assert v and v.startswith('11.'), f'unexpected torch cuda build: {v}'; print('torch', torch.__version__, 'cuda', v)"
# 모델 가중치를 이미지에 포함 (콜드스타트 시 HF 다운로드 불필요)
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('${MODEL_ID}')"
COPY server.py /app/server.py
COPY serve /usr/local/bin/serve
WORKDIR /app
EXPOSE 8080
# SageMaker 는 `serve` 인자로 실행하므로 ENTRYPOINT 스크립트가 인자를 무시한다
ENTRYPOINT ["/usr/local/bin/serve"]
