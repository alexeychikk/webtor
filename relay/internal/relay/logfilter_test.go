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
