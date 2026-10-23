#!/usr/bin/env bash
# Regenerates e2e/fixtures/sample.mkv: 12 s 640x360 H.264, two audio tracks (eng AAC 440 Hz,
# rus AC-3 880 Hz — the second one forces the in-browser transcode path), embedded SRT (eng) and
# ASS (rus) subtitles. Plus a sidecar SRT, and offset.ts: 10 s H.264 + AAC MPEG-TS whose first
# timestamp is ~1.4 s (the muxer default), for the non-zero start time path. And three AVI files
# (docs/decisions/0007): avi-h264-mp3.avi (H.264 High with B-frames + VBR MP3, plays in the browser),
# avi-xvid-mp3.avi and avi-xvid-ac3.avi (MPEG-4 Part 2 "Xvid": needs the relay to convert the video),
# and avi-h264-noidx.avi: avi-h264-mp3.avi without its index (idx1 cut, AVIF_HASINDEX cleared).
# Needs an ffmpeg with libx264 + libxvid + libmp3lame + ac3 on PATH, or:
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

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=320x180:rate=24:duration=10 \
  -f lavfi -i sine=frequency=440:duration=10 \
  -c:v libx264 -preset veryfast -g 24 -pix_fmt yuv420p -b:v 150k \
  -c:a aac -b:a 48k \
  offset.ts
# AVI: 12 s, 24 fps, closed 2 s GOPs. ffmpeg writes idx1 (and OpenDML indx/ix## only past 1 GB).
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=24:duration=12 \
  -f lavfi -i sine=frequency=440:duration=12 \
  -c:v libx264 -preset veryfast -bf 2 -g 48 -pix_fmt yuv420p -b:v 300k \
  -c:a libmp3lame -q:a 5 \
  avi-h264-mp3.avi
# No index: the player scans movi while playing and shows the avi-no-index notice.
node - avi-h264-mp3.avi avi-h264-noidx.avi <<'JS'
const fs = require('node:fs');
const [src, dst] = process.argv.slice(2);
const b = fs.readFileSync(src);
let o = 12;
let out = b;
while (o + 8 <= b.length) {
  const size = b.readUInt32LE(o + 4);
  if (b.toString('latin1', o, o + 4) === 'idx1') {
    out = Buffer.concat([b.subarray(0, o), b.subarray(o + 8 + size + (size & 1))]);
    break;
  }
  o += 8 + size + (size & 1);
}
out.writeUInt32LE(out.length - 8, 4); // RIFF size
// avih data starts at 32 (RIFF, AVI, LIST hdrl, avih header); dwFlags is its 4th field.
out.writeUInt32LE(out.readUInt32LE(32 + 12) & ~0x10, 32 + 12);
fs.writeFileSync(dst, out);
JS

for audio in mp3 ac3; do
  case $audio in
    mp3) acodec=(-c:a libmp3lame -b:a 96k) ;;
    ac3) acodec=(-c:a ac3 -b:a 96k -ac 2) ;;
  esac
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i testsrc2=size=320x180:rate=24:duration=12 \
    -f lavfi -i sine=frequency=880:duration=12 \
    -c:v libxvid -vtag XVID -bf 2 -g 48 -q:v 12 \
    "${acodec[@]}" \
    "avi-xvid-$audio.avi"
done
# resume/: a two-video torrent for the per-video watch state (resume, remembered tracks).
# movie.mkv: 40 s 320x180 H.264 · audio eng AAC (default) + rus AC-3 · two English SRT tracks
# ("English", "English SDH") and one Russian; extra.mkv is sample.mkv (symlink).
mkdir -p resume
srt() { # $1 = text prefix: one 1 s cue every 2 s
  for i in $(seq 0 19); do
    printf '%d\n00:00:%02d,000 --> 00:00:%02d,000\n%s %d\n\n' $((i + 1)) $((i * 2)) $((i * 2 + 1)) "$1" "$i"
  done
}
srt 'English' > "$tmp/en.srt"
srt 'English SDH' > "$tmp/sdh.srt"
srt 'Русский' > "$tmp/ru.srt"
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=320x180:rate=24:duration=40 \
  -f lavfi -i sine=frequency=440:duration=40 \
  -f lavfi -i sine=frequency=660:duration=40 \
  -i "$tmp/en.srt" -i "$tmp/sdh.srt" -i "$tmp/ru.srt" \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 -map 5 \
  -c:v libx264 -preset veryfast -g 48 -pix_fmt yuv420p -b:v 120k \
  -c:a:0 aac -b:a:0 48k -c:a:1 ac3 -b:a:1 96k -ac:a:1 2 \
  -c:s srt \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title="English AAC" \
  -metadata:s:a:1 language=rus -metadata:s:a:1 title="Russian AC3" \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  -metadata:s:s:1 language=eng -metadata:s:s:1 title="English SDH" \
  -metadata:s:s:2 language=rus -metadata:s:s:2 title="Russian" \
  -disposition:a:0 default \
  resume/movie.mkv
ln -sfn ../sample.mkv resume/extra.mkv
# short-audio.mkv: 12 s 320x180 H.264 whose two audio tracks ("English AAC", copied; "Russian AC3",
# transcoded) end at 6 s, for seeks into the audio-less tail (e2e/seek-tail.spec.ts).
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=320x180:rate=24:duration=12 \
  -f lavfi -i sine=frequency=440:duration=6 \
  -f lavfi -i sine=frequency=660:duration=6 \
  -map 0:v -map 1:a -map 2:a \
  -c:v libx264 -preset veryfast -g 24 -pix_fmt yuv420p -b:v 100k \
  -c:a:0 aac -b:a:0 48k -c:a:1 ac3 -b:a:1 96k -ac:a:1 2 \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title="English AAC" \
  -metadata:s:a:1 language=rus -metadata:s:a:1 title="Russian AC3" \
  -disposition:a:0 default \
  short-audio.mkv
ls -l sample.mkv sidecar.en.srt offset.ts avi-*.avi resume/*.mkv short-audio.mkv
