package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/tracker"
)

func TestEventLogBounds(t *testing.T) {
	t.Run("count", func(t *testing.T) {
		l := newEventLog(10, 1<<20)
		for i := range 1000 {
			l.add("e", "i", i)
		}
		n, _ := l.size()
		s := l.snapshot()
		if n != 10 || s.Dropped != 990 || !strings.Contains(string(s.Events[9]), `"i":999`) {
			t.Fatalf("%d events, %d dropped, last %s", n, s.Dropped, s.Events[len(s.Events)-1])
		}
	})
	t.Run("bytes", func(t *testing.T) {
		l := newEventLog(1000, 4<<10)
		for range 1000 {
			l.add("e", "s", strings.Repeat("x", 250))
		}
		if _, b := l.size(); b > 4<<10 {
			t.Fatalf("%d bytes, cap %d", b, 4<<10)
		}
	})
	t.Run("one event", func(t *testing.T) {
		l := newEventLog(10, 1<<20)
		l.add("long", "s", strings.Repeat("y", 10_000))
		kv := make([]any, 0, 40)
		for i := range 20 {
			kv = append(kv, fmt.Sprint("k", i), strings.Repeat("z", 280))
		}
		l.add("wide", kv...)
		s := l.snapshot()
		if len(s.Events[0]) > maxEventString+100 || !strings.Contains(string(s.Events[1]), `"truncated":true`) {
			t.Fatalf("events not capped: %d bytes, %s", len(s.Events[0]), s.Events[1])
		}
	})
}

// TestDiagnosticsMemoryBounded: many torrents with many events each keep only the held torrents'
// logs, each within its caps, and the global logs within theirs.
func TestDiagnosticsMemoryBounded(t *testing.T) {
	h := newHarness(t, Options{MaxTorrents: 3, MetadataTimeout: 5 * time.Millisecond, EvictAfter: time.Nanosecond})
	d := h.srv.diag
	for i := range 200 {
		ih := metainfo.Hash{byte(i), byte(i >> 8), 7}
		get(t, h.torrentURL(ih)+"/metainfo", "").Body.Close()
		for j := range 700 {
			d.event(ih, "spam", "j", j, "s", strings.Repeat("x", 200))
			d.globalEvent("spam", "j", j)
		}
		h.srv.snapshot(time.Now(), false)
	}
	if n := d.stores(); n > 3 {
		t.Fatalf("%d torrent logs held, max 3", n)
	}
	d.mu.Lock()
	for ih, td := range d.torrents {
		if n, b := td.events.size(); n > torrentEventCount || b > torrentEventBytes {
			t.Errorf("%v: %d events, %d bytes", ih, n, b)
		}
		if n, b := td.snaps.size(); n > snapshotCount || b > snapshotBytes {
			t.Errorf("%v: %d snapshots, %d bytes", ih, n, b)
		}
	}
	d.mu.Unlock()
	if n, b := d.global.size(); n > globalEventCount || b > globalEventBytes || d.global.snapshot().Dropped == 0 {
		t.Errorf("global: %d events, %d bytes, %d dropped", n, b, d.global.snapshot().Dropped)
	}
	if n, b := d.globalSnaps.size(); n > snapshotCount || b > snapshotBytes {
		t.Errorf("global snapshots: %d, %d bytes", n, b)
	}
}

type diagnosticsBody struct {
	API      int                  `json:"api"`
	Config   map[string]any       `json:"config"`
	Torrents []DiagnosticsTorrent `json:"torrents"`
	Missing  string               `json:"torrentMissing"`
	Global   struct {
		Events    eventsJSON `json:"events"`
		Snapshots eventsJSON `json:"snapshots"`
	} `json:"global"`
}

func getDiagnostics(t *testing.T, h *harness, query string) (diagnosticsBody, string) {
	t.Helper()
	res := get(t, h.url+"/"+token+"/v1/diagnostics"+query, "")
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("diagnostics: %d %s", res.StatusCode, raw)
	}
	var body diagnosticsBody
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("diagnostics: %v", err)
	}
	return body, string(raw)
}

func kinds(l eventsJSON) map[string]int {
	out := map[string]int{}
	for _, ev := range l.Events {
		var e struct {
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal(ev, &e)
		out[e.Kind]++
	}
	return out
}

func TestDiagnosticsEndpoint(t *testing.T) {
	seed, _ := seedFile(t, "movie.mkv", 2<<20)
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second})
	base := h.torrentURL(seed.InfoHash)
	if res := get(t, base+"/metainfo?dn=movie.mkv&x.pe="+seed.Addr, ""); res.StatusCode != 200 {
		t.Fatalf("metainfo: %d", res.StatusCode)
	}
	res := get(t, base+"/webseed/", "bytes=0-99999")
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	h.srv.snapshot(time.Now(), true)

	if res := get(t, h.url+"/v1/diagnostics", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("without the token: %d, want 404", res.StatusCode)
	}
	if res := get(t, h.url+"/wrong-token/v1/diagnostics", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong token: %d, want 404", res.StatusCode)
	}

	body, raw := getDiagnostics(t, h, "?ih="+seed.InfoHash.HexString())
	if body.API != APIVersion || len(body.Torrents) != 1 || body.Torrents[0].Name != "movie.mkv" {
		t.Fatalf("diagnostics: api %d, torrents %+v", body.API, body.Torrents)
	}
	got := kinds(body.Torrents[0].Events)
	for _, k := range []string{"added", "metainfo", "peer-connected", "peer-unchoked-us", "webseed"} {
		if got[k] == 0 {
			t.Errorf("no %q event: %v\n%s", k, got, raw)
		}
	}
	if len(body.Torrents[0].Snapshots.Events) == 0 || len(body.Global.Snapshots.Events) == 0 {
		t.Errorf("no snapshots: %s", raw)
	}
	if kinds(body.Global.Events)["torrent-added"] != 1 {
		t.Errorf("global events: %v", kinds(body.Global.Events))
	}
	host, _, _ := net.SplitHostPort(seed.Addr)
	for _, secret := range []string{token, seed.Addr, `"` + host + `"`, host + ":"} {
		if strings.Contains(raw, secret) {
			t.Errorf("diagnostics contain %q:\n%s", secret, raw)
		}
	}
	if !strings.Contains(raw, `127.0.x.x#`) {
		t.Errorf("no masked peer address:\n%s", raw)
	}
	if _, ok := body.Config["transcode"]; !ok {
		t.Errorf("config: %v", body.Config)
	}

	if all, _ := getDiagnostics(t, h, ""); len(all.Torrents) != 1 {
		t.Errorf("all torrents: %d", len(all.Torrents))
	}
	if other, _ := getDiagnostics(t, h, "?ih="+metainfo.Hash{1}.HexString()); len(other.Torrents) != 0 || other.Missing == "" {
		t.Errorf("unknown torrent: %+v", other)
	}
	if res := get(t, h.url+"/"+token+"/v1/diagnostics?ih=nope", ""); res.StatusCode != http.StatusBadRequest {
		t.Errorf("bad ih: %d", res.StatusCode)
	}

	h.srv.Close()
	if n := h.srv.diag.stores(); n != 0 {
		t.Errorf("%d torrent logs after Close", n)
	}
}

// TestAnnounceTap: tracker announces reach the torrent's log with the tracker's host only.
func TestAnnounceTap(t *testing.T) {
	d := NewDiagnostics()
	ih := metainfo.Hash{4, 2}
	d.register(ih)
	var passed int
	next := countingHandler{n: &passed}
	log := slog.New(&announceTap{d: d, next: next}).With(
		"url", "https://tracker.example.org:8443/a1b2c3passkey/announce?uk=secret", "short infohash", ih)
	log.Debug("announced", "resp", tracker.AnnounceResponse{Interval: 1800, Seeders: 110, Leechers: 3, Peers: make([]tracker.Peer, 5)})
	log.Debug("announced", "err", errors.New(`announcing: Get "udp://tracker.example.org:6969/passkey123/announce": timeout`))
	log.Warn("something else")

	raw := fmt.Sprint(d.torrents[ih].events.snapshot().Events)
	for _, want := range []string{`"tracker":"https://tracker.example.org:8443"`, `"peers":5`, `"seeders":110`, `"ok":false`, `udp://tracker.example.org:6969`} {
		if !strings.Contains(raw, want) {
			t.Errorf("no %s in %s", want, raw)
		}
	}
	for _, secret := range []string{"passkey", "secret", "a1b2c3"} {
		if strings.Contains(raw, secret) {
			t.Errorf("events contain %q: %s", secret, raw)
		}
	}
	if passed != 1 {
		t.Errorf("%d records passed to the Warn handler, want 1", passed)
	}
}

type countingHandler struct{ n *int }

func (c countingHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelWarn }
func (c countingHandler) Handle(context.Context, slog.Record) error {
	*c.n++
	return nil
}
func (c countingHandler) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c countingHandler) WithGroup(string) slog.Handler      { return c }

func TestMaskAddr(t *testing.T) {
	d := NewDiagnostics()
	for _, tc := range []struct{ in, prefix string }{
		{"203.0.113.7:6881", "203.0.x.x#"},
		{"[::ffff:203.0.113.7]:6881", "203.0.x.x#"},
		{"[2001:db8:1234::1]:51413", "2001:db8::/32#"},
		{"10.1.2.3", "10.1.x.x#"},
		{"not an address", "peer#"},
	} {
		got := d.MaskAddr(tc.in)
		if !strings.HasPrefix(got, tc.prefix) || strings.Contains(got, "113.7") || strings.Contains(got, "1234") {
			t.Errorf("MaskAddr(%q) = %q, want prefix %q", tc.in, got, tc.prefix)
		}
	}
	if d.MaskAddr("203.0.113.7:6881") == d.MaskAddr("203.0.113.8:6881") {
		t.Error("different peers share a tag")
	}
	if d.MaskAddr("203.0.113.7:6881") != d.MaskAddr("203.0.113.7:6881") {
		t.Error("one peer has two tags")
	}
}

func TestTrackerHost(t *testing.T) {
	for in, want := range map[string]string{
		"udp://tracker.opentrackr.org:1337/announce":           "udp://tracker.opentrackr.org:1337",
		"https://user:pw@private.example/abcdef/announce?pk=1": "https://private.example",
		"wss://tracker.webtorrent.dev":                         "wss://tracker.webtorrent.dev",
		"::nope":                                               "(unparsable tracker URL)",
	} {
		if got := TrackerHost(in); got != want {
			t.Errorf("TrackerHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDialOutcome(t *testing.T) {
	for want, err := range map[string]error{
		"ok":          nil,
		"cancelled":   context.Canceled,
		"timeout":     &net.OpError{Op: "dial", Err: context.DeadlineExceeded},
		"refused":     &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED},
		"unreachable": &net.OpError{Op: "dial", Err: syscall.EHOSTUNREACH},
		"reset":       syscall.ECONNRESET,
		"other":       errors.New("boom"),
	} {
		if got := DialOutcome(err); got != want {
			t.Errorf("DialOutcome(%v) = %q, want %q", err, got, want)
		}
	}
}

func TestLogThrottle(t *testing.T) {
	th := newLogThrottle(time.Minute)
	t0 := time.Unix(1000, 0)
	if ok, _ := th.allow("a", t0); !ok {
		t.Fatal("first line held back")
	}
	for i := range 5 {
		if ok, _ := th.allow("a", t0.Add(time.Duration(i)*time.Second)); ok {
			t.Fatal("repeat let through")
		}
	}
	if ok, _ := th.allow("b", t0); !ok {
		t.Fatal("other key held back")
	}
	if ok, n := th.allow("a", t0.Add(time.Minute)); !ok || n != 5 {
		t.Fatalf("after a minute: %v, %d suppressed", ok, n)
	}
	for i := range 10 * maxThrottleKeys {
		th.allow(fmt.Sprint(i), t0.Add(time.Duration(i)*time.Millisecond))
	}
	if len(th.seen) > maxThrottleKeys {
		t.Fatalf("%d keys held", len(th.seen))
	}

	var out strings.Builder
	log := slog.New(ThrottleLog(slog.NewTextHandler(&out, nil), time.Hour))
	for range 100 {
		log.Warn("peer misbehaved")
	}
	if n := strings.Count(out.String(), "\n"); n != 1 {
		t.Fatalf("%d lines:\n%s", n, out.String())
	}
}

func TestRouteOf(t *testing.T) {
	ih := metainfo.Hash{1}.HexString()
	for in, want := range map[string]string{
		"/v1/info": "/v1/info",
		"/v1/torrents/" + ih + "/webseed/a/b/c.mkv": "/v1/torrents/*/webseed",
		"/v1/torrents/" + ih + "/stats":             "/v1/torrents/*/stats",
		"/v1/torrents/" + ih + "/files/0/transcode": "/v1/torrents/*/files",
		"/v1/diagnostics":                           "/v1/diagnostics",
	} {
		if got := routeOf(in); got != want {
			t.Errorf("routeOf(%q) = %q, want %q", in, got, want)
		}
	}
}
