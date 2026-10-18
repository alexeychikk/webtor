package relay

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"

	"github.com/alexeychikk/webtor/relay/internal/seedtest"
)

const token = "test-token-123"

// TestRelayFromTCPSeeder: metadata and byte ranges reach an HTTP client from a TCP-only seeder.
func TestRelayFromTCPSeeder(t *testing.T) {
	dir := t.TempDir()
	content := make([]byte, 8<<20+12345)
	_, _ = rand.Read(content)
	if err := os.WriteFile(filepath.Join(dir, "movie.mkv"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	seed, err := seedtest.Start(filepath.Join(dir, "movie.mkv"), 256<<10)
	if err != nil {
		t.Fatal(err)
	}
	defer seed.Close()

	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.NoDHT = true
	cfg.DisableTrackers = true
	cfg.DisableWebtorrent = true
	cfg.NoDefaultPortForwarding = true
	cfg.DefaultStorage = storage.NewFileOpts(storage.NewFileClientOpts{ClientBaseDir: t.TempDir()})
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	srv, err := New(cl, Options{Token: token, MetadataTimeout: 20 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	base := fmt.Sprintf("%s/%s/v1/torrents/%s", hs.URL, token, seed.InfoHash.HexString())

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

	start := time.Now()
	res = get(t, base+"/webseed/movie.mkv", "")
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(body, content) {
		t.Fatalf("full file: %d bytes, want %d", len(body), len(content))
	}
	t.Logf("full file %d MiB in %v", len(body)>>20, time.Since(start))

	if res := get(t, hs.URL+"/wrong-token/v1/info", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong token: %d", res.StatusCode)
	}
}

func get(t *testing.T, url, rng string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}
