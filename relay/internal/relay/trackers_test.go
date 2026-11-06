package relay

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
)

func TestUsableTracker(t *testing.T) {
	for _, c := range []struct {
		raw, want string
		login, ok bool
	}{
		{"udp://tracker.opentrackr.org:1337/announce", "udp://tracker.opentrackr.org:1337/announce", false, true},
		{"http://alice:s3cret@tracker.example:8080/announce", "http://tracker.example:8080/announce", true, true},
		{"https://alice@tracker.example/a/pk-123/announce?passkey=x", "https://tracker.example/a/pk-123/announce?passkey=x", true, true},
		{"udp://u:p@tracker.example:6969", "udp://tracker.example:6969", true, true},
		{"wss://tracker.openwebtorrent.com", "wss://tracker.openwebtorrent.com", false, true},
		{"HTTP://Tracker.Example/announce", "http://Tracker.Example/announce", false, true},
		{" http://tracker.example/announce#x ", "http://tracker.example/announce", false, true},
		{"http://tracker.example/an nounce", "http://tracker.example/an%20nounce", false, true},
		{"foo://tracker.example/announce", "", false, false},
		{"*udp://disabled.example:1337", "", false, false},
		{"http:///announce", "", false, false},
		{"http://tracker.example:port/announce", "", false, false},
		{"udp:tracker.example:1337", "", false, false},
		{"tracker.example/announce", "", false, false},
	} {
		got, login, ok := usableTracker(c.raw)
		if got != c.want || login != c.login || ok != c.ok {
			t.Errorf("usableTracker(%q) = %q, %v, %v; want %q, %v, %v", c.raw, got, login, ok, c.want, c.login, c.ok)
		}
	}
}

func TestUsableTrackers(t *testing.T) {
	got, c := usableTrackers([][]string{
		{"http://a:b@x.example/announce", "http://x.example/announce", "foo://y", ""},
		{"bad://z"},
		{"udp://z.example:1"},
	})
	want := [][]string{{"http://x.example/announce"}, {"udp://z.example:1"}}
	if !reflect.DeepEqual(got, want) || c != (trackerCleanup{ignored: 2, loginsRemoved: 1}) {
		t.Fatalf("got %q %+v, want %q", got, c, want)
	}
}

// loopbackTracker is an HTTP tracker that hands out one peer and records the announces it got.
func loopbackTracker(t *testing.T, peer string) (*httptest.Server, func() []*http.Request) {
	t.Helper()
	ap, err := netip.ParseAddrPort(peer)
	if err != nil {
		t.Fatal(err)
	}
	compact := append(ap.Addr().AsSlice(), byte(ap.Port()>>8), byte(ap.Port()))
	var mu sync.Mutex
	var got []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.Clone(context.Background()))
		mu.Unlock()
		_ = bencode.NewEncoder(w).Encode(map[string]any{"interval": 1800, "peers": string(compact)})
	}))
	t.Cleanup(srv.Close)
	return srv, func() []*http.Request {
		mu.Lock()
		defer mu.Unlock()
		return append([]*http.Request(nil), got...)
	}
}

// TestTrackerWithLogin: a magnet whose tracker carries a login (anacrolix panicked on it) resolves
// through that tracker, announced to without the login, and no log line or diagnostics show it.
func TestTrackerWithLogin(t *testing.T) {
	seed, _ := seedFile(t, "movie.mkv", 1<<20)
	tracker, announces := loopbackTracker(t, seed.Addr)
	libLogs := &syncBuffer{}
	h := newHarnessCfg(t, Options{MetadataTimeout: 20 * time.Second}, func(cfg *torrent.ClientConfig) {
		cfg.DisableTrackers = false
		cfg.Slogger = slog.New(ScrubURLs(slog.NewTextHandler(libLogs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	})
	withLogin := strings.Replace(tracker.URL, "http://", "http://alice:s3cret@", 1) + "/pk-0123abcd/announce"
	q := url.Values{"dn": {"movie.mkv"}, "tr": {withLogin, "foo://alice:s3cret@nowhere.example/", "HTTP://bob:hunter2@127.0.0.1:1/announce"}}
	res := get(t, h.torrentURL(seed.InfoHash)+"/metainfo?"+q.Encode(), "")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("metainfo: %d %s", res.StatusCode, body)
	}
	if mi, err := metainfo.Load(bytes.NewReader(body)); err != nil || mi.HashInfoBytes() != seed.InfoHash {
		t.Fatalf("metainfo: %v", err)
	}
	reqs := announces()
	if len(reqs) == 0 {
		t.Fatal("no announce reached the tracker")
	}
	for _, r := range reqs {
		if r.URL.Path != "/pk-0123abcd/announce" || r.Header.Get("Authorization") != "" {
			t.Errorf("announce %s, Authorization %q", r.URL.Path, r.Header.Get("Authorization"))
		}
	}

	diag, raw := getDiagnostics(t, h, "?ih="+seed.InfoHash.HexString())
	if !strings.Contains(raw, `"trackerLoginsRemoved":2`) || !strings.Contains(raw, `"trackersIgnored":1`) {
		t.Errorf("no tracker cleanup in the added event: %v\n%s", kinds(diag.Torrents[0].Events), raw)
	}
	for name, text := range map[string]string{"relay logs": h.logs.String(), "library logs": libLogs.String(), "diagnostics": raw} {
		for _, secret := range []string{"alice", "s3cret", "bob", "hunter2", "pk-0123abcd"} {
			if strings.Contains(text, secret) {
				t.Errorf("%s contain %q", name, secret)
			}
		}
	}
}

// TestAddPanicRecovered: a panic inside the library's add (here a UDP tracker whose socket can't
// open) answers 500 without the panic value and leaves the client working.
func TestAddPanicRecovered(t *testing.T) {
	seed, _ := seedFile(t, "movie.mkv", 1<<20)
	h := newHarnessCfg(t, Options{MetadataTimeout: 20 * time.Second}, func(cfg *torrent.ClientConfig) {
		cfg.DisableTrackers = false
		cfg.TrackerListenPacket = func(string, string) (net.PacketConn, error) {
			return nil, errors.New("no sockets for udp://alice:s3cret@tracker.example")
		}
	})
	q := url.Values{"x.pe": {seed.Addr}, "tr": {"udp://tracker.example:6969/pk-0123abcd"}}
	res := get(t, h.torrentURL(seed.InfoHash)+"/metainfo?"+q.Encode(), "")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError || !strings.Contains(string(body), errAddFailed.Error()) {
		t.Fatalf("metainfo: %d %s", res.StatusCode, body)
	}
	if h.srv.Torrents() != 0 || len(h.srv.cl.Torrents()) != 0 {
		t.Fatalf("half-added torrent kept: %d, client %d", h.srv.Torrents(), len(h.srv.cl.Torrents()))
	}
	q.Del("tr")
	if res := get(t, h.torrentURL(seed.InfoHash)+"/metainfo?"+q.Encode(), ""); res.StatusCode != http.StatusOK {
		t.Fatalf("metainfo without the tracker: %d", res.StatusCode)
	}
	for _, secret := range []string{"alice", "s3cret", "pk-0123abcd"} {
		if strings.Contains(h.logs.String(), secret) {
			t.Errorf("logs contain %q", secret)
		}
	}
}
