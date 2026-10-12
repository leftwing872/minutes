#!/usr/bin/env bash
# Lambda(x86_64)용 ffmpeg/ffprobe 정적 바이너리 레이어 준비. 이미 있으면 건너뜀.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/layers/ffmpeg/bin"
if [ -x "$DIR/ffmpeg" ] && [ -x "$DIR/ffprobe" ]; then echo "ffmpeg layer ready: $DIR"; exit 0; fi
TMP="$(mktemp -d)"
URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP/ffmpeg.tar.xz"
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*-static' | head -1)"
mkdir -p "$DIR"
cp "$SRC/ffmpeg" "$SRC/ffprobe" "$DIR/"
chmod +x "$DIR/ffmpeg" "$DIR/ffprobe"
rm -rf "$TMP"
echo "ffmpeg layer ready: $DIR"; ls -la "$DIR"
