package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"

	"github.com/alexeychikk/webtor/relay/internal/seedtest"
	"github.com/alexeychikk/webtor/relay/internal/webapp"
)

const token = "test-token-123"

// harness is a relay on a loopback-only client (no DHT, trackers or WebRTC) behind httptest.
type harness struct {
	srv     *Server
	url     string // http://127.0.0.1:port
	dataDir string
	logs    *syncBuffer
}

func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	dataDir := t.TempDir()
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.NoDHT = true
	cfg.DisableTrackers = true
	cfg.DisableWebtorrent = true
	cfg.NoDefaultPortForwarding = true
	cfg.DataDir = dataDir
	cfg.DefaultStorage = NewStorage(dataDir)
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	opts.Token = token
	opts.DataDir = dataDir
	opts.Logger = slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	srv, err := New(cl, opts)
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(srv.Handler())
	ctx, cancel := context.WithCancel(context.Background())
	go srv.RunJanitor(ctx)
	t.Cleanup(func() {
		cancel()
		hs.Close()
		srv.Close()
		cl.Close()
		if strings.Contains(logs.String(), token) {
			t.Errorf("logs contain the token:\n%s", logs.String())
		}
	})
	return &harness{srv: srv, url: hs.URL, dataDir: dataDir, logs: logs}
}

func (h *harness) torrentURL(ih metainfo.Hash) string {
	return fmt.Sprintf("%s/%s/v1/torrents/%s", h.url, token, ih.HexString())
}

func seedFile(t *testing.T, name string, size int) (*seedtest.Seeder, []byte) {
	t.Helper()
	return seedFileP(t, name, size, 256<<10)
}

func seedFileP(t *testing.T, name string, size int, pieceLength int64) (*seedtest.Seeder, []byte) {
	t.Helper()
	dir := t.TempDir()
	content := randomBytes(size)
	if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
		t.Fatal(err)
	}
	seed, err := seedtest.Start(filepath.Join(dir, name), pieceLength)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(seed.Close)
	return seed, content
}

// TestRelayFromTCPSeeder: metadata and byte ranges reach an HTTP client from a TCP-only seeder, and
// shutting down deletes the downloaded data.
func TestRelayFromTCPSeeder(t *testing.T) {
	seed, content := seedFile(t, "movie.mkv", 8<<20+12345)
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second})
	base := h.torrentURL(seed.InfoHash)

	res := get(t, base+"/metainfo?dn=movie.mkv&x.pe="+seed.Addr, "")
	if res.StatusCode != 200 {
		t.Fatalf("metainfo: %d", res.StatusCode)
	}
	mi, err := metainfo.Load(res.Body)
	res.Body.Close()
	if err != nil || mi.HashInfoBytes() != seed.InfoHash {
		t.Fatalf("metainfo: %v, hash %v", err, mi.HashInfoBytes())
	}

	res = get(t, base+"/webseed/", "bytes=300000-1300000")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusPartialContent || !bytes.Equal(body, content[300000:1300001]) {
		t.Fatalf("range: status %d, %d bytes", res.StatusCode, len(body))
	}

	req, _ := http.NewRequest(http.MethodHead, base+"/webseed/", nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 || res.ContentLength != int64(len(content)) {
		t.Fatalf("HEAD: %v %v", err, res)
	}

	start := time.Now()
	res = get(t, base+"/webseed/movie.mkv", "")
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(body, content) {
		t.Fatalf("full file: %d bytes, want %d", len(body), len(content))
	}
	t.Logf("full file %d MiB in %v", len(body)>>20, time.Since(start))

	if res := get(t, h.url+"/wrong-token/v1/info", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong token: %d", res.StatusCode)
	}

	dir := TorrentDir(h.dataDir, seed.InfoHash)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("no torrent data before shutdown: %v", err)
	}
	h.srv.Close()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("torrent data survived shutdown: %v", err)
	}
	if res := get(t, base+"/metainfo?x.pe="+seed.Addr, ""); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("metainfo after Close: %d", res.StatusCode)
	}
}

// TestMultiFileWebseedPaths requests files the way WebTorrent does (lib/webconn.js): URL + name/path
// without percent-encoding, so '#' and '?' in names break the URL; and percent-encoded, which always
// works.
func TestMultiFileWebseedPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Show?1")
	files := map[string][]byte{
		"Ep #2.mkv":        randomBytes(700_000),
		"Ep #3.mkv":        randomBytes(300_001),
		"What?.mkv":        randomBytes(200_000),
		"Subs/en & ru.srt": randomBytes(1234),
	}
	for p, b := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, p), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	seed, err := seedtest.Start(root, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	defer seed.Close()
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second})
	base := h.torrentURL(seed.InfoHash)
	if res := get(t, base+"/metainfo?x.pe="+seed.Addr, ""); res.StatusCode != 200 {
		t.Fatalf("metainfo: %d", res.StatusCode)
	}

	var listed []FileInfo
	res := get(t, base+"/files", "")
	if err := json.NewDecoder(res.Body).Decode(&listed); err != nil || len(listed) != len(files) {
		t.Fatalf("files: %v %+v", err, listed)
	}
	for _, f := range listed {
		want, ok := files[strings.TrimPrefix(f.WebseedPath, "Show?1/")]
		if !ok || int64(len(want)) != f.Length {
			t.Fatalf("files: unexpected %+v", f)
		}
		rng := fmt.Sprintf("bytes=1000-%d", len(want)-1)
		fetch := func(path string) (int, []byte) {
			res := get(t, base+"/webseed/"+path, rng)
			got, _ := io.ReadAll(res.Body)
			return res.StatusCode, got
		}
		// What WebTorrent's fetch() sends: no encoding, except that spaces become %20.
		code, got := fetch(strings.ReplaceAll(f.WebseedPath, " ", "%20"))
		switch {
		case f.WebseedPath == "Show?1/Ep #3.mkv":
			// "Show?1/Ep " with a range that fits Ep #2 too: ambiguous, as documented.
			if code != http.StatusNotFound {
				t.Errorf("%q unencoded: %d, want 404 (ambiguous)", f.WebseedPath, code)
			}
		case code != http.StatusPartialContent || !bytes.Equal(got, want[1000:]):
			t.Errorf("%q unencoded: status %d, %d bytes, want %d", f.WebseedPath, code, len(got), len(want)-1000)
		}
		segs := strings.Split(f.WebseedPath, "/")
		for i := range segs {
			segs[i] = url.PathEscape(segs[i])
		}
		if code, got := fetch(strings.Join(segs, "/")); code != http.StatusPartialContent || !bytes.Equal(got, want[1000:]) {
			t.Errorf("%q encoded: status %d, %d bytes", f.WebseedPath, code, len(got))
		}
	}
	if res := get(t, base+"/webseed/Show%3F1/nope.mkv", ""); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown file: %d", res.StatusCode)
	}
}

func TestTorrentLimit(t *testing.T) {
	ih := func(b byte) metainfo.Hash { return metainfo.Hash{b, 1, 2, 3} }

	t.Run("429 when every torrent is in use", func(t *testing.T) {
		h := newHarness(t, Options{MaxTorrents: 2, MetadataTimeout: 50 * time.Millisecond, EvictAfter: time.Hour})
		for _, b := range []byte{1, 2, 1} {
			if res := get(t, h.torrentURL(ih(b))+"/metainfo", ""); res.StatusCode != http.StatusGatewayTimeout {
				t.Fatalf("torrent %d: %d, want 504", b, res.StatusCode)
			}
		}
		res := get(t, h.torrentURL(ih(3))+"/metainfo", "")
		var body struct {
			Error       string `json:"error"`
			MaxTorrents int    `json:"maxTorrents"`
		}
		_ = json.NewDecoder(res.Body).Decode(&body)
		if res.StatusCode != http.StatusTooManyRequests || body.MaxTorrents != 2 || body.Error == "" ||
			res.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("third torrent: %d %+v %v", res.StatusCode, body, res.Header)
		}
		if n := h.srv.Torrents(); n != 2 {
			t.Fatalf("%d torrents, want 2", n)
		}
	})

	t.Run("a stale torrent is evicted instead", func(t *testing.T) {
		h := newHarness(t, Options{MaxTorrents: 1, MetadataTimeout: 50 * time.Millisecond, EvictAfter: 100 * time.Millisecond})
		get(t, h.torrentURL(ih(1))+"/metainfo", "")
		if res := get(t, h.torrentURL(ih(2))+"/metainfo", ""); res.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("before EvictAfter: %d, want 429", res.StatusCode)
		}
		time.Sleep(150 * time.Millisecond)
		if res := get(t, h.torrentURL(ih(2))+"/metainfo", ""); res.StatusCode != http.StatusGatewayTimeout {
			t.Fatalf("after EvictAfter: %d, want 504", res.StatusCode)
		}
		if res := get(t, h.torrentURL(ih(1))+"/stats", ""); res.StatusCode != http.StatusNotFound {
			t.Fatalf("evicted torrent stats: %d, want 404", res.StatusCode)
		}
	})
}

func TestIdleDrop(t *testing.T) {
	seed, _ := seedFile(t, "a.mkv", 1<<20)
	h := newHarness(t, Options{MetadataTimeout: 10 * time.Second, IdleTimeout: 300 * time.Millisecond})
	base := h.torrentURL(seed.InfoHash)
	if res := get(t, base+"/metainfo?x.pe="+seed.Addr, ""); res.StatusCode != 200 {
		t.Fatalf("metainfo: %d", res.StatusCode)
	}
	res := get(t, base+"/webseed/", "bytes=0-99999")
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	dir := TorrentDir(h.dataDir, seed.InfoHash)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("no data: %v", err)
	}

	// A request in flight keeps the torrent: a metainfo wait on an unknown torrent outlives IdleTimeout.
	waiting := metainfo.Hash{9}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		req, _ := http.NewRequest(http.MethodGet, h.torrentURL(waiting)+"/metainfo", nil)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if res, err := http.DefaultClient.Do(req.WithContext(ctx)); err == nil {
			res.Body.Close()
		}
	}()
	waitFor(t, func() bool { return !exists(dir) && h.srv.Torrents() == 1 }, 3*time.Second, "idle torrent dropped")
	if res := get(t, base+"/stats", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("dropped torrent stats: %d", res.StatusCode)
	}
	if res := get(t, base+"/webseed/", "bytes=0-9"); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("dropped torrent webseed: %d, want 503", res.StatusCode)
	}
	wg.Wait()
	waitFor(t, func() bool { return h.srv.Torrents() == 0 }, 3*time.Second, "torrent dropped after its request ended")
}

func TestCORSPreflight(t *testing.T) {
	h := newHarness(t, Options{})
	req, _ := http.NewRequest(http.MethodOptions, h.torrentURL(metainfo.Hash{1})+"/webseed/a.mkv", nil)
	req.Header.Set("Origin", "https://alexeychikk.github.io")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "cache-control,range,user-agent")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	hd := res.Header
	allowed := strings.ToLower(hd.Get("Access-Control-Allow-Headers"))
	if res.StatusCode != http.StatusNoContent || hd.Get("Access-Control-Allow-Origin") != "*" ||
		!strings.Contains(hd.Get("Access-Control-Allow-Methods"), "GET") ||
		!strings.Contains(hd.Get("Access-Control-Allow-Methods"), "POST") ||
		hd.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("preflight: %d %v", res.StatusCode, hd)
	}
	for _, want := range []string{"range", "cache-control", "user-agent"} {
		if !strings.Contains(allowed, want) {
			t.Errorf("Access-Control-Allow-Headers %q lacks %s", allowed, want)
		}
	}
	res = get(t, h.url+"/"+token+"/v1/info", "")
	if res.Header.Get("Access-Control-Allow-Origin") != "*" ||
		!strings.Contains(res.Header.Get("Access-Control-Expose-Headers"), "Content-Range") {
		t.Fatalf("GET CORS headers: %v", res.Header)
	}
}

func TestServesApp(t *testing.T) {
	h := newHarness(t, Options{App: webapp.FS()})
	res := get(t, h.url+"/", "")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") ||
		!strings.Contains(string(body), "https://alexeychikk.github.io/webtor/") {
		t.Fatalf("GET /: %d %s\n%s", res.StatusCode, res.Header, body)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("the app must not be CORS-enabled")
	}
	res = get(t, h.url+"/"+token+"/v1/info", "")
	var info map[string]any
	_ = json.NewDecoder(res.Body).Decode(&info)
	if res.StatusCode != 200 || info["name"] != "webtor-relay" {
		t.Fatalf("API next to the app: %d %v", res.StatusCode, info)
	}
	for path, code := range map[string]int{"/nope.js": 404, "/" + token: 404, "/wrong-token/v1/info": 404} {
		if res := get(t, h.url+path, ""); res.StatusCode != code {
			t.Errorf("GET %s: %d, want %d", path, res.StatusCode, code)
		}
	}
	res, err := http.Post(h.url+"/", "text/plain", nil)
	if err != nil || res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /: %v %v", err, res.StatusCode)
	}
}

func TestNewRejectsBadTokens(t *testing.T) {
	for _, tok := range []string{"", "short", "has/slash-in-it", "hash#in-the-token"} {
		if _, err := New(nil, Options{Token: tok}); err == nil {
			t.Errorf("token %q accepted", tok)
		}
	}
}

func get(t *testing.T, url, rng string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func waitFor(t *testing.T, cond func() bool, timeout time.Duration, what string) {
	t.Helper()
	for deadline := time.Now().Add(timeout); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestStallNudge: a webseed read that gets no data makes the relay re-request pieces, rate-limited,
// and stops doing so once the request is gone.
func TestStallNudge(t *testing.T) {
	old := stallCheck
	t.Cleanup(func() { stallCheck = old }) // runs after the harness has stopped
	stallCheck = 50 * time.Millisecond
	seed, _ := seedFile(t, "movie.mkv", 2<<20)
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second})
	base := h.torrentURL(seed.InfoHash)
	get(t, base+"/metainfo?x.pe="+seed.Addr, "").Body.Close()
	seed.Close() // nothing will ever arrive

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/webseed/", nil)
	req.Header.Set("Range", "bytes=0-1000")
	if res, err := http.DefaultClient.Do(req); err == nil {
		_, err = io.ReadAll(res.Body)
		res.Body.Close()
		if err == nil {
			t.Fatal("read finished without a seeder")
		}
	}
	waitFor(t, func() bool { return nudges(h) >= 1 }, 5*time.Second, "first nudge")
	n := nudges(h)
	if n > 10 {
		t.Errorf("%d nudges in 0.5 s, want them rate-limited", n)
	}
	time.Sleep(10 * stallCheck)
	if after := nudges(h); after > n+1 {
		t.Errorf("still nudging after the request ended: %d → %d", n, after)
	}
}

func nudges(h *harness) int {
	return strings.Count(h.logs.String(), "re-requesting pieces")
}

// TestPostMetainfo: a .torrent POSTed to the relay adds the torrent with its info at once (no swarm
// metadata needed); a later GET with x.pe= merges in the peer, and the data then streams.
func TestPostMetainfo(t *testing.T) {
	seed, content := seedFile(t, "movie.avi", 1<<20+777)
	h := newHarness(t, Options{MetadataTimeout: 20 * time.Second})
	base := h.torrentURL(seed.InfoHash)
	var file bytes.Buffer
	if err := seed.MetaInfo.Write(&file); err != nil {
		t.Fatal(err)
	}
	post := func(url string, body []byte) *http.Response {
		t.Helper()
		res, err := http.Post(url, "", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		return res
	}

	if res := post(base+"/metainfo", []byte("not bencoded")); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("garbage: %d, want 400", res.StatusCode)
	}
	if res := post(h.torrentURL(metainfo.Hash{1})+"/metainfo", file.Bytes()); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("other info hash: %d, want 400", res.StatusCode)
	}
	if h.srv.Torrents() != 0 {
		t.Fatalf("rejected POSTs added %d torrents", h.srv.Torrents())
	}

	res := post(base+"/metainfo", file.Bytes())
	mi, err := metainfo.Load(res.Body)
	if res.StatusCode != 200 || err != nil || mi.HashInfoBytes() != seed.InfoHash {
		t.Fatalf("POST metainfo: %d %v", res.StatusCode, err)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("POST without CORS headers: %v", res.Header)
	}

	res = get(t, base+"/metainfo?x.pe="+seed.Addr, "")
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("GET metainfo after POST: %d", res.StatusCode)
	}
	res = get(t, base+"/webseed/", "bytes=1000-1999")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusPartialContent || !bytes.Equal(body, content[1000:2000]) {
		t.Fatalf("range: status %d, %d bytes", res.StatusCode, len(body))
	}
	if h.srv.Torrents() != 1 {
		t.Fatalf("torrents: %d, want 1", h.srv.Torrents())
	}
}
