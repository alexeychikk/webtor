// Command webtor-relay lets the webtor web app download from regular BitTorrent peers (TCP/uTP, DHT,
// UDP/HTTP trackers, PEX). Run it on your computer or a server and paste the printed relay URL into
// the app. See relay/README.md.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"

	"github.com/alexeychikk/webtor/relay/internal/relay"
)

// Public trackers announced to for every torrent (re-check https://github.com/ngosang/trackerslist).
var defaultTrackers = []string{
	"udp://tracker.opentrackr.org:1337/announce",
	"udp://open.demonii.com:1337/announce",
	"udp://open.stealth.si:80/announce",
	"udp://tracker.torrent.eu.org:451/announce",
	"udp://exodus.desync.com:6969/announce",
	"http://tracker.opentrackr.org:1337/announce",
}

const appURL = "https://alexeychikk.github.io/webtor/"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "webtor-relay:", err)
		os.Exit(1)
	}
}

func run() error {
	cacheDir, _ := os.UserCacheDir()
	listen := flag.String("listen", envOr("WEBTOR_RELAY_LISTEN", "127.0.0.1:7881"), "HTTP address the web app connects to")
	publicURL := flag.String("public-url", os.Getenv("WEBTOR_RELAY_PUBLIC_URL"), "URL the app reaches this relay at, if not http://<listen> (e.g. behind HTTPS)")
	token := flag.String("token", os.Getenv("WEBTOR_RELAY_TOKEN"), "secret path segment; generated and saved in -data-dir when empty")
	dataDir := flag.String("data-dir", envOr("WEBTOR_RELAY_DATA_DIR", filepath.Join(cacheDir, "webtor-relay")), "where pieces are stored while a torrent is open")
	peerPort := flag.Int("peer-port", 42069, "TCP/uTP port for BitTorrent peers (0 = random)")
	noDefaultTrackers := flag.Bool("no-default-trackers", false, "announce only to the magnet's own trackers")
	noDHT := flag.Bool("no-dht", false, "disable the DHT")
	flag.Parse()

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	tok, err := loadToken(*token, filepath.Join(*dataDir, "token"))
	if err != nil {
		return err
	}
	piecesDir := filepath.Join(*dataDir, "pieces")
	// Nothing survives a restart: a torrent's data is only a cache for the tab that opened it.
	_ = os.RemoveAll(piecesDir)

	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenPort = *peerPort
	cfg.NoDHT = *noDHT
	cfg.Seed = false
	cfg.DisableWebtorrent = true
	cfg.DefaultStorage = storage.NewFileOpts(storage.NewFileClientOpts{
		ClientBaseDir: piecesDir,
		TorrentDirMaker: func(base string, _ *metainfo.Info, ih metainfo.Hash) string {
			return filepath.Join(base, ih.HexString())
		},
	})
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		return fmt.Errorf("starting BitTorrent client: %w", err)
	}
	defer cl.Close()

	opts := relay.Options{Token: tok, DataDir: piecesDir}
	if !*noDefaultTrackers {
		opts.ExtraTrackers = defaultTrackers
	}
	srv, err := relay.New(cl, opts)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	base := strings.TrimSuffix(*publicURL, "/")
	if base == "" {
		base = "http://" + ln.Addr().String()
	}
	relayURL := base + "/" + tok
	fmt.Printf("webtor-relay %s\n\nRelay URL:  %s\nOpen:       %s#relay=%s\n\n", relay.Version, relayURL, appURL, url.QueryEscape(relayURL))
	fmt.Println("Peers see this machine's IP address. Keep the relay URL secret: it is the password.")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.RunJanitor(ctx)
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	slog.Info("listening", "http", ln.Addr().String(), "peer-port", *peerPort)
	if err := hs.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func loadToken(flagValue, file string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	if b, err := os.ReadFile(file); err == nil && len(strings.TrimSpace(string(b))) >= 8 {
		return strings.TrimSpace(string(b)), nil
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(buf)
	return tok, os.WriteFile(file, []byte(tok+"\n"), 0o600)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
