package relay

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestQuietReadErrors(t *testing.T) {
	cases := []struct {
		name string
		log  func(l *slog.Logger)
		want bool // logged
	}{
		{"cancelled read", func(l *slog.Logger) {
			l.Error("initial read failed", "err", fmt.Errorf("reading: %w", context.Canceled))
		}, false},
		{"cancelled read via With and group", func(l *slog.Logger) {
			l.With("torrent", "x").WithGroup("g").Error("read failed after reader reset", "err", context.Canceled)
		}, false},
		{"nudge", func(l *slog.Logger) {
			l.Error("initial read failed", "err", errors.New(errDownloadDisabled))
		}, false},
		{"real read error", func(l *slog.Logger) {
			l.Error("error reading", "piece", 3, "err", errors.New("disk full"))
		}, true},
		{"cancellation outside reads", func(l *slog.Logger) {
			l.Error("announce failed", "err", context.Canceled)
		}, true},
		{"read message without err", func(l *slog.Logger) { l.Warn("slow read") }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			c.log(slog.New(QuietReadErrors(slog.NewTextHandler(&buf, nil))))
			if got := strings.TrimSpace(buf.String()) != ""; got != c.want {
				t.Errorf("logged = %v, want %v (%q)", got, c.want, buf.String())
			}
		})
	}
}

func TestScrubURLs(t *testing.T) {
	var buf bytes.Buffer
	l := slog.New(ScrubURLs(slog.NewTextHandler(&buf, nil))).
		With("url", "http://alice:s3cret@tracker.example/pk-123/announce")
	l.Warn(`error announcing to "udp://bob:hunter2@tracker.example:6969/announce?passkey=pk-456"`,
		"err", errors.New(`Get "https://tracker.example/announce/pk-789": EOF`),
		slog.Group("g", "u", "wss://carol:pw@tracker.example/x"),
		"n", 3)
	out := buf.String()
	for _, secret := range []string{"alice", "s3cret", "bob", "hunter2", "pk-", "carol"} {
		if strings.Contains(out, secret) {
			t.Fatalf("log line has %q: %s", secret, out)
		}
	}
	for _, kept := range []string{"url=http://tracker.example", "udp://tracker.example:6969", "https://tracker.example", "g.u=wss://tracker.example", "n=3"} {
		if !strings.Contains(out, kept) {
			t.Fatalf("log line lacks %q: %s", kept, out)
		}
	}
}
