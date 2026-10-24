package relay

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/anacrolix/torrent/metainfo"
)

func TestTranscodeArgs(t *testing.T) {
	url := "http://127.0.0.1:4321/0123abcd"
	args := TranscodeArgs(url, 8.5, "veryfast", 720)
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-nostdin", "-protocol_whitelist http,tcp", "-ss 8.5 -i " + url, "-map 0:v:0 -an -sn -dn",
		`-vf scale=-2:trunc(min(ih\,720)/2)*2`, "-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -profile:v high",
		"-force_key_frames expr:gte(t,n_forced*2)", "-sc_threshold 0",
		"-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 pipe:1",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("args lack %q:\n%s", want, joined)
		}
	}
	if i, j := slices.Index(args, "-protocol_whitelist"), slices.Index(args, "-i"); i > j {
		t.Errorf("-protocol_whitelist must be an input option: %v", args)
	}
	if slices.Contains(TranscodeArgs(url, 0, "fast", 480), "-ss") {
		t.Errorf("start 0 needs no -ss")
	}
	if got := TranscodeArgs(url, 1, "fast", 480, "-readrate", "1"); slices.Index(got, "-readrate") > slices.Index(got, "-i") {
		t.Errorf("extra input args after -i: %v", got)
	}
}

func TestParseStart(t *testing.T) {
	for in, want := range map[string]float64{"": 0, "0": 0, "12.25": 12.25, "3600": 3600} {
		if got, err := ParseStart(in); err != nil || got != want {
			t.Errorf("ParseStart(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"-1", "NaN", "Inf", "abc", "1e9", "1,5"} {
		if _, err := ParseStart(in); err == nil {
			t.Errorf("ParseStart(%q) accepted", in)
		}
	}
}

func TestFFmpegOutputParsing(t *testing.T) {
	encoders := `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`
	if !HasLibx264(encoders) {
		t.Error("libx264 not found")
	}
	if HasLibx264(strings.ReplaceAll(encoders, "libx264 ", "libx265 ")) || HasLibx264(" V....D libx264rgb  libx264 RGB\n") {
		t.Error("libx264 found where there is none")
	}
	for out, want := range map[string]string{
		"ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024\nbuilt with gcc": "7.0.2-static",
		"ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers":                            "6.1.1-3ubuntu5",
		"something else": "?",
	} {
		if got := ParseFFmpegVersion(out); got != want {
			t.Errorf("ParseFFmpegVersion(%q) = %q, want %q", out, got, want)
		}
	}
}

func TestTailBuffer(t *testing.T) {
	tb := &tailBuffer{max: 32}
	_, _ = tb.Write([]byte("first line that will be cut\n\n"))
	_, _ = tb.Write([]byte("second\nthird\n"))
	if got := tb.LastLines(2); got != "second; third" {
		t.Errorf("LastLines(2) = %q", got)
	}
	if got := tb.LastLines(5); strings.Contains(got, "first line") {
		t.Errorf("kept more than max bytes: %q", got)
	}
}

func TestTranscodeOptionsValidated(t *testing.T) {
	if _, err := New(nil, Options{Token: token, Transcode: TranscodeOptions{Preset: "turbo"}}); err == nil {
		t.Error("unknown preset accepted")
	}
	s, err := New(nil, Options{Token: token})
	if err != nil {
		t.Fatal(err)
	}
	if o := s.opts.Transcode; o.MaxJobs != 1 || o.Preset != "veryfast" || o.MaxHeight != 720 || o.IdleTimeout <= 0 {
		t.Errorf("defaults: %+v", o)
	}
}

// TestTranscodeUnavailable: without ffmpeg, /v1/info says so and conversion answers 503.
func TestTranscodeUnavailable(t *testing.T) {
	h := newHarness(t, Options{})
	res := get(t, h.url+"/"+token+"/v1/info", "")
	var info struct {
		API       int           `json:"api"`
		Transcode TranscodeInfo `json:"transcode"`
	}
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if info.API != APIVersion || info.Transcode.Available || info.Transcode.MaxHeight != 720 || info.Transcode.Preset != "veryfast" {
		t.Errorf("info: %+v", info)
	}
	res = get(t, h.torrentURL(metainfo.Hash{1})+"/transcode/0?start=3", "")
	body := decodeError(t, res)
	if res.StatusCode != http.StatusServiceUnavailable || body.Error != "transcode-unavailable" || body.Detail == "" {
		t.Errorf("transcode without ffmpeg: %d %+v", res.StatusCode, body)
	}
}

type errorBody struct {
	Error         string `json:"error"`
	Detail        string `json:"detail"`
	MaxTranscodes int    `json:"maxTranscodes"`
}

func decodeError(t *testing.T, res *http.Response) errorBody {
	t.Helper()
	var b errorBody
	_ = json.NewDecoder(res.Body).Decode(&b)
	return b
}
