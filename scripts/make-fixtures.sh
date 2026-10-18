#!/usr/bin/env bash
# Regenerates e2e/fixtures/sample.mkv: 12 s 640x360 H.264, two audio tracks (eng AAC 440 Hz,
# rus AC-3 880 Hz — the second one forces the in-browser transcode path), embedded SRT (eng) and
# ASS (rus) subtitles. Plus a sidecar SRT. Needs an ffmpeg with libx264 + ac3 on PATH, or:
#   FFMPEG=$(node -e "console.log(require('ffmpeg-static'))") after `npm i --no-save ffmpeg-static`
set -euo pipefail
FFMPEG=${FFMPEG:-ffmpeg}
cd "$(dirname "$0")/../e2e/fixtures"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > sidecar.en.srt <<'SRT'
1
00:00:01,000 --> 00:00:03,000
Hello from English SRT

2
00:00:05,000 --> 00:00:08,000
Second english cue
SRT

cat > "$tmp/ru.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\i1}Привет из ASS{\i0}
Dialogue: 0,0:00:06.00,0:00:09.00,Default,,0,0,0,,Второй субтитр
ASS

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=24:duration=12 \
  -f lavfi -i sine=frequency=440:duration=12 \
  -f lavfi -i sine=frequency=880:duration=12 \
  -i sidecar.en.srt -i "$tmp/ru.ass" \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 \
  -c:v libx264 -preset veryfast -g 48 -pix_fmt yuv420p -b:v 300k \
  -c:a:0 aac -b:a:0 64k -c:a:1 ac3 -b:a:1 96k -ac:a:1 2 \
  -c:s:0 srt -c:s:1 ass \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title="English AAC" \
  -metadata:s:a:1 language=rus -metadata:s:a:1 title="Russian AC3" \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=rus \
  -disposition:a:0 default \
  sample.mkv
ls -l sample.mkv sidecar.en.srt
