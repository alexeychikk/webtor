# 0010 — HDR video: what the remux keeps, where it shows as HDR

Date: 2026-10-24 · Status: accepted (findings) · Extends 0003 (video is copied, never transcoded)

## Context

"HDR" torrents are mostly HEVC Main10 in MKV, tagged BT.2020 + PQ (HDR10, sometimes HDR10+ or a
Dolby Vision layer), less often HLG, AV1 10-bit or VP9 Profile 2. The player copies video through
Mediabunny into fragmented MP4 (0003), so HDR shows only if the colour signalling survives that
remux and the browser outputs HDR.

## Findings (Mediabunny 1.61.6, checked with ffprobe on x265/libaom/libvpx samples, 2026-10-24)

- **Colour survives.** Mediabunny reads the MKV `Colour` element (else the SPS VUI / AV1 sequence
  header / VP9 frame header) and writes an `nclx` `colr` box: BT.2020/PQ = 9/16/9 and HLG = 9/18/9
  arrived intact from MKV, MP4 and MPEG-TS inputs. `hvcC` is copied as is, so its SPS VUI and
  SEI are copied too.
- **HDR10 static metadata survives in-band, not as boxes.** No `mdcv`/`clli` are written, and the
  MKV `MasteringMetadata` is ignored. HEVC keeps its mastering-display and MaxCLL SEI (in `hvcC`
  and the samples), and Chromium reads both the `hvcC` SEI and the bitstream SEI. AV1 keeps its
  metadata OBUs. VP9 has no in-band carrier, so it loses them: playback falls back to default
  metadata, and the colours stay right.
- **HDR10+ (ST 2094-40 SEI)** passes through. Browsers ignore it and play the stream as HDR10.
- **VP9 Profile 2 caveat:** Mediabunny builds the `vp09` codec string and `vpcC` from the frame
  header's colour space (BT.2020 → transfer 14, SDR), not the container's PQ. The `colr` box is
  right, and Chromium's MP4 parser lets `colr` override `vpcC`. It's an upstream bug, not worked
  around here.
- **Dolby Vision is never recognised.** Mediabunny parses neither MKV `BlockAdditionMapping` (`dvcC`)
  nor MP4 `dvcC`/`dvvC`. MKV DV tracks reach MSE as plain HEVC (`hvc1` sample entry), so:
  profile 8.1/8.4 and 7 (single-track; the decoder skips RPU/EL NAL units 62/63) play as their
  HDR10/HLG base layer, which is what Chrome ≥ 122 does with them anyway. Profile 5 (IPTPQc2, no
  backward-compatible base) decodes with a green/purple cast. MP4 `dvh1`/`dvhe` sample entries are
  an unknown codec.
- **Nothing in the app touches colour.** There is no canvas, filter or CSS on the video. The relay
  serves the torrent's bytes unchanged. Its ffmpeg conversion (0007 §2) only handles DivX/Xvid AVI.

## Decision: detect Dolby Vision, say what happens

Our EBML header pass (`readMkvHeader`) reads each video track's `BlockAdditionMapping`; a
`dvcC`/`dvvC`/`dvwC` type carries the DOVIDecoderConfigurationRecord (`src/lib/player/dolby-vision.ts`).

- **Profile 5, compatibility id 0, or no base layer:** refused with `dolby-vision-unsupported` (error
  card, no Retry), instead of a picture with the wrong colours. MP4 `dvh1`/`dvhe`/`dva1`/`dvav`/`dav1`
  sample entries (an unknown codec to Mediabunny) get the same error.
- **Profile 7, 8.x (and any other with a compatibility id):** played as today, as the base layer,
  plus the toast `dolby-vision-base-layer`.
- Writing real DV (`dvh1` + `dvcC` in our output, for Safari) stays out of scope.

## Where it shows as HDR

- **Windows, Chrome/Edge:** HEVC Main10 needs a GPU decoder (Chrome: D3D11, nothing to install;
  Edge: MFT, needs the "HEVC Video Extensions"). Turn on HDR in Settings › System › Display, and
  keep graphics acceleration on. HDR10, HLG, AV1 and VP9.2 HDR then show as HDR. With Windows HDR off they
  are tone-mapped to SDR. Profile 5 doesn't play unencrypted.
- **Windows, Firefox:** HEVC since 133 (MFT + HEVC Video Extensions). HDR output since 153, AMD and
  NVIDIA GPUs only.
- **Safari (macOS, iPadOS 17.1+ via ManagedMediaSource):** HEVC HDR10/HLG show as HDR on HDR
  displays (tone-mapped on others). True Dolby Vision would need a `dvh1` sample entry + `dvcC` in
  our output.
- **Feature detection:** `isTypeSupported`/`decodingInfo` answer "can decode" (Chromium accepts
  PQ/HLG and `smpteSt2086` only with PQ, and refuses `smpteSt2094-10/40`), never "will show as
  HDR". The display check is `matchMedia('(dynamic-range: high)')`. `video-dynamic-range` isn't in
  Safari or Chromium.

## Decision: show HDR10/HLG, say when it is tone-mapped

- `hdr.ts` classifies the video track's colour space by its transfer only: PQ (16) = HDR10, HLG (18)
  = HLG, anything else SDR. BT.2020 primaries with an SDR transfer (14) are wide gamut, not HDR, so
  Mediabunny's `hasHighDynamicRange()` (true for any BT.2020) isn't used.
- The stats panel shows the format as a chip. An HDR video while `(dynamic-range: high)` is false gets
  the dismissable toast `hdr-sdr-display` (re-checked on the query's `change`), which links to the
  help dialog's HDR section (the conditions above, in plain words). A Dolby Vision 7/8.x base layer is
  classified like any other video (its HDR10/HLG transfer), next to its `dolby-vision-base-layer` toast.

Sources: Chromium `media/formats/mp4/box_definitions.cc` and `media/base/supported_types.cc`;
https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding;
https://bugzilla.mozilla.org/show_bug.cgi?id=2025322;
https://support.microsoft.com/en-us/windows/hdr-settings-in-windows-2d767185-38ec-7fdc-6f97-bbc6c5ef24e6;
https://w3c.github.io/media-capabilities/; https://webkit.org/blog/11340/.
