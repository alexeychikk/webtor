//go:build unix

package relay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/anacrolix/torrent/metainfo"

	"github.com/alexeychikk/webtor/relay/internal/seedtest"
)

// TestDetectFFmpeg runs DetectFFmpeg against stand-in scripts.
func TestDetectFFmpeg(t *testing.T) {
	dir := t.TempDir()
	script := func(name, encoders string) string {
		p := filepath.Join(dir, name)
		body := "#!/bin/sh\ncase \"$2\" in\n-encoders) printf '%s' '" + encoders + "';;\n" +
			"-version) echo 'ffmpeg version 9.9-test Copyright';;\nesac\n"
		if err := os.WriteFile(p, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		return p
	}
	good := script("ffmpeg-good", " V....D libx264  libx264 H.264\n")
	bad := script("ffmpeg-no-x264", " V....D mpeg4  MPEG-4 part 2\n")
	ctx := context.Background()
	if p, v, err := DetectFFmpeg(ctx, good); err != nil || p != good || v != "9.9-test" {
		t.Errorf("good ffmpeg: %q %q %v", p, v, err)
	}
	if _, _, err := DetectFFmpeg(ctx, bad); err == nil || !strings.Contains(err.Error(), "libx264") {
		t.Errorf("ffmpeg without libx264: %v", err)
	}
	if _, _, err := DetectFFmpeg(ctx, filepath.Join(dir, "missing")); err == nil {
		t.Error("missing ffmpeg accepted")
	}

	notFound := func(string) (string, error) { return "", exec.ErrNotFound }
	if p := findFFmpeg(func(string) (string, error) { return "/usr/bin/ffmpeg", nil }, dir); p != "/usr/bin/ffmpeg" {
		t.Errorf("PATH first: %q", p)
	}
	if p := findFFmpeg(notFound, dir); p != "" {
		t.Errorf("no ffmpeg anywhere: %q", p)
	}
	script("ffmpeg", "")
	if p := findFFmpeg(notFound, dir); p != filepath.Join(dir, "ffmpeg") {
		t.Errorf("next to the binary: %q", p)
	}
}

// testFFmpeg is a usable ffmpeg from WEBTOR_RELAY_FFMPEG or PATH; the test is skipped without one.
func testFFmpeg(t *testing.T) (path, version string) {
	t.Helper()
	path, version, err := DetectFFmpeg(context.Background(), os.Getenv("WEBTOR_RELAY_FFMPEG"))
	if err != nil {
		t.Skipf("no usable ffmpeg (set WEBTOR_RELAY_FFMPEG): %v", err)
	}
	return path, version
}

// seedClips seeds a directory torrent of two copies of the 12 s Xvid fixture (files 0 and 1) and
// 300 kB of noise (file 2).
func seedClips(t *testing.T) *seedtest.Seeder {
	t.Helper()
	src, err := os.ReadFile("../../../e2e/fixtures/avi-xvid-mp3.avi")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "clips")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a.avi", "b.avi"} {
		if err := os.WriteFile(filepath.Join(root, n), src, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "c.bin"), randomBytes(300_000), 0o600); err != nil {
		t.Fatal(err)
	}
	seed, err := seedtest.Start(root, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(seed.Close)
	return seed
}

// jobRecorder collects the jobs the server starts (testJobStarted).
type jobRecorder struct {
	mu   sync.Mutex
	jobs []*transcodeJob
	args [][]string
}

func recordJobs(t *testing.T) *jobRecorder {
	rec := &jobRecorder{}
	testJobStarted = func(j *transcodeJob, args []string) {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		rec.jobs = append(rec.jobs, j)
		rec.args = append(rec.args, args)
	}
	t.Cleanup(func() { testJobStarted = nil })
	return rec
}

func (r *jobRecorder) job(t *testing.T, i int) *transcodeJob {
	t.Helper()
	waitFor(t, func() bool { r.mu.Lock(); defer r.mu.Unlock(); return len(r.jobs) > i }, 5*time.Second, "job started")
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobs[i]
}

func (r *jobRecorder) checkArgv(t *testing.T) {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, args := range r.args {
		argv := strings.Join(args, " ")
		if strings.Contains(argv, token) || !strings.Contains(argv, "-i http://127.0.0.1:") {
			t.Errorf("ffmpeg argv: %s", argv)
		}
	}
}

// processGone waits for the job to end and checks that its process group no longer exists.
func processGone(t *testing.T, j *transcodeJob, what string) {
	t.Helper()
	select {
	case <-j.done:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s: job still running", what)
	}
	if err := syscall.Kill(-int(j.pid.Load()), 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("%s: ffmpeg process group %d still there: %v", what, j.pid.Load(), err)
	}
}

// TestTranscodeOutput: the output is fragmented MP4 of H.264 High that starts at ?start=, scaled to
// at most the max height.
func TestTranscodeOutput(t *testing.T) {
	ffmpeg, version := testFFmpeg(t)
	seed := seedClips(t)
	rec := recordJobs(t)
	for _, tc := range []struct {
		maxHeight     int
		start         float64
		size          string
		minFr, maxFr  int // 24 fps
		firstPTSUpper float64
	}{
		{maxHeight: 720, start: 8, size: "320x180", minFr: 90, maxFr: 102},
		{maxHeight: 90, start: 0, size: "160x90", minFr: 280, maxFr: 292},
	} {
		h := newHarness(t, Options{MetadataTimeout: 20 * time.Second,
			Transcode: TranscodeOptions{FFmpeg: ffmpeg, FFmpegVersion: version, MaxHeight: tc.maxHeight}})
		base := h.torrentURL(seed.InfoHash)
		get(t, base+"/metainfo?x.pe="+seed.Addr, "").Body.Close()
		started := time.Now()
		res := get(t, base+"/transcode/1?start="+strconv.FormatFloat(tc.start, 'f', -1, 64), "")
		body, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != 200 || res.Header.Get("Content-Type") != "video/mp4" ||
			res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("transcode: %v %d %v %q", err, res.StatusCode, res.Header, body[:min(len(body), 200)])
		}
		t.Logf("max %dp, start %v: %d bytes in %v", tc.maxHeight, tc.start, len(body), time.Since(started))
		boxes := topLevelBoxes(body)
		if len(boxes) < 4 || boxes[0] != "ftyp" || boxes[1] != "moov" || boxes[2] != "moof" {
			t.Fatalf("boxes %v, want ftyp moov moof mdat …", boxes)
		}
		if !bytes.Contains(body, []byte("mvex")) || !bytes.Contains(body, []byte("avc1")) || bytes.Contains(body, []byte("mp4a")) {
			t.Errorf("moov: want fragmented H.264 without audio")
		}

		out := filepath.Join(t.TempDir(), "out.mp4")
		if err := os.WriteFile(out, body, 0o600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(ffmpeg, "-hide_banner", "-i", out, "-map", "0:v", "-c", "copy", "-f", "framemd5", "-")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		md5s, err := cmd.Output()
		if err != nil {
			t.Fatalf("reading the output back: %v\n%s", err, stderr.String())
		}
		if s := stderr.String(); !strings.Contains(s, "Video: h264 (High)") || !strings.Contains(s, tc.size) {
			t.Errorf("want H.264 High %s:\n%s", tc.size, s)
		}
		frames, firstPTS := framemd5Stats(t, md5s)
		if frames < tc.minFr || frames > tc.maxFr || firstPTS > 0.05 {
			t.Errorf("%d frames from %.3f s, want %d–%d from 0", frames, firstPTS, tc.minFr, tc.maxFr)
		}
	}

	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second, Transcode: TranscodeOptions{FFmpeg: ffmpeg}})
	get(t, h.torrentURL(seed.InfoHash)+"/metainfo?x.pe="+seed.Addr, "").Body.Close()
	res := get(t, h.torrentURL(seed.InfoHash)+"/transcode/2", "")
	if body := decodeError(t, res); res.StatusCode != http.StatusUnprocessableEntity || body.Error != "transcode-failed" || body.Detail == "" {
		t.Errorf("not a video: %d %+v, want 422 transcode-failed", res.StatusCode, body)
	} else {
		t.Logf("not a video: %s", body.Detail)
	}
	rec.checkArgv(t)
}

// topLevelBoxes lists the MP4 box types at the top level of b.
func topLevelBoxes(b []byte) []string {
	var out []string
	for len(b) >= 8 {
		size := int(binary.BigEndian.Uint32(b))
		out = append(out, string(b[4:8]))
		if size < 8 || size > len(b) {
			break
		}
		b = b[size:]
	}
	return out
}

// framemd5Stats counts the packets of ffmpeg's framemd5 output and returns the smallest pts in s.
func framemd5Stats(t *testing.T, out []byte) (frames int, firstPTS float64) {
	t.Helper()
	tb := 0.0
	firstPTS = 1e9
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if rest, ok := strings.CutPrefix(line, "#tb 0: 1/"); ok {
			d, _ := strconv.ParseFloat(rest, 64)
			tb = 1 / d
			continue
		}
		f := strings.Split(line, ",")
		if strings.HasPrefix(line, "#") || len(f) < 6 {
			continue
		}
		frames++
		pts, _ := strconv.ParseFloat(strings.TrimSpace(f[2]), 64)
		firstPTS = min(firstPTS, pts*tb)
	}
	if tb == 0 {
		t.Fatalf("no timebase in framemd5 output:\n%s", out)
	}
	return frames, firstPTS
}

// startStream opens a transcode request and waits for its first bytes. Cancel ctx to end it.
func startStream(t *testing.T, ctx context.Context, url string) *http.Response {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("transcode %s: %d %s", url, res.StatusCode, b)
	}
	if _, err := io.ReadFull(res.Body, make([]byte, 8)); err != nil {
		t.Fatalf("first bytes: %v", err)
	}
	return res
}

// TestTranscodeJobs: a new request for the same file replaces the job, another file over the limit
// gets 429, cancelling a request kills ffmpeg and frees the slot, and jobs hold their torrent.
func TestTranscodeJobs(t *testing.T) {
	ffmpeg, version := testFFmpeg(t)
	// Read the input at native speed, so a 12 s clip keeps its job running through the test.
	testExtraInputArgs = []string{"-readrate", "1"}
	t.Cleanup(func() { testExtraInputArgs = nil })
	seed := seedClips(t)
	rec := recordJobs(t)
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second, IdleTimeout: 200 * time.Millisecond,
		Transcode: TranscodeOptions{FFmpeg: ffmpeg, FFmpegVersion: version, MaxJobs: 1}})
	base := h.torrentURL(seed.InfoHash)
	get(t, base+"/metainfo?x.pe="+seed.Addr, "").Body.Close()

	first := startStream(t, context.Background(), base+"/transcode/0")
	jobA := rec.job(t, 0)

	res := get(t, base+"/transcode/1", "")
	if body := decodeError(t, res); res.StatusCode != http.StatusTooManyRequests || body.Error != "transcode-busy" || body.MaxTranscodes != 1 {
		t.Errorf("second file: %d %+v, want 429 transcode-busy", res.StatusCode, body)
	}

	// Same file again (a seek): the first job goes, its response breaks off instead of ending cleanly.
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	startStream(t, ctxB, base+"/transcode/0?start=6")
	jobB := rec.job(t, 1)
	processGone(t, jobA, "replaced job")
	if _, err := io.Copy(io.Discard, first.Body); err == nil {
		t.Error("replaced response ended like a finished video")
	}

	// The idle janitor (200 ms here) must not drop the torrent while a job runs.
	time.Sleep(500 * time.Millisecond)
	if h.srv.Torrents() != 1 {
		t.Fatal("torrent dropped during a conversion")
	}

	cancelB()
	processGone(t, jobB, "cancelled request")
	startStream(t, context.Background(), base+"/transcode/1")
	jobC := rec.job(t, 2)

	h.srv.StopTranscodes()
	processGone(t, jobC, "shutdown")
	rec.checkArgv(t)
}

// TestTranscodeIdle: a job whose output doesn't move (here: the swarm is gone) is killed with 504.
func TestTranscodeIdle(t *testing.T) {
	ffmpeg, version := testFFmpeg(t)
	seed := seedClips(t)
	rec := recordJobs(t)
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second,
		Transcode: TranscodeOptions{FFmpeg: ffmpeg, FFmpegVersion: version, IdleTimeout: 500 * time.Millisecond}})
	base := h.torrentURL(seed.InfoHash)
	get(t, base+"/metainfo?x.pe="+seed.Addr, "").Body.Close()
	seed.Close()
	res := get(t, base+"/transcode/0", "")
	if res.StatusCode != http.StatusGatewayTimeout {
		t.Errorf("no input: %d, want 504", res.StatusCode)
	}
	processGone(t, rec.job(t, 0), "idle job")

	for path, code := range map[string]int{"/transcode/7": 404, "/transcode/x": 404, "/transcode/0?start=-1": 400} {
		if res := get(t, base+path, ""); res.StatusCode != code {
			t.Errorf("%s: %d, want %d", path, res.StatusCode, code)
		}
	}
	if res := get(t, h.torrentURL(metainfo.Hash{7})+"/transcode/0", ""); res.StatusCode != 404 {
		t.Errorf("unknown torrent: %d, want 404", res.StatusCode)
	}
}
