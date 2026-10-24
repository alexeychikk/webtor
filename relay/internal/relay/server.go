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
}

// Server is the HTTP side of the relay. It owns no listener; mount Handler() anywhere.
type Server struct {
	cl   *torrent.Client
	opts Options
	log  *slog.Logger

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
	// window holds the pieces past the last requested range that keep downloading between the
	// browser's requests (Normal priority; see prefetchFrom).
	window pieceRange
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
	return &Server{cl: cl, opts: opts, log: opts.Logger, torrents: map[metainfo.Hash]*entry{}, jobs: map[jobKey]*transcodeJob{}}, nil
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
		s.log.Log(r.Context(), lvl, "request", "method", r.Method, "path", r.URL.Path,
			"range", r.Header.Get("Range"), "status", sw.code, "took", time.Since(start).Round(time.Millisecond))
	})
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
// added the rates to .../stats and "uploadLimit".
const APIVersion = 3

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
	e, err := s.acquire(ih, r.URL.Query())
	if err != nil {
		s.addError(w, err)
		return
	}
	defer s.release(e)
	ctx, cancel := context.WithTimeout(r.Context(), s.opts.MetadataTimeout)
	defer cancel()
	select {
	case <-e.t.GotInfo():
	case <-ctx.Done():
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
	e, err := s.acquireSpec(ih, spec)
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
		w.Header().Set("Retry-After", fmt.Sprint(int(s.opts.EvictAfter.Seconds())))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":       fmt.Sprintf("%v (max %d); close another one or wait", err, s.opts.MaxTorrents),
			"maxTorrents": s.opts.MaxTorrents,
		})
	case errors.Is(err, errClosed):
		httpError(w, http.StatusServiceUnavailable, err)
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
	// Download the whole requested range at once, and the readahead after it with a lower priority,
	// so the next request (WebTorrent asks piece by piece) usually finds its data already here. A
	// seek simply moves both: data around the old position stops being prioritised.
	end := RangeEnd(r.Header.Get("Range"), f.Length())
	ra := s.readaheadFor(e)
	if end < f.Length() {
		s.prefetchFrom(e, f, end, ra)
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
	defer s.watchStall(r.Context(), e, pr)()
	http.ServeContent(w, r, "", time.Time{}, pr)
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
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.ReadSeeker.Read(b)
	// nudge turns download off for an instant; anacrolix fails waiting reads meanwhile.
	for tries := 0; n == 0 && err != nil && err.Error() == errDownloadDisabled && tries < 50; tries++ {
		time.Sleep(10 * time.Millisecond)
		n, err = p.ReadSeeker.Read(b)
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
			if nowServed == served && nowChunks == chunks && !e.t.Complete().Bool() {
				s.nudge(e)
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
	s.mu.Lock()
	if s.torrents[e.ih] != e || time.Since(e.lastNudge) < stallCheck {
		s.mu.Unlock()
		return
	}
	e.lastNudge = time.Now()
	s.mu.Unlock()
	s.log.Info("no data for a while, re-requesting pieces", "infohash", e.ih.HexString())
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
	next, cancel := nextWindow(e.window, pieceRange{begin, end})
	e.window = next
	for _, c := range cancel {
		e.t.CancelPieces(c.begin, c.end)
	}
	if next.begin < next.end {
		e.t.DownloadPieces(next.begin, next.end)
	}
}

// acquire finds or adds the torrent and marks a request on it as active.
func (s *Server) acquire(ih metainfo.Hash, q url.Values) (*entry, error) {
	return s.acquireSpec(ih, &torrent.TorrentSpec{
		DisplayName: q.Get("dn"),
		Trackers:    [][]string{q["tr"]},
		PeerAddrs:   q["x.pe"],
		Webseeds:    q["ws"],
	})
}

// acquireSpec is acquire for a torrent described by spec (magnet params, or a whole .torrent with
// InfoBytes). A torrent already open gets what spec adds (info, trackers, web seeds).
func (s *Server) acquireSpec(ih metainfo.Hash, spec *torrent.TorrentSpec) (*entry, error) {
	if len(spec.Trackers) == 0 {
		spec.Trackers = [][]string{nil}
	}
	spec.Trackers[0] = dedupe(append(spec.Trackers[0], s.opts.ExtraTrackers...))
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
	// For a torrent already open this merges spec in (trackers, web seeds, info bytes).
	t, _, err := s.cl.AddTorrentSpec(spec)
	if err != nil {
		return nil, err
	}
	if e := s.torrents[ih]; e != nil {
		e.active++
		return e, nil
	}
	s.log.Info("added torrent", "infohash", ih.HexString(), "name", spec.DisplayName, "torrents", len(s.torrents)+1)
	e := &entry{ih: ih, t: t, lastUsed: time.Now(), active: 1}
	s.torrents[ih] = e
	return e, nil
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
