// Package relay is webtor's BitTorrent relay: a full BitTorrent client (anacrolix/torrent: TCP, uTP,
// DHT, UDP/HTTP trackers, PEX) that the browser app reaches over plain HTTP. The app uses it as
//
//   - an `xs=` metadata source: GET {base}/v1/torrents/{infohash}/metainfo?<magnet query> returns the
//     .torrent once the relay has fetched the info dictionary from the swarm, and
//   - a BEP-19 web seed: GET {base}/v1/torrents/{infohash}/webseed/[<name>/<path>] serves file bytes
//     with HTTP Range, downloading the covering pieces from regular peers on demand.
//
// WebTorrent in the page then verifies every piece hash itself, so the browser pipeline is unchanged.
// See docs/decisions/0006-regular-peers-relay.md.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
)

// Version is reported by GET {base}/v1/info; set with -ldflags at release time.
var Version = "dev"

// Options configure a Server.
type Options struct {
	// Token is the secret first path segment of every URL ({base} = scheme://host/{token}). Required.
	Token string
	// MetadataTimeout bounds how long a metainfo request waits for the swarm.
	MetadataTimeout time.Duration
	// IdleTimeout drops a torrent (and its downloaded data) after no request touched it for this long.
	IdleTimeout time.Duration
	// ExtraTrackers are announced to for every torrent, in addition to the magnet's own `tr=`.
	ExtraTrackers []string
	// Readahead is how far past each served range the relay keeps downloading.
	Readahead int64
	// DataDir, when set, holds each torrent's pieces in DataDir/<infohash>; it is deleted on drop.
	DataDir string
	Logger  *slog.Logger
}

// Server is the HTTP side of the relay. It owns no listener; mount Handler() anywhere.
type Server struct {
	cl   *torrent.Client
	opts Options
	log  *slog.Logger

	mu       sync.Mutex
	torrents map[metainfo.Hash]*entry
}

type entry struct {
	t        *torrent.Torrent
	lastUsed time.Time
	// prefetch sits at the end of the last served range so the next pieces keep downloading between
	// the browser's requests.
	prefetch torrent.Reader
}

// New wraps an existing client. Callers own the client's lifetime.
func New(cl *torrent.Client, opts Options) (*Server, error) {
	if len(opts.Token) < 8 {
		return nil, errors.New("relay: token must be at least 8 characters")
	}
	if opts.MetadataTimeout == 0 {
		opts.MetadataTimeout = 90 * time.Second
	}
	if opts.IdleTimeout == 0 {
		opts.IdleTimeout = 10 * time.Minute
	}
	if opts.Readahead == 0 {
		opts.Readahead = 32 << 20
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Server{cl: cl, opts: opts, log: opts.Logger, torrents: map[metainfo.Hash]*entry{}}, nil
}

// RunJanitor drops idle torrents until ctx is done.
func (s *Server) RunJanitor(ctx context.Context) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			s.mu.Lock()
			for ih, e := range s.torrents {
				if now.Sub(e.lastUsed) > s.opts.IdleTimeout {
					s.log.Info("dropping idle torrent", "infohash", ih.HexString())
					if e.prefetch != nil {
						e.prefetch.Close()
					}
					e.t.Drop()
					delete(s.torrents, ih)
					if s.opts.DataDir != "" {
						_ = os.RemoveAll(filepath.Join(s.opts.DataDir, ih.HexString()))
					}
				}
			}
			s.mu.Unlock()
		}
	}
}

// Handler serves {token}/v1/... with CORS for any origin (the token is the access control).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	p := "/" + s.opts.Token + "/v1"
	mux.HandleFunc("GET "+p+"/info", s.handleInfo)
	mux.HandleFunc("GET "+p+"/torrents/{ih}/metainfo", s.handleMetainfo)
	mux.HandleFunc("GET "+p+"/torrents/{ih}/stats", s.handleStats)
	mux.HandleFunc("GET "+p+"/torrents/{ih}/files", s.handleFiles)
	mux.HandleFunc("GET "+p+"/torrents/{ih}/webseed/{path...}", s.handleWebseed)
	mux.HandleFunc("HEAD "+p+"/torrents/{ih}/webseed/{path...}", s.handleWebseed)
	return cors(mux)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
		if r.Method == http.MethodOptions {
			// WebTorrent sends Range, Cache-Control and User-Agent; Chrome's old Private Network
			// Access preflight asked for the last header (harmless under Local Network Access).
			h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
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

func (s *Server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"name": "webtor-relay", "version": Version, "api": 1})
}

// handleMetainfo adds the torrent (magnet params in the query: tr=, dn=, x.pe=, ws=) and waits for
// its info dictionary.
func (s *Server) handleMetainfo(w http.ResponseWriter, r *http.Request) {
	e, err := s.add(r.PathValue("ih"), r.URL.Query())
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.opts.MetadataTimeout)
	defer cancel()
	select {
	case <-e.t.GotInfo():
	case <-ctx.Done():
		httpError(w, http.StatusGatewayTimeout, errors.New("no metadata from the swarm yet"))
		return
	}
	s.touch(e)
	// Only the info dictionary: the page can't use the UDP/HTTP trackers the relay knows, and the
	// app passes its own WebSocket trackers to WebTorrent.
	mi := metainfo.MetaInfo{InfoBytes: e.t.Metainfo().InfoBytes}
	w.Header().Set("Content-Type", "application/x-bittorrent")
	w.Header().Set("Cache-Control", "no-store")
	if err := mi.Write(w); err != nil {
		s.log.Warn("writing metainfo", "err", err)
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
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	ih, err := parseInfoHash(r.PathValue("ih"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	s.mu.Lock()
	e := s.torrents[ih]
	s.mu.Unlock()
	if e == nil {
		httpError(w, http.StatusNotFound, errors.New("torrent not added"))
		return
	}
	st := e.t.Stats()
	out := Stats{
		InfoHash:        ih.HexString(),
		Peers:           st.TotalPeers,
		ActivePeers:     st.ActivePeers,
		Seeders:         st.ConnectedSeeders,
		BytesReadData:   st.BytesReadData.Int64(),
		BytesWrittenOut: st.BytesWrittenData.Int64(),
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

// withInfo finds an added torrent that has its metadata, or answers the request with an error.
func (s *Server) withInfo(w http.ResponseWriter, r *http.Request) (*entry, bool) {
	ih, err := parseInfoHash(r.PathValue("ih"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return nil, false
	}
	s.mu.Lock()
	e := s.torrents[ih]
	s.mu.Unlock()
	if e == nil || e.t.Info() == nil {
		// The app always fetches metainfo first; anything else is a stale tab or a relay restart.
		// 503 makes WebTorrent retry the piece later.
		httpError(w, http.StatusServiceUnavailable, errors.New("torrent not added; fetch metainfo first"))
		return nil, false
	}
	s.touch(e)
	return e, true
}

func (s *Server) handleWebseed(w http.ResponseWriter, r *http.Request) {
	e, ok := s.withInfo(w, r)
	if !ok {
		return
	}
	files := e.t.Files()
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path()
	}
	idx, ok := ResolveWebseedPath(e.t.Info().Name, paths, r.PathValue("path"), r.URL.RawQuery)
	if !ok {
		httpError(w, http.StatusNotFound, fmt.Errorf("no such file: %q", r.PathValue("path")))
		return
	}
	f := files[idx]
	rd := f.NewReader()
	defer rd.Close()
	rd.SetContext(r.Context())
	// The page re-verifies every piece hash, so don't wait for the relay's own verification.
	rd.SetResponsive()
	ra := s.opts.Readahead
	rd.SetReadaheadFunc(func(torrent.ReadaheadContext) int64 { return ra })
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/octet-stream")
	sr := &endTracker{ReadSeeker: rd}
	http.ServeContent(w, r, "", time.Time{}, sr)
	s.prefetchFrom(e, f, sr.pos)
}

// prefetchFrom moves the torrent's prefetch reader to off within f, so the next Readahead bytes keep
// downloading while the browser is busy elsewhere.
func (s *Server) prefetchFrom(e *entry, f *torrent.File, off int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.prefetch != nil {
		e.prefetch.Close()
	}
	if off >= f.Length() {
		e.prefetch = nil
		return
	}
	rd := f.NewReader()
	ra := s.opts.Readahead
	rd.SetReadaheadFunc(func(torrent.ReadaheadContext) int64 { return ra })
	if _, err := rd.Seek(off, io.SeekStart); err != nil {
		rd.Close()
		return
	}
	e.prefetch = rd
}

// endTracker remembers the furthest offset read, i.e. where the browser will most likely read next.
type endTracker struct {
	io.ReadSeeker
	pos int64
}

func (t *endTracker) Read(p []byte) (int, error) {
	n, err := t.ReadSeeker.Read(p)
	if cur, serr := t.ReadSeeker.Seek(0, io.SeekCurrent); serr == nil && cur > t.pos {
		t.pos = cur
	}
	return n, err
}

func (s *Server) add(ihStr string, q url.Values) (*entry, error) {
	ih, err := parseInfoHash(ihStr)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.torrents[ih]; e != nil {
		e.lastUsed = time.Now()
		return e, nil
	}
	spec := &torrent.TorrentSpec{
		DisplayName: q.Get("dn"),
		Trackers:    [][]string{dedupe(append(q["tr"], s.opts.ExtraTrackers...))},
		PeerAddrs:   q["x.pe"],
		Webseeds:    q["ws"],
	}
	spec.InfoHash = ih
	t, _, err := s.cl.AddTorrentSpec(spec)
	if err != nil {
		return nil, err
	}
	s.log.Info("added torrent", "infohash", ih.HexString(), "name", spec.DisplayName)
	e := &entry{t: t, lastUsed: time.Now()}
	s.torrents[ih] = e
	return e, nil
}

func (s *Server) touch(e *entry) {
	s.mu.Lock()
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
