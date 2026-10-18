// Command webtor-relay lets the webtor web app download from regular BitTorrent peers (TCP/uTP, DHT,
// UDP/HTTP trackers, PEX). Run it on your computer or a server and open the printed link, or paste
// the printed relay URL into the app. See relay/README.md.
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
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"

	"github.com/alexeychikk/webtor/relay/internal/relay"
	"github.com/alexeychikk/webtor/relay/internal/webapp"
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

// Defaults that container builds override with -ldflags "-X main.defaultListen=… -X main.defaultDataDir=…"
// (relay/.ko.yaml, relay/Dockerfile): a container must listen on all interfaces, and distroless
// images have no $HOME, so the user cache dir is unknown there.
var (
	defaultListen  = "127.0.0.1:7881"
	defaultDataDir = ""
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "webtor-relay:", err)
		os.Exit(1)
	}
}

func run() error {
	if defaultDataDir == "" {
		cacheDir, _ := os.UserCacheDir()
		defaultDataDir = filepath.Join(cacheDir, "webtor-relay")
	}
	listen := flag.String("listen", envOr("WEBTOR_RELAY_LISTEN", defaultListen), "HTTP address the web app connects to")
	publicURL := flag.String("public-url", os.Getenv("WEBTOR_RELAY_PUBLIC_URL"), "URL the app reaches this relay at, if not http://<listen> (e.g. behind HTTPS)")
	token := flag.String("token", os.Getenv("WEBTOR_RELAY_TOKEN"), "secret path segment; generated and saved in -data-dir when empty")
	dataDir := flag.String("data-dir", envOr("WEBTOR_RELAY_DATA_DIR", defaultDataDir), "token file and the data of open torrents (deleted on drop and at startup)")
	peerPort := flag.Int("peer-port", envInt("WEBTOR_RELAY_PEER_PORT", 42069), "TCP/uTP port for BitTorrent peers (0 = random)")
	maxTorrents := flag.Int("max-torrents", envInt("WEBTOR_RELAY_MAX_TORRENTS", relay.DefaultMaxTorrents), "torrents open at once; one more gets HTTP 429")
	metadataTimeout := flag.Duration("metadata-timeout", envDuration("WEBTOR_RELAY_METADATA_TIMEOUT", relay.DefaultMetadataTimeout), "how long a metainfo request waits for the swarm (then 504)")
	idleTimeout := flag.Duration("idle-timeout", envDuration("WEBTOR_RELAY_IDLE_TIMEOUT", relay.DefaultIdleTimeout), "drop a torrent and delete its data after no request for this long")
	readahead := flag.Int64("readahead", envInt64("WEBTOR_RELAY_READAHEAD", relay.DefaultReadahead), "bytes downloaded ahead of the last requested range")
	noUpload := flag.Bool("no-upload", envBool("WEBTOR_RELAY_NO_UPLOAD"), "never upload to peers (default: upload while a torrent is open)")
	noDefaultTrackers := flag.Bool("no-default-trackers", envBool("WEBTOR_RELAY_NO_DEFAULT_TRACKERS"), "announce only to the magnet's own trackers")
	noDHT := flag.Bool("no-dht", envBool("WEBTOR_RELAY_NO_DHT"), "disable the DHT")
	debug := flag.Bool("debug", envBool("WEBTOR_RELAY_DEBUG"), "log every API request (never the token)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("webtor-relay", relay.Version)
		return nil
	}

	lvl := slog.LevelInfo
	if *debug {
		lvl = slog.LevelDebug
	}
	// Not slog.SetDefault: the torrent library's storage logs to the default logger, and its debug
	// output is huge (lines per piece read/write) and slows streaming down. -debug is about the
	// relay's own requests only.
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	tok, err := loadToken(*token, filepath.Join(*dataDir, "token"))
	if err != nil {
		return err
	}
	// Nothing survives a restart: a torrent's data is only a cache for the tab that opened it.
	piecesDir := filepath.Join(*dataDir, "pieces")
	if err := relay.ResetDataDir(piecesDir); err != nil {
		return err
	}
	defer os.RemoveAll(piecesDir)

	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenPort = *peerPort
	cfg.NoDHT = *noDHT
	cfg.NoUpload = *noUpload
	cfg.Seed = false
	cfg.DisableWebtorrent = true
	cfg.DataDir = piecesDir
	cfg.DefaultStorage = relay.NewStorage(piecesDir)
	// QuietReadErrors: the library logs every aborted web seed read (a browser seek) as an error.
	cfg.Slogger = slog.New(relay.QuietReadErrors(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		return fmt.Errorf("starting BitTorrent client: %w", err)
	}
	defer cl.Close()

	opts := relay.Options{
		Token:           tok,
		MaxTorrents:     *maxTorrents,
		MetadataTimeout: *metadataTimeout,
		IdleTimeout:     *idleTimeout,
		Readahead:       *readahead,
		DataDir:         piecesDir,
		App:             webapp.FS(),
		Logger:          logger,
	}
	if !*noDefaultTrackers {
		opts.ExtraTrackers = defaultTrackers
	}
	srv, err := relay.New(cl, opts)
	if err != nil {
		return err
	}
	defer srv.Close()
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	links := relay.MakeLinks(*publicURL, ln.Addr().String(), tok)
	// The only place the token is ever printed: the user needs these links.
	fmt.Printf("webtor-relay %s\n\nOpen:       %s\nRelay URL:  %s  (paste into the app's relay setting)\nOr open:    %s\n\n",
		relay.Version, links.Open, links.Relay, links.Hosted)
	fmt.Println("Peers see this machine's IP address. Keep the relay URL secret: it is the password.")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.RunJanitor(ctx)
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()
	logger.Info("listening", "http", ln.Addr().String(), "peer-port", cl.LocalPort(),
		"max-torrents", *maxTorrents, "upload", !*noUpload)

	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	stop() // a second Ctrl-C kills the process the default way
	logger.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := hs.Shutdown(sctx); err != nil {
		_ = hs.Close() // streaming responses don't finish on their own
	}
	if err := <-served; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil // deferred: drop torrents, close the client, delete the data
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

func envInt(key string, def int) int { return int(envInt64(key, int64(def))) }

func envInt64(key string, def int64) int64 {
	if n, err := strconv.ParseInt(os.Getenv(key), 10, 64); err == nil {
		return n
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(os.Getenv(key)); err == nil {
		return d
	}
	return def
}

func envBool(key string) bool {
	b, _ := strconv.ParseBool(os.Getenv(key))
	return b
}
