package relay

// Video conversion for the browser (docs/decisions/0007-avi-playback.md §2): GET
// {base}/v1/torrents/{ih}/transcode/{fileIndex}?start=<s> runs ffmpeg on one torrent file and streams
// its first video track as fragmented MP4 (H.264 High, no audio). ffmpeg reads the file from a
// loopback listener that serves only that file at a random path, so neither the token nor the relay
// URL ever reaches its argv. Back-pressure is TCP: a client that stops reading blocks the copy loop,
// ffmpeg blocks on its stdout pipe and stops decoding.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
)

// Defaults for zero TranscodeOptions fields.
const (
	DefaultMaxTranscodes        = 1
	DefaultTranscodePreset      = "veryfast"
	DefaultTranscodeMaxHeight   = 720
	DefaultTranscodeIdleTimeout = 10 * time.Minute
)

// X264Presets are the values -transcode-preset accepts, fastest first.
var X264Presets = []string{"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}

// TranscodeOptions configure GET .../transcode/{fileIndex}.
type TranscodeOptions struct {
	// FFmpeg is the path of an ffmpeg with libx264 (see DetectFFmpeg); "" turns conversion off (503).
	FFmpeg string
	// FFmpegVersion is reported by /v1/info.
	FFmpegVersion string
	// MaxJobs caps concurrent conversions; one more (for another file) answers 429.
	MaxJobs int
	// Preset is libx264's -preset.
	Preset string
	// MaxHeight scales taller video down (never up).
	MaxHeight int
	// IdleTimeout kills a job whose output hasn't moved for this long (a paused tab).
	IdleTimeout time.Duration
}

func (o *TranscodeOptions) setDefaults() error {
	if o.MaxJobs <= 0 {
		o.MaxJobs = DefaultMaxTranscodes
	}
	if o.Preset == "" {
		o.Preset = DefaultTranscodePreset
	}
	if !slices.Contains(X264Presets, o.Preset) {
		return fmt.Errorf("relay: transcode preset %q: want one of %s", o.Preset, strings.Join(X264Presets, ", "))
	}
	if o.MaxHeight <= 0 {
		o.MaxHeight = DefaultTranscodeMaxHeight
	}
	if o.MaxHeight < 16 {
		return fmt.Errorf("relay: transcode max height %d is too small", o.MaxHeight)
	}
	if o.IdleTimeout <= 0 {
		o.IdleTimeout = DefaultTranscodeIdleTimeout
	}
	return nil
}

// ErrNoFFmpeg: no ffmpeg on PATH or next to the relay binary.
var ErrNoFFmpeg = errors.New("ffmpeg not found")

// DetectFFmpeg finds ffmpeg (explicit, else "ffmpeg" on PATH, else next to the running binary) and
// checks that it has the libx264 encoder. It returns the path and ffmpeg's version string.
func DetectFFmpeg(ctx context.Context, explicit string) (path, version string, err error) {
	path = explicit
	if path == "" {
		exeDir := ""
		if exe, err := os.Executable(); err == nil {
			exeDir = filepath.Dir(exe)
		}
		path = findFFmpeg(exec.LookPath, exeDir)
		if path == "" {
			return "", "", ErrNoFFmpeg
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "-hide_banner", "-encoders").Output()
	if err != nil {
		return path, "", fmt.Errorf("running %s -encoders: %w", path, err)
	}
	if !HasLibx264(string(out)) {
		return path, "", fmt.Errorf("%s has no libx264 encoder", path)
	}
	out, err = exec.CommandContext(ctx, path, "-hide_banner", "-version").Output()
	if err != nil {
		return path, "", fmt.Errorf("running %s -version: %w", path, err)
	}
	return path, ParseFFmpegVersion(string(out)), nil
}

// findFFmpeg is DetectFFmpeg's search without an explicit path.
func findFFmpeg(lookPath func(string) (string, error), exeDir string) string {
	if p, err := lookPath("ffmpeg"); err == nil {
		return p
	}
	if exeDir == "" {
		return ""
	}
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(exeDir, name)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	return ""
}

// HasLibx264 reports whether `ffmpeg -encoders` output lists libx264.
func HasLibx264(encoders string) bool {
	for line := range strings.Lines(encoders) {
		f := strings.Fields(line)
		// " V....D libx264  libx264 H.264 / AVC / ..."
		if len(f) >= 2 && strings.HasPrefix(f[0], "V") && f[1] == "libx264" {
			return true
		}
	}
	return false
}

// ParseFFmpegVersion takes "7.0.2-static" out of `ffmpeg -version` ("ffmpeg version 7.0.2-static
// https://…"); "?" when the output looks different.
func ParseFFmpegVersion(out string) string {
	first, _, _ := strings.Cut(out, "\n")
	if v, ok := strings.CutPrefix(strings.TrimSpace(first), "ffmpeg version "); ok {
		if f := strings.Fields(v); len(f) > 0 {
			return f[0]
		}
	}
	return "?"
}

// ParseStart reads the ?start= seconds of a transcode request ("" = 0).
func ParseStart(s string) (float64, error) {
	if s == "" {
		return 0, nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > 1e7 {
		return 0, fmt.Errorf("bad start %q: want seconds ≥ 0", s)
	}
	return v, nil
}

// TranscodeArgs is ffmpeg's argv (without the program) for one job: input from url, output fMP4 on
// stdout. start is element time; input -ss is relative to the file's start time too, frame-accurate
// when transcoding, and output timestamps start at 0.
func TranscodeArgs(url string, start float64, preset string, maxHeight int, extraInput ...string) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "http,tcp"}
	args = append(args, extraInput...)
	if start > 0 {
		args = append(args, "-ss", strconv.FormatFloat(start, 'f', -1, 64))
	}
	return append(args,
		"-i", url,
		"-map", "0:v:0", "-an", "-sn", "-dn",
		// Never upscale; keep both sides even (yuv420p).
		"-vf", fmt.Sprintf("scale=-2:trunc(min(ih\\,%d)/2)*2", maxHeight),
		"-c:v", "libx264", "-preset", preset, "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high",
		"-force_key_frames", "expr:gte(t,n_forced*2)", "-sc_threshold", "0",
		"-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000",
		"pipe:1",
	)
}

type jobKey struct {
	ih   metainfo.Hash
	file int
}

type transcodeJob struct {
	key    jobKey
	cancel context.CancelCauseFunc
	done   chan struct{}
	pid    atomic.Int64
}

var (
	errTranscodeBusy = errors.New("transcode-busy")
	errJobReplaced   = errors.New("replaced by a newer request for the same file")
	errJobIdle       = errors.New("output didn't move")
	errJobShutdown   = errors.New("relay is shutting down")
)

// Test hooks: extra ffmpeg input options (e.g. -readrate 1, so jobs outlive a test's requests) and
// a callback with each started job and its argv.
var (
	testExtraInputArgs []string
	testJobStarted     func(j *transcodeJob, args []string)
)

// startJob registers a job for key, replacing a running one for the same key (it is cancelled and
// waited for), or fails with errTranscodeBusy when MaxJobs other jobs run.
func (s *Server) startJob(parent context.Context, key jobKey) (*transcodeJob, context.Context, error) {
	s.mu.Lock()
	if s.closed || s.jobsStopped {
		s.mu.Unlock()
		return nil, nil, errClosed
	}
	old := s.jobs[key]
	if old == nil && len(s.jobs) >= s.opts.Transcode.MaxJobs {
		s.mu.Unlock()
		return nil, nil, errTranscodeBusy
	}
	ctx, cancel := context.WithCancelCause(parent)
	j := &transcodeJob{key: key, cancel: cancel, done: make(chan struct{})}
	s.jobs[key] = j
	s.mu.Unlock()
	if old != nil {
		old.cancel(errJobReplaced)
		select {
		case <-old.done:
		case <-time.After(5 * time.Second):
		}
	}
	return j, ctx, nil
}

func (s *Server) finishJob(j *transcodeJob) {
	s.mu.Lock()
	if s.jobs[j.key] == j {
		delete(s.jobs, j.key)
	}
	s.mu.Unlock()
	j.cancel(context.Canceled)
	close(j.done)
}

// StopTranscodes kills every conversion and refuses new ones (shutdown). It waits up to 5 s for the
// ffmpeg processes to exit.
func (s *Server) StopTranscodes() {
	s.mu.Lock()
	s.jobsStopped = true
	jobs := make([]*transcodeJob, 0, len(s.jobs))
	for _, j := range s.jobs {
		jobs = append(jobs, j)
	}
	s.mu.Unlock()
	deadline := time.After(5 * time.Second)
	for _, j := range jobs {
		j.cancel(errJobShutdown)
	}
	for _, j := range jobs {
		select {
		case <-j.done:
		case <-deadline:
			return
		}
	}
}

func transcodeError(w http.ResponseWriter, code int, kind, detail string, extra map[string]any) {
	body := map[string]any{"error": kind, "detail": detail}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, code, body)
}

func (s *Server) handleTranscode(w http.ResponseWriter, r *http.Request) {
	topts := s.opts.Transcode
	if topts.FFmpeg == "" {
		transcodeError(w, http.StatusServiceUnavailable, "transcode-unavailable",
			"this relay can't convert video: install ffmpeg (with libx264) on its computer and restart it", nil)
		return
	}
	start, err := ParseStart(r.URL.Query().Get("start"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	idx, err := strconv.Atoi(r.PathValue("fileIndex"))
	if err != nil {
		httpError(w, http.StatusNotFound, fmt.Errorf("bad file index %q", r.PathValue("fileIndex")))
		return
	}
	e, ok := s.existing(w, r, http.StatusNotFound)
	if !ok {
		return
	}
	// The job holds the torrent for its whole life, so the janitor never drops it mid-conversion.
	defer s.release(e)
	if e.t.Info() == nil {
		httpError(w, http.StatusServiceUnavailable, errors.New("no metadata yet; fetch metainfo first"))
		return
	}
	files := e.t.Files()
	if idx < 0 || idx >= len(files) {
		httpError(w, http.StatusNotFound, fmt.Errorf("no file %d in this torrent", idx))
		return
	}
	j, ctx, err := s.startJob(r.Context(), jobKey{e.ih, idx})
	switch {
	case errors.Is(err, errTranscodeBusy):
		transcodeError(w, http.StatusTooManyRequests, "transcode-busy",
			fmt.Sprintf("this relay converts at most %d video(s) at once", topts.MaxJobs),
			map[string]any{"maxTranscodes": topts.MaxJobs})
		return
	case err != nil:
		httpError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer s.finishJob(j)
	s.runJob(ctx, w, e, files[idx], j, start)
}

// runJob serves the job's input on loopback, runs ffmpeg and copies its stdout to w.
func (s *Server) runJob(ctx context.Context, w http.ResponseWriter, e *entry, f *torrent.File, j *transcodeJob, start float64) {
	topts := s.opts.Transcode
	log := s.log.With("infohash", e.ih.HexString(), "file", j.key.file)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	idb := make([]byte, 16)
	_, _ = rand.Read(idb)
	jobPath := "/" + hex.EncodeToString(idb)
	in := &http.Server{
		Handler:           s.jobInput(e, f, jobPath),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() { _ = in.Serve(ln) }()
	defer in.Close()

	input := "http://" + ln.Addr().String() + jobPath
	args := TranscodeArgs(input, start, topts.Preset, topts.MaxHeight, testExtraInputArgs...)
	cmd := exec.CommandContext(ctx, topts.FFmpeg, args...)
	setProcessGroup(cmd)
	cmd.WaitDelay = 3 * time.Second
	stderr := &tailBuffer{max: 4 << 10, redact: input}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		transcodeError(w, http.StatusUnprocessableEntity, "transcode-failed", "starting ffmpeg: "+err.Error(), nil)
		return
	}
	j.pid.Store(int64(cmd.Process.Pid))
	if testJobStarted != nil {
		testJobStarted(j, cmd.Args)
	}
	log.Debug("transcode started", "start", start, "pid", cmd.Process.Pid)

	// The idle clock runs from the start: a swarm that never delivers the input kills the job too.
	rc := http.NewResponseController(w)
	var lastWrite atomic.Int64
	lastWrite.Store(time.Now().UnixNano())
	stopIdle := s.watchJobIdle(ctx, j, rc, &lastWrite)
	defer stopIdle()

	buf := make([]byte, 64<<10)
	n, rerr := readSome(stdout, buf)
	if n == 0 {
		werr := cmd.Wait()
		// The watcher may have set a write deadline when the job ended; the answer must still go out.
		stopIdle()
		_ = rc.SetWriteDeadline(time.Time{})
		switch cause := context.Cause(ctx); {
		case errors.Is(cause, errJobIdle):
			log.Info("transcode got no input", "idle", topts.IdleTimeout)
			httpError(w, http.StatusGatewayTimeout, fmt.Errorf("no data from the swarm for %v", topts.IdleTimeout))
		case cause != nil:
			log.Debug("transcode ended before output", "reason", cause)
			// Replaced or shutting down: the client's request is over either way.
			panic(http.ErrAbortHandler)
		default:
			detail := stderr.LastLines(5)
			if detail == "" {
				detail = fmt.Sprint(errors.Join(rerr, werr))
			}
			log.Info("transcode failed", "err", werr, "stderr", detail)
			transcodeError(w, http.StatusUnprocessableEntity, "transcode-failed", detail, nil)
		}
		return
	}

	h := w.Header()
	h.Set("Content-Type", "video/mp4")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	var werr error
	for n > 0 || rerr == nil {
		if n > 0 {
			if _, werr = w.Write(buf[:n]); werr != nil {
				break
			}
			_ = rc.Flush()
			lastWrite.Store(time.Now().UnixNano())
		}
		if rerr != nil {
			break
		}
		n, rerr = stdout.Read(buf)
	}
	if werr != nil {
		j.cancel(fmt.Errorf("client gone: %w", werr))
	}
	exitErr := cmd.Wait()
	cause := context.Cause(ctx)
	switch {
	case cause == nil && exitErr == nil && werr == nil:
		log.Debug("transcode finished")
		return
	case cause != nil:
		log.Debug("transcode stopped", "reason", cause)
	default:
		log.Info("transcode failed mid-stream", "err", exitErr, "stderr", stderr.LastLines(5))
	}
	// Anything but a clean ffmpeg exit must not look like the end of the video to the app.
	panic(http.ErrAbortHandler)
}

// watchJobIdle kills the job once nothing was written to the client for IdleTimeout. When the job
// ends for any reason (idle, replaced, shutdown), it unblocks a Write stuck on a client that stopped
// reading. The returned stop function (idempotent) waits for it, so rc is never used after the
// handler returns.
func (s *Server) watchJobIdle(ctx context.Context, j *transcodeJob, rc *http.ResponseController, lastWrite *atomic.Int64) func() {
	idle := s.opts.Transcode.IdleTimeout
	stop, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		tick := time.NewTicker(min(30*time.Second, max(idle/4, 10*time.Millisecond)))
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				_ = rc.SetWriteDeadline(time.Now())
				return
			case now := <-tick.C:
				if now.Sub(time.Unix(0, lastWrite.Load())) > idle {
					s.log.Info("killing idle video conversion", "infohash", j.key.ih.HexString(), "file", j.key.file, "idle", idle)
					j.cancel(errJobIdle)
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(stop) })
		<-stopped
	}
}

// jobInput serves file f at path (GET/HEAD with Range) and nothing else: ffmpeg's input.
func (s *Server) jobInput(e *entry, f *torrent.File, path string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		rd := f.NewReader()
		defer rd.Close()
		// ffmpeg doesn't verify pieces, so (unlike the web seed) wait for verified data.
		rd.SetContext(r.Context())
		ra := s.opts.Readahead
		rd.SetReadaheadFunc(func(torrent.ReadaheadContext) int64 { return ra })
		pr := &progressReader{ReadSeeker: rd}
		defer s.watchStall(r.Context(), e, pr)()
		http.ServeContent(w, r, "", time.Time{}, pr)
	})
}

// readSome reads until it gets at least one byte or an error.
func readSome(r io.Reader, buf []byte) (int, error) {
	for {
		n, err := r.Read(buf)
		if n > 0 || err != nil {
			return n, err
		}
	}
}

// tailBuffer keeps the last max bytes written to it (ffmpeg's stderr).
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
	// redact is replaced by "<input>" in LastLines (the job URL means nothing to the user).
	redact string
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		t.buf = slices.Clone(t.buf[over:])
	}
	return len(p), nil
}

// LastLines returns up to n last non-empty lines, joined with "; ".
func (t *tailBuffer) LastLines(n int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var lines []string
	for l := range bytes.Lines(t.buf) {
		s := strings.TrimSpace(string(l))
		if t.redact != "" {
			s = strings.ReplaceAll(s, t.redact, "<input>")
		}
		if s != "" {
			lines = append(lines, s)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "; ")
}
