package relay

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	pp "github.com/anacrolix/torrent/peer_protocol"
	"github.com/anacrolix/torrent/tracker"
)

// Caps of the diagnostics logs (GET /v1/diagnostics). Torrent logs go with their torrent, and the
// relay holds at most MaxTorrents of them, so the whole store stays under a few MB at any uptime.
const (
	torrentEventCount = 500
	torrentEventBytes = 256 << 10
	globalEventCount  = 500
	globalEventBytes  = 256 << 10
	// Snapshots every DiagnosticsEvery: 15 minutes of them.
	snapshotCount = 90
	snapshotBytes = 192 << 10
)

// DiagnosticsEvery is how often counters are snapshotted into the diagnostics logs.
var DiagnosticsEvery = 10 * time.Second

// summaryEvery is how often an open torrent gets a summary line on stdout.
const summaryEvery = 5 * time.Minute

// Diagnostics is the relay's bounded in-memory record of what it did: per-torrent and global event
// logs plus periodic counter snapshots, served by GET /v1/diagnostics. Nothing goes to disk. Peer
// addresses are masked and tracker URLs reduced to scheme and host before they are recorded.
type Diagnostics struct {
	started time.Time
	peerKey []byte

	global, globalSnaps *eventLog

	mu       sync.Mutex
	torrents map[metainfo.Hash]*torrentDiag
	conns    map[*torrent.PeerConn]*connDiag
	dials    map[string]int64
	config   map[string]any
	cl       *torrent.Client
}

type torrentDiag struct {
	events, snaps *eventLog
	// webseed counts the web seed requests since the last snapshot.
	webseed webseedCounters
	// lastIn/lastAt give the snapshot its download rate.
	lastIn int64
	lastAt time.Time
}

type webseedCounters struct {
	Requests   int   `json:"requests"`
	Incomplete int   `json:"incomplete"`
	Slow       int   `json:"slow"`
	MaxTTFBMs  int64 `json:"maxTtfbMs"`
}

type connDiag struct {
	ih           metainfo.Hash
	since        time.Time
	unchoked     bool
	everUnchoked bool
}

// NewDiagnostics makes an empty store. Instrument and InstrumentClient connect it to a client.
func NewDiagnostics() *Diagnostics {
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	return &Diagnostics{
		started:     time.Now(),
		peerKey:     key,
		global:      newEventLog(globalEventCount, globalEventBytes),
		globalSnaps: newEventLog(snapshotCount, snapshotBytes),
		torrents:    map[metainfo.Hash]*torrentDiag{},
		conns:       map[*torrent.PeerConn]*connDiag{},
		dials:       map[string]int64{},
		config:      map[string]any{},
	}
}

// Instrument hooks d into a client config before torrent.NewClient: peer connection callbacks,
// the tracker announce results from the library's logger, and the config that matters for
// diagnosing a swarm. Call InstrumentClient on the new client afterwards (it adds the dialers this
// turns off).
func (d *Diagnostics) Instrument(cfg *torrent.ClientConfig) {
	d.mu.Lock()
	d.config["peerPort"] = cfg.ListenPort
	d.config["dht"] = !cfg.NoDHT
	d.config["tcp"] = !cfg.DisableTCP
	d.config["utp"] = !cfg.DisableUTP
	d.config["ipv6"] = !cfg.DisableIPv6
	d.config["pex"] = !cfg.DisablePEX
	d.config["trackers"] = !cfg.DisableTrackers
	d.config["upload"] = !cfg.NoUpload
	d.config["establishedConnsPerTorrent"] = cfg.EstablishedConnsPerTorrent
	d.config["halfOpenConnsPerTorrent"] = cfg.HalfOpenConnsPerTorrent
	d.config["totalHalfOpenConns"] = cfg.TotalHalfOpenConns
	d.mu.Unlock()

	cfg.DialForPeerConns = false
	cfg.Callbacks.PeerConnAdded = append(cfg.Callbacks.PeerConnAdded, d.peerConnAdded)
	if prev := cfg.Callbacks.PeerConnClosed; prev != nil {
		cfg.Callbacks.PeerConnClosed = func(pc *torrent.PeerConn) { d.peerConnClosed(pc); prev(pc) }
	} else {
		cfg.Callbacks.PeerConnClosed = d.peerConnClosed
	}
	if prev := cfg.Callbacks.ReadMessage; prev != nil {
		cfg.Callbacks.ReadMessage = func(pc *torrent.PeerConn, m *pp.Message) { d.readMessage(pc, m); prev(pc, m) }
	} else {
		cfg.Callbacks.ReadMessage = d.readMessage
	}
	var next slog.Handler = slog.DiscardHandler
	if cfg.Slogger != nil {
		next = cfg.Slogger.Handler()
	}
	cfg.Slogger = slog.New(&announceTap{d: d, next: next})
}

// InstrumentClient counts the client's dials by network and outcome: it adds a counting dialer for
// each of its sockets (Instrument turned the plain ones off).
func (d *Diagnostics) InstrumentClient(cl *torrent.Client) {
	d.mu.Lock()
	d.cl = cl
	d.mu.Unlock()
	for _, l := range cl.Listeners() {
		if dl, ok := l.(torrent.Dialer); ok {
			cl.AddDialer(countingDialer{Dialer: dl, d: d})
		}
	}
}

func (d *Diagnostics) register(ih metainfo.Hash) *torrentDiag {
	d.mu.Lock()
	defer d.mu.Unlock()
	td := d.torrents[ih]
	if td == nil {
		td = &torrentDiag{
			events: newEventLog(torrentEventCount, torrentEventBytes),
			snaps:  newEventLog(snapshotCount, snapshotBytes),
		}
		d.torrents[ih] = td
	}
	return td
}

func (d *Diagnostics) unregister(ih metainfo.Hash) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.torrents, ih)
	for pc, c := range d.conns {
		if c.ih == ih {
			delete(d.conns, pc)
		}
	}
}

// event records kind in ih's log, if the relay holds that torrent.
func (d *Diagnostics) event(ih metainfo.Hash, kind string, kv ...any) {
	d.mu.Lock()
	td := d.torrents[ih]
	d.mu.Unlock()
	if td != nil {
		td.events.add(kind, kv...)
	}
}

// globalEvent records kind in the relay-wide log.
func (d *Diagnostics) globalEvent(kind string, kv ...any) { d.global.add(kind, kv...) }

// The callbacks run with the client lock possibly held: they never call into the client.

func (d *Diagnostics) peerConnAdded(pc *torrent.PeerConn) {
	ih := pc.Torrent().InfoHash()
	d.mu.Lock()
	d.conns[pc] = &connDiag{ih: ih, since: time.Now()}
	td := d.torrents[ih]
	d.mu.Unlock()
	if td != nil {
		td.events.add("peer-connected", "peer", d.MaskAddr(addrString(pc.RemoteAddr)), "network", pc.Network,
			"source", string(pc.Discovery), "outgoing", pc.Discovery != torrent.PeerSourceIncoming)
	}
}

func (d *Diagnostics) peerConnClosed(pc *torrent.PeerConn) {
	d.mu.Lock()
	c := d.conns[pc]
	delete(d.conns, pc)
	var td *torrentDiag
	if c != nil {
		td = d.torrents[c.ih]
	}
	d.mu.Unlock()
	if td != nil {
		td.events.add("peer-closed", "peer", d.MaskAddr(addrString(pc.RemoteAddr)), "network", pc.Network,
			"lastedMs", time.Since(c.since), "everUnchoked", c.everUnchoked)
	}
}

func (d *Diagnostics) readMessage(pc *torrent.PeerConn, m *pp.Message) {
	if m.Keepalive || (m.Type != pp.Choke && m.Type != pp.Unchoke) {
		return
	}
	d.mu.Lock()
	c := d.conns[pc]
	first := false
	var td *torrentDiag
	if c != nil {
		c.unchoked = m.Type == pp.Unchoke
		first = c.unchoked && !c.everUnchoked
		c.everUnchoked = c.everUnchoked || c.unchoked
		td = d.torrents[c.ih]
	}
	d.mu.Unlock()
	if first && td != nil {
		td.events.add("peer-unchoked-us", "peer", d.MaskAddr(addrString(pc.RemoteAddr)),
			"afterMs", time.Since(c.since))
	}
}

func addrString(a torrent.PeerRemoteAddr) string {
	if a == nil {
		return ""
	}
	return a.String()
}

// MaskAddr reduces a peer address to its network prefix (IPv4 /16, IPv6 /32, no port) plus a
// short keyed hash that tells peers apart within one relay run without revealing them.
func (d *Diagnostics) MaskAddr(addr string) string {
	if addr == "" {
		return ""
	}
	mac := hmac.New(sha256.New, d.peerKey)
	mac.Write([]byte(addr))
	tag := hex.EncodeToString(mac.Sum(nil)[:3])
	ap, err := netip.ParseAddrPort(addr)
	var ip netip.Addr
	if err == nil {
		ip = ap.Addr()
	} else if ip, err = netip.ParseAddr(addr); err != nil {
		return "peer#" + tag
	}
	ip = ip.Unmap()
	if ip.Is4() {
		b := ip.As4()
		return fmt.Sprintf("%d.%d.x.x#%s", b[0], b[1], tag)
	}
	p, _ := ip.Prefix(32)
	return p.String() + "#" + tag
}

// TrackerHost is a tracker URL without anything that may identify the user: scheme and host
// only (no path, query or userinfo, where private trackers put passkeys).
func TrackerHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "(unparsable tracker URL)"
	}
	return u.Scheme + "://" + u.Host
}

// countingDialer counts dial outcomes by network for the global snapshots.
type countingDialer struct {
	torrent.Dialer
	d *Diagnostics
}

func (c countingDialer) Dial(ctx context.Context, addr string) (net.Conn, error) {
	conn, err := c.Dialer.Dial(ctx, addr)
	key := c.DialerNetwork() + " " + DialOutcome(err)
	c.d.mu.Lock()
	if len(c.d.dials) < 64 {
		c.d.dials[key]++
	} else if _, ok := c.d.dials[key]; ok {
		c.d.dials[key]++
	}
	c.d.mu.Unlock()
	return conn, err
}

// DialOutcome names a dial result: ok, cancelled (another network won the race), timeout,
// refused, unreachable, reset or other.
func DialOutcome(err error) string {
	var ne net.Error
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return "unreachable"
	case errors.Is(err, syscall.ECONNRESET):
		return "reset"
	default:
		return "other"
	}
}

// announceTap passes the library's log records on to next (at next's level) and records the
// tracker announce results, which the library only logs (at debug level).
type announceTap struct {
	d     *Diagnostics
	next  slog.Handler
	attrs []slog.Attr
}

func (a *announceTap) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= slog.LevelDebug || a.next.Enabled(ctx, l)
}

func (a *announceTap) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == "announced" {
		a.d.announced(a.attrs, r)
	}
	if a.next.Enabled(ctx, r.Level) {
		return a.next.Handle(ctx, r)
	}
	return nil
}

func (a *announceTap) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &announceTap{d: a.d, next: a.next.WithAttrs(attrs), attrs: append(a.attrs[:len(a.attrs):len(a.attrs)], attrs...)}
}

func (a *announceTap) WithGroup(name string) slog.Handler {
	return &announceTap{d: a.d, next: a.next.WithGroup(name), attrs: a.attrs}
}

// announced records one "announced" record: the logger carries "url" and "short infohash", the
// record "resp" (tracker.AnnounceResponse) and "err".
func (d *Diagnostics) announced(attrs []slog.Attr, r slog.Record) {
	var rawURL, ihHex string
	for _, at := range attrs {
		switch at.Key {
		case "url":
			rawURL = at.Value.String()
		case "short infohash":
			if h, ok := at.Value.Any().(interface{ HexString() string }); ok {
				ihHex = h.HexString()
			}
		}
	}
	var resp *tracker.AnnounceResponse
	var announceErr error
	r.Attrs(func(at slog.Attr) bool {
		switch at.Key {
		case "resp":
			switch v := at.Value.Any().(type) {
			case tracker.AnnounceResponse:
				resp = &v
			case *tracker.AnnounceResponse:
				resp = v
			}
		case "err":
			announceErr, _ = at.Value.Any().(error)
		}
		return true
	})
	var ih metainfo.Hash
	if ih.FromHexString(ihHex) != nil {
		return
	}
	kv := []any{"tracker", TrackerHost(rawURL), "ok", announceErr == nil}
	if announceErr != nil {
		kv = append(kv, "err", scrubURLs(announceErr.Error()))
	} else if resp != nil {
		kv = append(kv, "peers", len(resp.Peers), "seeders", resp.Seeders, "leechers", resp.Leechers,
			"intervalS", resp.Interval)
	}
	d.event(ih, "announce", kv...)
}

// scrubURLs reduces every URL in s to its scheme and host (errors quote the tracker URL).
func scrubURLs(s string) string {
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == ' ' || r == '"' || r == '\'' })
	for _, f := range fields {
		if i := strings.Index(f, "://"); i > 0 {
			s = strings.ReplaceAll(s, f, TrackerHost(strings.TrimRight(f, ":,;)")))
		}
	}
	return s
}

// webseedRequest records one finished web seed request in its torrent's counters, and in its log
// when it was slow or incomplete (or the torrent's first).
func (d *Diagnostics) webseedRequest(ih metainfo.Hash, slow, incomplete bool, ttfb time.Duration, kv ...any) {
	d.mu.Lock()
	td := d.torrents[ih]
	var first bool
	if td != nil {
		w := &td.webseed
		first = w.Requests == 0 && td.lastAt.IsZero()
		w.Requests++
		if slow {
			w.Slow++
		}
		if incomplete {
			w.Incomplete++
		}
		w.MaxTTFBMs = max(w.MaxTTFBMs, ttfb.Milliseconds())
	}
	d.mu.Unlock()
	if td != nil && (slow || incomplete || first) {
		td.events.add("webseed", kv...)
	}
}

// snapshotTorrent adds one counters snapshot to ih's log; fields come from the server.
func (d *Diagnostics) snapshotTorrent(ih metainfo.Hash, now time.Time, bytesIn int64, kv ...any) {
	d.mu.Lock()
	td := d.torrents[ih]
	if td == nil {
		d.mu.Unlock()
		return
	}
	unchoked := 0
	for _, c := range d.conns {
		if c.ih == ih && c.unchoked {
			unchoked++
		}
	}
	rate := int64(0)
	if !td.lastAt.IsZero() && now.After(td.lastAt) {
		rate = int64(float64(bytesIn-td.lastIn) / now.Sub(td.lastAt).Seconds())
	}
	td.lastIn, td.lastAt = bytesIn, now
	ws := td.webseed
	td.webseed = webseedCounters{}
	d.mu.Unlock()
	td.snaps.add("snapshot", append(kv, "unchokedUs", unchoked, "downloadRate", rate, "webseed", ws)...)
}

func (d *Diagnostics) snapshotGlobal(torrents int) {
	d.mu.Lock()
	dials := make(map[string]int64, len(d.dials))
	for k, v := range d.dials {
		dials[k] = v
	}
	conns := len(d.conns)
	cl := d.cl
	d.mu.Unlock()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	kv := []any{"torrents", torrents, "peerConns", conns, "dials", dials, "heapBytes", ms.HeapAlloc,
		"goroutines", runtime.NumGoroutine()}
	if cl != nil {
		var dht []any
		for _, s := range cl.DhtServers() {
			dht = append(dht, s.Stats())
		}
		kv = append(kv, "dht", dht)
	}
	d.globalSnaps.add("snapshot", kv...)
}

// DiagnosticsTorrent is one torrent of GET /v1/diagnostics.
type DiagnosticsTorrent struct {
	InfoHash  string     `json:"infoHash"`
	Name      string     `json:"name"`
	Events    eventsJSON `json:"events"`
	Snapshots eventsJSON `json:"snapshots"`
}

func (d *Diagnostics) torrentJSON(ih metainfo.Hash, name string) (DiagnosticsTorrent, bool) {
	d.mu.Lock()
	td := d.torrents[ih]
	d.mu.Unlock()
	if td == nil {
		return DiagnosticsTorrent{}, false
	}
	return DiagnosticsTorrent{InfoHash: ih.HexString(), Name: name, Events: td.events.snapshot(), Snapshots: td.snaps.snapshot()}, true
}

func (d *Diagnostics) configJSON() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make(map[string]any, len(d.config))
	for k, v := range d.config {
		out[k] = v
	}
	return out
}

// stores is the number of torrent logs held (tests).
func (d *Diagnostics) stores() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.torrents)
}

// RunDiagnostics snapshots the counters every DiagnosticsEvery, and writes a summary line per open
// torrent every summaryEvery, until ctx is done.
func (s *Server) RunDiagnostics(ctx context.Context) {
	tick := time.NewTicker(DiagnosticsEvery)
	defer tick.Stop()
	lastSummary := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			summary := now.Sub(lastSummary) >= summaryEvery
			if summary {
				lastSummary = now
			}
			s.snapshot(now, summary)
		}
	}
}

func (s *Server) snapshot(now time.Time, summary bool) {
	s.mu.Lock()
	entries := make([]*entry, 0, len(s.torrents))
	for _, e := range s.torrents {
		entries = append(entries, e)
	}
	s.mu.Unlock()
	for _, e := range entries {
		s.snapshotTorrent(e, now, summary)
	}
	s.diag.snapshotGlobal(len(entries))
}

func (s *Server) snapshotTorrent(e *entry, now time.Time, summary bool) {
	st := e.t.Stats()
	s.mu.Lock()
	window, active := e.window, e.active
	s.mu.Unlock()
	known := map[string]int{}
	for _, p := range e.t.KnownSwarm() {
		known[string(p.Source)]++
	}
	networks := map[string]int{}
	haveWanted := 0
	for _, pc := range e.t.PeerConns() {
		networks[pc.Network]++
		pieces := pc.PeerPieces()
		if window.begin < window.end {
			if pieces.IntersectsWithInterval(uint64(window.begin), uint64(window.end)) {
				haveWanted++
			}
		} else if !pieces.IsEmpty() {
			haveWanted++
		}
	}
	bytesIn := st.BytesReadUsefulData.Int64()
	kv := []any{
		"knownBySource", known, "totalPeers", st.TotalPeers, "pendingPeers", st.PendingPeers,
		"halfOpen", st.HalfOpenPeers, "connected", st.ActivePeers, "seeders", st.ConnectedSeeders,
		"connsByNetwork", networks, "haveWindowPieces", haveWanted, "window", [2]int{window.begin, window.end},
		"piecesComplete", st.PiecesComplete, "bytesInUseful", bytesIn, "bytesIn", st.BytesReadData.Int64(),
		"bytesOut", st.BytesWrittenData.Int64(), "served", e.served.Load(), "readahead", e.readahead.Load(),
		"activeRequests", active,
	}
	if info := e.t.Info(); info != nil {
		kv = append(kv, "pieces", info.NumPieces())
	}
	s.diag.snapshotTorrent(e.ih, now, bytesIn, kv...)
	if summary {
		s.log.Info("torrent", "infohash", e.ih.HexString(), "connected", st.ActivePeers, "seeders", st.ConnectedSeeders,
			"known", len(known), "halfOpen", st.HalfOpenPeers, "downloaded", bytesIn, "served", e.served.Load())
	}
}

func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	var only *metainfo.Hash
	if v := r.URL.Query().Get("ih"); v != "" {
		ih, err := parseInfoHash(v)
		if err != nil {
			httpError(w, http.StatusBadRequest, err)
			return
		}
		only = &ih
	}
	s.mu.Lock()
	type held struct {
		ih metainfo.Hash
		t  *torrent.Torrent
	}
	var list []held
	for ih, e := range s.torrents {
		if only == nil || *only == ih {
			list = append(list, held{ih, e.t})
		}
	}
	s.mu.Unlock()
	torrents := []DiagnosticsTorrent{}
	for _, h := range list {
		if dt, ok := s.diag.torrentJSON(h.ih, h.t.Name()); ok {
			torrents = append(torrents, dt)
		}
	}
	cfg := s.diag.configJSON()
	t := s.opts.Transcode
	cfg["maxTorrents"] = s.opts.MaxTorrents
	cfg["metadataTimeoutS"] = s.opts.MetadataTimeout.Seconds()
	cfg["idleTimeoutS"] = s.opts.IdleTimeout.Seconds()
	cfg["readahead"] = s.opts.Readahead
	cfg["maxReadahead"] = s.opts.MaxReadahead
	cfg["uploadLimit"] = s.opts.UploadLimit
	cfg["extraTrackers"] = len(s.opts.ExtraTrackers)
	cfg["transcode"] = TranscodeInfo{
		Available: t.FFmpeg != "", FFmpeg: t.FFmpegVersion, MaxHeight: t.MaxHeight, Preset: t.Preset, MaxTranscodes: t.MaxJobs,
	}
	out := map[string]any{
		"name": "webtor-relay", "version": Version, "api": APIVersion, "os": runtime.GOOS, "arch": runtime.GOARCH,
		"now": time.Now().UTC().Format(time.RFC3339), "uptimeS": int64(time.Since(s.diag.started).Seconds()),
		"config": cfg, "torrents": torrents,
		"global": map[string]any{"events": s.diag.global.snapshot(), "snapshots": s.diag.globalSnaps.snapshot()},
	}
	if only != nil && len(torrents) == 0 {
		out["torrentMissing"] = "the relay doesn't hold this torrent (never added, or dropped when idle)"
	}
	writeJSON(w, http.StatusOK, out)
}
