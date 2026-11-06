// Package relay is webtor's BitTorrent relay: a full BitTorrent client (anacrolix/torrent: TCP, uTP,
// DHT, UDP/HTTP trackers, PEX) that the browser app reaches over plain HTTP. The app uses it as
//
//   - an `xs=` metadata source: GET {base}/v1/torrents/{infohash}/metainfo?<magnet query> returns the
//     .torrent once the relay has fetched the info dictionary from the swarm, and
//   - a BEP-19 web seed: GET {base}/v1/torrents/{infohash}/webseed/[<name>/<path>] serves file bytes
//     with HTTP Range, downloading the covering pieces from regular peers on demand, and
//   - a video converter (optional, needs ffmpeg): GET {base}/v1/torrents/{infohash}/transcode/{file}
//     streams a file's video as fragmented H.264 MP4 (transcode.go, ADR 0007).
//
// WebTorrent in the page then verifies every piece hash itself, so the browser pipeline is unchanged.
// See docs/decisions/0006-regular-peers-relay.md.
package relay

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
)

// Version is reported by GET {base}/v1/info; set with -ldflags at release time.
var Version = "dev"

// Defaults for zero Options fields.
const (
	DefaultMaxTorrents     = 3
	DefaultMetadataTimeout = 90 * time.Second
	DefaultIdleTimeout     = 10 * time.Minute
	DefaultEvictAfter      = time.Minute
	DefaultReadahead       = 32 << 20
	// DefaultMaxUploadRate caps uploading to peers (bytes/s), so seeding never takes the uplink the
	// browser stream needs (ADR 0006, "Throughput").
	DefaultMaxUploadRate = 1 << 20
)

// Options configure a Server.
type Options struct {
	// Token is the secret first path segment of every API URL ({base} = scheme://host/{token}). Required.
	Token string
	// MaxTorrents caps the torrents held at once; adding one more answers 429.
	MaxTorrents int
	// MetadataTimeout bounds how long a metainfo request waits for the swarm (then 504).
	MetadataTimeout time.Duration
	// IdleTimeout drops a torrent (and deletes its data) once no request has touched it for this long.
	IdleTimeout time.Duration
	// EvictAfter: when MaxTorrents is reached, a torrent idle for this long is dropped to make room
	// for a new one instead of answering 429 (the tab that opened it has moved on).
	EvictAfter time.Duration
	// ExtraTrackers are announced to for every torrent, in addition to the magnet's own `tr=`.
	ExtraTrackers []string
	// Readahead is the least the relay keeps downloading past each served range; it grows with the
	// served rate (AdaptiveReadahead: ReadaheadSeconds of the stream) up to MaxReadahead.
	Readahead    int64
	MaxReadahead int64
	// UploadLimit is reported by /v1/info and stats only (the client's limiter enforces it): bytes/s
	// to peers, 0 = unlimited, -1 = no upload.
	UploadLimit int64
	// DataDir, when set, is the client's NewStorage directory: a torrent's data dir is deleted on drop.
	DataDir string
	// Transcode configures video conversion; its FFmpeg path turns it on.
	Transcode TranscodeOptions
	// App, when set, is served at "/" (the embedded web app).
	App    fs.FS
	Logger *slog.Logger
	// Diagnostics, when set, is the store hooked into the client (Diagnostics.Instrument); New makes
	// an unhooked one otherwise, which still records the relay's own events.
	Diagnostics *Diagnostics
}

// Server is the HTTP side of the relay. It owns no listener; mount Handler() anywhere.
type Server struct {
	cl   *torrent.Client
	opts Options
	log  *slog.Logger
	diag *Diagnostics
	// throttle keeps repeated stdout lines (failing requests, nudges) to one per LogEvery.
	throttle *logThrottle

	mu       sync.Mutex
	torrents map[metainfo.Hash]*entry
	closed   bool
	// jobs are the running video conversions (transcode.go); jobsStopped refuses new ones.
	jobs        map[jobKey]*transcodeJob
	jobsStopped bool
}

type entry struct {
	ih metainfo.Hash
	t  *torrent.Torrent
	// active counts requests in flight; a torrent is never dropped while one runs.
	active   int
	lastUsed time.Time
	added    time.Time
	// window holds the pieces past the last requested range that keep downloading between the
	// browser's requests (Normal priority; see prefetchFrom).
	window pieceRange
	// windowHeldUntil keeps the window off after it starved a read (see unstarve).
	windowHeldUntil time.Time
	// served counts the bytes sent to the browser (web seed and conversions); the meters turn it
	// and the client's counters into rates for stats and the adaptive readahead.
	served               atomic.Int64
	servedRate, down, up rateMeter
	readahead            atomic.Int64
	// lastNudge rate-limits watchStall's re-requests.
	lastNudge time.Time
}

// ErrTooManyTorrents is returned (as 429) when MaxTorrents torrents are busy.
var ErrTooManyTorrents = errors.New("too many torrents open on this relay")

var errClosed = errors.New("relay is shutting down")

// New wraps an existing client. Callers own the client's lifetime; call Close before closing it.
func New(cl *torrent.Client, opts Options) (*Server, error) {
	if len(opts.Token) < 8 || strings.ContainsAny(opts.Token, "/?#%") {
		return nil, errors.New("relay: token must be at least 8 characters, without / ? # %")
	}
	if opts.MaxTorrents <= 0 {
		opts.MaxTorrents = DefaultMaxTorrents
	}
	if opts.MetadataTimeout <= 0 {
		opts.MetadataTimeout = DefaultMetadataTimeout
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = DefaultIdleTimeout
	}
	if opts.EvictAfter <= 0 {
		opts.EvictAfter = min(DefaultEvictAfter, opts.IdleTimeout)
	}
	if opts.Readahead <= 0 {
		opts.Readahead = DefaultReadahead
	}
	if opts.MaxReadahead <= 0 {
		opts.MaxReadahead = DefaultMaxReadahead
	}
	opts.MaxReadahead = max(opts.MaxReadahead, opts.Readahead)
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if err := opts.Transcode.setDefaults(); err != nil {
		return nil, err
	}
	if opts.Diagnostics == nil {
		opts.Diagnostics = NewDiagnostics()
	}
	return &Server{
		cl: cl, opts: opts, log: opts.Logger, diag: opts.Diagnostics, throttle: newLogThrottle(LogEvery),
		torrents: map[metainfo.Hash]*entry{}, jobs: map[jobKey]*transcodeJob{},
	}, nil
}

// RunJanitor drops idle torrents until ctx is done.
func (s *Server) RunJanitor(ctx context.Context) {
	tick := time.NewTicker(min(30*time.Second, max(s.opts.IdleTimeout/4, 10*time.Millisecond)))
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			s.dropIdle(now)
		}
	}
}

func (s *Server) dropIdle(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.torrents {
		if e.active == 0 && now.Sub(e.lastUsed) > s.opts.IdleTimeout {
			s.dropLocked(e, "idle")
		}
	}
}

// Close kills every video conversion, drops every torrent and deletes its data. New requests get
// 503 afterwards.
func (s *Server) Close() {
	s.StopTranscodes()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, e := range s.torrents {
		s.dropLocked(e, "shutdown")
	}
}

// Torrents is the number of torrents held.
func (s *Server) Torrents() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.torrents)
}

func (s *Server) dropLocked(e *entry, reason string) {
	s.log.Info("dropping torrent", "infohash", e.ih.HexString(), "reason", reason)
	e.t.Drop()
	delete(s.torrents, e.ih)
	s.diag.unregister(e.ih)
	s.diag.globalEvent("torrent-dropped", "infoHash", e.ih.HexString(), "reason", reason, "livedMs", time.Since(e.added))
	if s.opts.DataDir != "" {
		if err := os.RemoveAll(TorrentDir(s.opts.DataDir, e.ih)); err != nil {
			s.log.Warn("deleting torrent data", "infohash", e.ih.HexString(), "err", err)
		}
	}
}

// Handler serves the API under /{token}/v1/ (CORS for any origin: the token is the access control)
// and Options.App everywhere else.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/info", s.handleInfo)
	mux.HandleFunc("GET /v1/diagnostics", s.handleDiagnostics)
	mux.HandleFunc("GET /v1/torrents/{ih}/metainfo", s.handleMetainfo)
	mux.HandleFunc("POST /v1/torrents/{ih}/metainfo", s.handlePostMetainfo)
	mux.HandleFunc("GET /v1/torrents/{ih}/stats", s.handleStats)
	mux.HandleFunc("GET /v1/torrents/{ih}/files", s.handleFiles)
	mux.HandleFunc("GET /v1/torrents/{ih}/webseed/{path...}", s.handleWebseed)
	mux.HandleFunc("HEAD /v1/torrents/{ih}/webseed/{path...}", s.handleWebseed)
	mux.HandleFunc("GET /v1/torrents/{ih}/transcode/{fileIndex}", s.handleTranscode)
	api := cors(s.logRequests(mux))
	app := appHandler(s.opts.App)
	prefix := "/" + s.opts.Token
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seg, rest, ok := splitFirstSegment(r.URL.Path); ok &&
			subtle.ConstantTimeCompare([]byte(seg), []byte(s.opts.Token)) == 1 {
			r2 := r.Clone(r.Context())
			r2.URL.Path = rest
			r2.URL.RawPath = strings.TrimPrefix(r.URL.RawPath, prefix)
			api.ServeHTTP(w, r2)
			return
		}
		app.ServeHTTP(w, r)
	})
}

// splitFirstSegment splits "/seg/rest" into "seg" and "/rest"; ok is false without a second slash.
func splitFirstSegment(p string) (seg, rest string, ok bool) {
	if !strings.HasPrefix(p, "/") {
		return "", "", false
	}
	i := strings.IndexByte(p[1:], '/')
	if i < 0 {
		return "", "", false
	}
	return p[1 : i+1], p[i+1:], true
}

func appHandler(app fs.FS) http.Handler {
	if app == nil {
		return http.NotFoundHandler()
	}
	files := http.FileServerFS(app)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h := w.Header()
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		files.ServeHTTP(w, r)
	})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
		if r.Method == http.MethodOptions {
			// WebTorrent sends Range, Cache-Control and User-Agent; Chrome's old Private Network
			// Access preflight asked for the last header (harmless under Local Network Access).
			h.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
			if req := r.Header.Get("Access-Control-Request-Headers"); req != "" {
				h.Set("Access-Control-Allow-Headers", req)
			}
			h.Set("Access-Control-Allow-Private-Network", "true")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// logRequests logs API requests at debug level, and failures at info/warn. It runs after the token
// was stripped from the path, so it can never log the token.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		next.ServeHTTP(sw, r)
		lvl := slog.LevelDebug
		switch {
		case sw.code >= 500 && sw.code != http.StatusGatewayTimeout:
			lvl = slog.LevelWarn
		case sw.code >= 400:
			lvl = slog.LevelInfo
		}
		attrs := []any{"method", r.Method, "path", r.URL.Path, "range", r.Header.Get("Range"), "status", sw.code,
			"took", time.Since(start).Round(time.Millisecond)}
		if lvl > slog.LevelDebug {
			ok, suppressed := s.throttle.allow(fmt.Sprint("request ", sw.code, " ", routeOf(r.URL.Path)), time.Now())
			if !ok {
				return
			}
			if suppressed > 0 {
				attrs = append(attrs, "suppressed", suppressed)
			}
		}
		s.log.Log(r.Context(), lvl, "request", attrs...)
	})
}

// routeOf is a request path without its torrent and file parts ("/v1/torrents/*/webseed"), the key
// that throttles its log lines.
func routeOf(p string) string {
	parts := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 5)
	if len(parts) >= 3 && parts[1] == "torrents" {
		parts[2] = "*"
	}
	return "/" + strings.Join(parts[:min(len(parts), 4)], "/")
}

type statusWriter struct {
	http.ResponseWriter
	code        int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.code, w.wroteHeader = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// APIVersion is /v1/info's "api": 2 added .../transcode/{fileIndex} and the "transcode" object; 3
// added the rates to .../stats and "uploadLimit"; 4 added GET /v1/diagnostics.
const APIVersion = 4

// TranscodeInfo is /v1/info's "transcode" object.
type TranscodeInfo struct {
	Available     bool   `json:"available"`
	FFmpeg        string `json:"ffmpeg"`
	MaxHeight     int    `json:"maxHeight"`
	Preset        string `json:"preset"`
	MaxTranscodes int    `json:"maxTranscodes"`
}

func (s *Server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	t := s.opts.Transcode
	writeJSON(w, http.StatusOK, map[string]any{
		"name": "webtor-relay", "version": Version, "api": APIVersion, "uploadLimit": s.opts.UploadLimit,
		"transcode": TranscodeInfo{
			Available: t.FFmpeg != "", FFmpeg: t.FFmpegVersion, MaxHeight: t.MaxHeight, Preset: t.Preset,
			MaxTranscodes: t.MaxJobs,
		},
	})
}

// handleMetainfo adds the torrent (magnet params in the query: tr=, dn=, x.pe=, ws=) and waits for
// its info dictionary.
func (s *Server) handleMetainfo(w http.ResponseWriter, r *http.Request) {
	ih, err := parseInfoHash(r.PathValue("ih"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	e, err := s.acquire(ih, r.URL.Query(), "magnet")
	if err != nil {
		s.addError(w, err)
		return
	}
	defer s.release(e)
	ctx, cancel := context.WithTimeout(r.Context(), s.opts.MetadataTimeout)
	defer cancel()
	waitStart := time.Now()
	select {
	case <-e.t.GotInfo():
	case <-ctx.Done():
		if r.Context().Err() == nil {
			st := e.t.Stats()
			s.diag.event(ih, "metainfo-timeout", "waitedMs", time.Since(waitStart), "peers", st.TotalPeers,
				"connected", st.ActivePeers, "halfOpen", st.HalfOpenPeers)
		}
		httpError(w, http.StatusGatewayTimeout, errors.New("no metadata from the swarm yet"))
		return
	}
	s.writeInfoDict(w, e)
}

// writeInfoDict answers a metainfo request: only the info dictionary, because the page can't use
// the UDP/HTTP trackers the relay knows, and the app passes its own WebSocket trackers to WebTorrent.
func (s *Server) writeInfoDict(w http.ResponseWriter, e *entry) {
	mi := metainfo.MetaInfo{InfoBytes: e.t.Metainfo().InfoBytes}
	w.Header().Set("Content-Type", "application/x-bittorrent")
	w.Header().Set("Cache-Control", "no-store")
	if err := mi.Write(w); err != nil {
		s.log.Debug("writing metainfo", "err", err)
	}
}

// maxTorrentFile caps a POSTed .torrent (the app's own limit is the same).
const maxTorrentFile = 16 << 20

// handlePostMetainfo adds a torrent from its .torrent file (the request body) and answers like GET.
// The app uses it for a .torrent the user opened (ADR 0007 §2): the relay then needs no metadata
// from the swarm, and gets the file's trackers and web seeds.
func (s *Server) handlePostMetainfo(w http.ResponseWriter, r *http.Request) {
	ih, err := parseInfoHash(r.PathValue("ih"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	mi, err := metainfo.Load(http.MaxBytesReader(w, r.Body, maxTorrentFile))
	if err != nil {
		httpError(w, http.StatusBadRequest, fmt.Errorf("not a .torrent file: %w", err))
		return
	}
	if mi.HashInfoBytes() != ih {
		httpError(w, http.StatusBadRequest, errors.New("the .torrent is for another info hash"))
		return
	}
	spec, err := torrent.TorrentSpecFromMetaInfoErr(mi)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	e, err := s.acquireSpec(ih, "metainfo", spec)
	if err != nil {
		s.addError(w, err)
		return
	}
	defer s.release(e)
	s.writeInfoDict(w, e)
}

func (s *Server) addError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrTooManyTorrents):
		s.diag.globalEvent("too-many-torrents", "maxTorrents", s.opts.MaxTorrents)
		w.Header().Set("Retry-After", fmt.Sprint(int(s.opts.EvictAfter.Seconds())))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":       fmt.Sprintf("%v (max %d); close another one or wait", err, s.opts.MaxTorrents),
			"maxTorrents": s.opts.MaxTorrents,
		})
	case errors.Is(err, errClosed):
		httpError(w, http.StatusServiceUnavailable, err)
	case errors.Is(err, errAddFailed):
		httpError(w, http.StatusInternalServerError, err)
	default:
		httpError(w, http.StatusBadRequest, err)
	}
}

// Stats is the JSON body of GET .../stats.
type Stats struct {
	InfoHash        string `json:"infoHash"`
	HasMetadata     bool   `json:"hasMetadata"`
	Peers           int    `json:"peers"`
	ActivePeers     int    `json:"activePeers"`
	Seeders         int    `json:"seeders"`
	BytesCompleted  int64  `json:"bytesCompleted"`
	BytesReadData   int64  `json:"bytesReadData"`
	BytesWrittenOut int64  `json:"bytesWrittenData"`
	// Rates in bytes/s over the last few seconds (api 3): useful data from peers, data uploaded to
	// peers, and data sent to the browser. With servedRate well under downloadRate the relay's
	// uplink or the browser is the limit; with downloadRate low, the swarm is.
	DownloadRate int64 `json:"downloadRate"`
	UploadRate   int64 `json:"uploadRate"`
	ServedRate   int64 `json:"servedRate"`
	BytesServed  int64 `json:"bytesServed"`
	// Readahead is the current prefetch window in bytes; UploadLimit as in /v1/info.
	Readahead   int64 `json:"readahead"`
	UploadLimit int64 `json:"uploadLimit"`
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	e, ok := s.existing(w, r, http.StatusNotFound)
	if !ok {
		return
	}
	defer s.release(e)
	st := e.t.Stats()
	now := time.Now()
	served := e.served.Load()
	out := Stats{
		InfoHash:        e.ih.HexString(),
		Peers:           st.TotalPeers,
		ActivePeers:     st.ActivePeers,
		Seeders:         st.ConnectedSeeders,
		BytesReadData:   st.BytesReadData.Int64(),
		BytesWrittenOut: st.BytesWrittenData.Int64(),
		DownloadRate:    int64(e.down.observe(now, st.BytesReadUsefulData.Int64())),
		UploadRate:      int64(e.up.observe(now, st.BytesWrittenData.Int64())),
		ServedRate:      int64(e.servedRate.observe(now, served)),
		BytesServed:     served,
		Readahead:       e.readahead.Load(),
		UploadLimit:     s.opts.UploadLimit,
	}
	if e.t.Info() != nil {
		out.HasMetadata = true
		out.BytesCompleted = e.t.BytesCompleted()
	}
	writeJSON(w, http.StatusOK, out)
}

// FileInfo is one entry of GET .../files. WebseedPath is what to append to .../webseed/.
type FileInfo struct {
	Index       int    `json:"index"`
	Path        string `json:"path"`
	Length      int64  `json:"length"`
	WebseedPath string `json:"webseedPath"`
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	e, ok := s.withInfo(w, r)
	if !ok {
		return
	}
	defer s.release(e)
	files := e.t.Files()
	out := make([]FileInfo, len(files))
	for i, f := range files {
		wp := f.Path()
		if len(files) == 1 {
			wp = ""
		}
		out[i] = FileInfo{Index: i, Path: f.DisplayPath(), Length: f.Length(), WebseedPath: wp}
	}
	writeJSON(w, http.StatusOK, out)
}

// existing finds an added torrent and marks a request on it as active (release it when done), or
// answers with missingCode.
func (s *Server) existing(w http.ResponseWriter, r *http.Request, missingCode int) (*entry, bool) {
	ih, err := parseInfoHash(r.PathValue("ih"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return nil, false
	}
	s.mu.Lock()
	e := s.torrents[ih]
	if e != nil {
		e.active++
	}
	s.mu.Unlock()
	if e == nil {
		// The app always fetches metainfo first; anything else is a stale tab or a relay restart.
		// For the web seed, 503 makes WebTorrent retry the piece later.
		httpError(w, missingCode, errors.New("torrent not added; fetch metainfo first"))
		return nil, false
	}
	return e, true
}

// withInfo is existing for a torrent that has its metadata.
func (s *Server) withInfo(w http.ResponseWriter, r *http.Request) (*entry, bool) {
	e, ok := s.existing(w, r, http.StatusServiceUnavailable)
	if ok && e.t.Info() == nil {
		s.release(e)
		httpError(w, http.StatusServiceUnavailable, errors.New("no metadata yet; fetch metainfo first"))
		return nil, false
	}
	return e, ok
}

func (s *Server) handleWebseed(w http.ResponseWriter, r *http.Request) {
	e, ok := s.withInfo(w, r)
	if !ok {
		return
	}
	defer s.release(e)
	files := e.t.Files()
	wf := make([]WebseedFile, len(files))
	for i, f := range files {
		wf[i] = WebseedFile{Path: f.Path(), Length: f.Length()}
	}
	query := ""
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		query = "?" + r.URL.RawQuery
	}
	idx, ok := ResolveWebseedPath(wf, r.PathValue("path"), query, RangeMinLength(r.Header.Get("Range")))
	if !ok {
		httpError(w, http.StatusNotFound, fmt.Errorf("no such file: %q", r.PathValue("path")))
		return
	}
	f := files[idx]
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/octet-stream")
	if r.Method == http.MethodHead {
		http.ServeContent(w, r, "", time.Time{}, io.NewSectionReader(nopReaderAt{}, 0, f.Length()))
		return
	}
	// Download the whole requested range at once, and once it is served the readahead after it with
	// a lower priority, so the next request (WebTorrent asks piece by piece) usually finds its data
	// already here. The window moves only after the read: its chunks are requested from the peers
	// first, and anacrolix never takes a sent request back for a more urgent one (on a slow swarm
	// the range waited behind the whole window). A read away from the window drops it at once.
	start, end := RangeStart(r.Header.Get("Range")), RangeEnd(r.Header.Get("Range"), f.Length())
	ra := s.readaheadFor(e)
	s.leaveWindow(e, f, start, end)
	if end < f.Length() {
		defer s.prefetchFrom(e, f, end, ra)
	}
	rd := f.NewReader()
	defer rd.Close()
	rd.SetContext(r.Context())
	// The page re-verifies every piece hash, so don't wait for the relay's own verification.
	rd.SetResponsive()
	rd.SetReadaheadFunc(func(rc torrent.ReadaheadContext) int64 {
		if end < f.Length() {
			return max(end-rc.CurrentPos, 0)
		}
		return ra
	})
	pr := &progressReader{ReadSeeker: rd, total: &e.served}
	began, rangeStart := time.Now(), int64(0)
	if first, _, ok := parseRange(r.Header.Get("Range")); ok {
		rangeStart = first
	}
	missing := s.missingPieces(e, f.Offset()+rangeStart, end-rangeStart)
	stop := s.watchStall(r.Context(), e, pr)
	http.ServeContent(w, r, "", time.Time{}, pr)
	stop()
	s.recordWebseed(r, e, idx, rangeStart, end, missing, began, pr)
}

// slowTTFB is when a web seed request counts as slow (and gets a diagnostics event).
const slowTTFB = time.Second

// recordWebseed adds a served web seed request to the diagnostics.
func (s *Server) recordWebseed(r *http.Request, e *entry, file int, start, end int64, missing int, began time.Time, pr *progressReader) {
	sent := pr.n.Load()
	incomplete := sent < end-start
	ttfb := time.Duration(0)
	if fb := pr.firstByte.Load(); fb != 0 {
		ttfb = time.Duration(fb - began.UnixNano())
	} else {
		ttfb = time.Since(began)
	}
	kv := []any{"file", file, "start", start, "end", end, "missingPieces", missing, "bytes", sent,
		"ttfbMs", ttfb, "tookMs", time.Since(began)}
	if incomplete {
		reason := "client gone"
		if err := pr.readErr(); err != nil {
			reason = err.Error()
		} else if r.Context().Err() == nil {
			reason = "unknown"
		}
		kv = append(kv, "incomplete", reason)
	}
	s.diag.webseedRequest(e.ih, ttfb >= slowTTFB, incomplete, ttfb, kv...)
}

// missingPieces counts the pieces of n bytes at off that the relay doesn't have yet.
func (s *Server) missingPieces(e *entry, off, n int64) int {
	info := e.t.Info()
	if info == nil {
		return 0
	}
	begin, end := pieceSpan(off, n, e.t.Length(), info.PieceLength)
	missing := 0
	for i := begin; i < end; i++ {
		if !e.t.PieceState(i).Complete {
			missing++
		}
	}
	return missing
}

// stallCheck is how long a webseed read may go without any data, from this request or from the
// torrent's peers, before the relay re-requests its pieces. A var so tests can shorten it.
var stallCheck = 3 * time.Second

// progressReader counts the bytes served, so watchStall can tell a slow read from a stuck one.
type progressReader struct {
	io.ReadSeeker
	n atomic.Int64
	// total is the torrent's served counter (entry.served).
	total *atomic.Int64
	// firstByte is when the first byte was read (unix ns), err the last read error but EOF.
	firstByte atomic.Int64
	mu        sync.Mutex
	err       error
}

func (p *progressReader) readErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.ReadSeeker.Read(b)
	// nudge turns download off for an instant; anacrolix fails waiting reads meanwhile.
	for tries := 0; n == 0 && err != nil && err.Error() == errDownloadDisabled && tries < 50; tries++ {
		time.Sleep(10 * time.Millisecond)
		n, err = p.ReadSeeker.Read(b)
	}
	if n > 0 && p.firstByte.Load() == 0 {
		p.firstByte.CompareAndSwap(0, time.Now().UnixNano())
	}
	if err != nil && !errors.Is(err, io.EOF) {
		p.mu.Lock()
		p.err = err
		p.mu.Unlock()
	}
	p.n.Add(int64(n))
	if p.total != nil {
		p.total.Add(int64(n))
	}
	return n, err
}

// errDownloadDisabled is the text of anacrolix's unexported read error while DisallowDataDownload
// is in effect.
const errDownloadDisabled = "torrent data downloading disabled"

// watchStall works around a missed request update in anacrolix/torrent: now and then a connection
// to a seeder stays interested and unchoked but holds no requests while a reader waits, and nothing
// wakes it until the keep-alive reconnect a minute later (the browser gives up after 60 s). When
// neither this read nor the torrent made progress for a stallCheck, the relay reconnects. Returns the function that stops it.
func (s *Server) watchStall(ctx context.Context, e *entry, pr *progressReader) func() {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		tick := time.NewTicker(stallCheck)
		defer tick.Stop()
		served, chunks := pr.n.Load(), usefulChunks(e.t)
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			nowServed, nowChunks := pr.n.Load(), usefulChunks(e.t)
			if nowServed == served && !e.t.Complete().Bool() {
				if nowChunks == chunks {
					s.nudge(e)
				} else {
					s.unstarve(e)
				}
			}
			served, chunks = nowServed, nowChunks
		}
	}()
	return cancel
}

func usefulChunks(t *torrent.Torrent) int64 {
	st := t.Stats()
	return st.ChunksReadUseful.Int64()
}

// nudge makes the client re-request the torrent's wanted pieces, at most once per stallCheck.
func (s *Server) nudge(e *entry) {
	s.rerequest(e, "no data for a while, re-requesting pieces")
}

// windowHold is how long the prefetch window stays off after it starved a read.
func windowHold() time.Duration { return 10 * stallCheck }

// unstarve handles a read that got nothing for a stallCheck while the torrent got data: the peers
// are busy with the window's requests. It drops the window, keeps it off for windowHold (on a swarm
// slower than the browser, the browser's own requests are all it can keep up with) and re-requests.
func (s *Server) unstarve(e *entry) {
	s.mu.Lock()
	if s.torrents[e.ih] != e || e.window.begin >= e.window.end {
		s.mu.Unlock()
		return
	}
	s.cancelWindowLocked(e)
	e.windowHeldUntil = time.Now().Add(windowHold())
	s.mu.Unlock()
	s.rerequest(e, "a read waits behind the prefetch window, dropping it and re-requesting pieces")
}

// leaveWindow drops the prefetch window when a read of [start, end) in f needs pieces outside it
// (a seek, the MKV Cues near the end), and re-requests, so the read is first in every peer's queue.
func (s *Server) leaveWindow(e *entry, f *torrent.File, start, end int64) {
	info := e.t.Info()
	if info == nil || start >= end {
		return
	}
	begin, stop := pieceSpan(f.Offset()+start, end-start, e.t.Length(), info.PieceLength)
	if !hasIncomplete(e.t, begin, stop) {
		return
	}
	s.mu.Lock()
	if s.torrents[e.ih] != e || !outsideWindow(e.window, pieceRange{begin, stop}) {
		s.mu.Unlock()
		return
	}
	s.cancelWindowLocked(e)
	s.mu.Unlock()
	s.rerequest(e, "a read away from the prefetch window, dropping it and re-requesting pieces")
}

func hasIncomplete(t *torrent.Torrent, begin, end int) bool {
	for i := begin; i < end; i++ {
		if !t.Piece(i).State().Complete {
			return true
		}
	}
	return false
}

func (s *Server) cancelWindowLocked(e *entry) {
	if e.window.begin < e.window.end {
		e.t.CancelPieces(e.window.begin, e.window.end)
	}
	e.window = pieceRange{}
}

// rerequest cancels every request of the torrent so the client makes them again in priority order,
// at most once per stallCheck.
func (s *Server) rerequest(e *entry, why string) {
	s.mu.Lock()
	if s.torrents[e.ih] != e || time.Since(e.lastNudge) < stallCheck {
		s.mu.Unlock()
		return
	}
	e.lastNudge = time.Now()
	s.mu.Unlock()
	st := e.t.Stats()
	s.diag.event(e.ih, "nudge", "why", why, "connected", st.ActivePeers, "seeders", st.ConnectedSeeders,
		"usefulChunks", st.ChunksReadUseful.Int64())
	if ok, suppressed := s.throttle.allow("nudge "+e.ih.HexString(), e.lastNudge); ok {
		s.log.Info(why, "infohash", e.ih.HexString(), "suppressed", suppressed)
	}
	// Only cancelling every request unsticks it (just recomputing requests doesn't); in the browser
	// that happens when its 60 s timeout closes the readers. Readers fail while download is off;
	// progressReader retries that.
	e.t.DisallowDataDownload()
	e.t.AllowDataDownload()
}

// nopReaderAt lets ServeContent answer HEAD (it only needs the size) without touching the torrent.
type nopReaderAt struct{}

func (nopReaderAt) ReadAt([]byte, int64) (int, error) { return 0, io.EOF }

// readaheadFor is the torrent's prefetch window now: ReadaheadSeconds of its recent served rate,
// within Options.Readahead and MaxReadahead.
func (s *Server) readaheadFor(e *entry) int64 {
	rate := e.servedRate.observe(time.Now(), e.served.Load())
	ra := AdaptiveReadahead(rate, s.opts.Readahead, s.opts.MaxReadahead)
	e.readahead.Store(ra)
	return ra
}

// prefetchFrom moves the torrent's prefetch window to the ra bytes after off within f, so they keep
// downloading while the browser is busy elsewhere. The window raises piece priorities to Normal:
// a torrent.Reader that only seeks (never reads) wants no pieces at all in anacrolix, which made
// the old prefetch reader a no-op (ADR 0006, "Throughput"). Requested ranges (the web seed's own
// readers) keep their higher reader priority.
func (s *Server) prefetchFrom(e *entry, f *torrent.File, off, ra int64) {
	info := e.t.Info()
	if info == nil {
		return
	}
	begin, end := pieceSpan(f.Offset()+off, min(ra, f.Length()-off), e.t.Length(), info.PieceLength)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.torrents[e.ih] != e {
		return // dropped meanwhile
	}
	if time.Now().Before(e.windowHeldUntil) {
		s.cancelWindowLocked(e)
		return
	}
	old, want := e.window, pieceRange{begin, end}
	next, cancel := nextWindow(old, want)
	e.window = next
	if old.begin >= old.end || want.begin > old.end || want.end < old.begin {
		s.diag.event(e.ih, "window", "begin", next.begin, "end", next.end, "from", [2]int{old.begin, old.end})
	}
	for _, c := range cancel {
		e.t.CancelPieces(c.begin, c.end)
	}
	if next.begin < next.end {
		e.t.DownloadPieces(next.begin, next.end)
	}
}

// acquire finds or adds the torrent and marks a request on it as active.
func (s *Server) acquire(ih metainfo.Hash, q url.Values, source string) (*entry, error) {
	return s.acquireSpec(ih, source, &torrent.TorrentSpec{
		DisplayName: q.Get("dn"),
		Trackers:    [][]string{q["tr"]},
		PeerAddrs:   q["x.pe"],
		Webseeds:    q["ws"],
	})
}

// acquireSpec is acquire for a torrent described by spec (magnet params, or a whole .torrent with
// InfoBytes). A torrent already open gets what spec adds (info, trackers, web seeds).
// source ("magnet", "metainfo") goes to the diagnostics.
func (s *Server) acquireSpec(ih metainfo.Hash, source string, spec *torrent.TorrentSpec) (*entry, error) {
	if len(spec.Trackers) == 0 {
		spec.Trackers = [][]string{nil}
	}
	spec.Trackers[0] = append(spec.Trackers[0], s.opts.ExtraTrackers...)
	var cleanup trackerCleanup
	spec.Trackers, cleanup = usableTrackers(spec.Trackers)
	spec.InfoHash = ih
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errClosed
	}
	if len(s.torrents) >= s.opts.MaxTorrents && s.torrents[ih] == nil {
		s.evictLocked(time.Now())
	}
	if len(s.torrents) >= s.opts.MaxTorrents && s.torrents[ih] == nil {
		return nil, ErrTooManyTorrents
	}
	t, err := s.addSpec(ih, spec)
	if err != nil {
		return nil, err
	}
	if e := s.torrents[ih]; e != nil {
		e.active++
		return e, nil
	}
	s.log.Info("added torrent", "infohash", ih.HexString(), "name", spec.DisplayName, "torrents", len(s.torrents)+1)
	now := time.Now()
	e := &entry{ih: ih, t: t, lastUsed: now, added: now, active: 1}
	s.torrents[ih] = e
	s.diag.register(ih)
	trackers := 0
	for _, tier := range spec.Trackers {
		trackers += len(tier)
	}
	kv := []any{"source", source, "trackers", trackers, "webSeeds", len(spec.Webseeds), "directPeers", len(spec.PeerAddrs)}
	if cleanup.ignored > 0 || cleanup.loginsRemoved > 0 {
		kv = append(kv, "trackersIgnored", cleanup.ignored, "trackerLoginsRemoved", cleanup.loginsRemoved)
	}
	if len(spec.InfoBytes) > 0 {
		var info metainfo.Info
		if bencode.Unmarshal(spec.InfoBytes, &info) == nil {
			kv = append(kv, "private", info.Private != nil && *info.Private)
		}
	}
	s.diag.event(ih, "added", kv...)
	s.diag.globalEvent("torrent-added", "infoHash", ih.HexString(), "source", source, "torrents", len(s.torrents))
	go s.watchMetainfo(e)
	return e, nil
}

// errAddFailed answers an add that panicked inside the torrent library. The panic value is never
// shown or logged: it can hold a tracker URL with its credentials.
var errAddFailed = errors.New("the BitTorrent client could not add this torrent")

// addSpec adds spec to the client, or merges it into the torrent already open (trackers, web
// seeds, info bytes). A panic in the library becomes errAddFailed; a torrent it left half-added is
// dropped. Call with s.mu held.
func (s *Server) addSpec(ih metainfo.Hash, spec *torrent.TorrentSpec) (t *torrent.Torrent, err error) {
	defer func() {
		if recover() == nil {
			return
		}
		s.log.Error("the torrent library panicked adding a torrent", "infohash", ih.HexString())
		s.diag.globalEvent("add-panicked", "infoHash", ih.HexString())
		if s.torrents[ih] == nil {
			if t, ok := s.cl.Torrent(ih); ok {
				t.Drop()
			}
		}
		t, err = nil, errAddFailed
	}()
	t, _, err = s.cl.AddTorrentSpec(spec)
	return t, err
}

// watchMetainfo records when the torrent got its info dictionary.
func (s *Server) watchMetainfo(e *entry) {
	select {
	case <-e.t.GotInfo():
	case <-e.t.Closed():
		return
	}
	info := e.t.Info()
	s.diag.event(e.ih, "metainfo", "tookMs", time.Since(e.added), "pieces", info.NumPieces(),
		"pieceLength", info.PieceLength, "files", len(info.UpvertedFiles()), "length", info.TotalLength(),
		"private", info.Private != nil && *info.Private)
}

// evictLocked drops the least recently used torrent that has been idle for EvictAfter, if any.
func (s *Server) evictLocked(now time.Time) {
	var lru *entry
	for _, e := range s.torrents {
		if e.active == 0 && now.Sub(e.lastUsed) >= s.opts.EvictAfter && (lru == nil || e.lastUsed.Before(lru.lastUsed)) {
			lru = e
		}
	}
	if lru != nil {
		s.dropLocked(lru, "evicted for a new torrent")
	}
}

func (s *Server) release(e *entry) {
	s.mu.Lock()
	e.active--
	e.lastUsed = time.Now()
	s.mu.Unlock()
}

func parseInfoHash(s string) (metainfo.Hash, error) {
	var h metainfo.Hash
	if err := h.FromHexString(strings.ToLower(s)); err != nil {
		return h, fmt.Errorf("bad info hash %q: want 40 hex digits", s)
	}
	return h, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0:0]
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}
