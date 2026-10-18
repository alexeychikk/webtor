package relay

import (
	"context"
	"errors"
	"log/slog"
	"strings"
)

// QuietReadErrors wraps the torrent library's log handler and drops the read errors that are part
// of normal streaming: the browser aborting a web seed read (a seek cancels the request context) and
// the "downloading disabled" read error while watchStall nudges a torrent. anacrolix logs both at
// Error level, which users would read as failures. Everything else passes through.
func QuietReadErrors(h slog.Handler) slog.Handler { return quietHandler{h} }

type quietHandler struct{ slog.Handler }

func (q quietHandler) Handle(ctx context.Context, r slog.Record) error {
	if expectedReadError(r) {
		return nil
	}
	return q.Handler.Handle(ctx, r)
}

func (q quietHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return quietHandler{q.Handler.WithAttrs(attrs)}
}

func (q quietHandler) WithGroup(name string) slog.Handler {
	return quietHandler{q.Handler.WithGroup(name)}
}

// expectedReadError: a record about a failed read ("initial read failed", "read failed after …",
// "error reading") whose err is a cancellation or the nudge's "downloading disabled".
func expectedReadError(r slog.Record) bool {
	if !strings.Contains(r.Message, "read") {
		return false
	}
	expected := false
	r.Attrs(func(a slog.Attr) bool {
		if a.Key != "err" {
			return true
		}
		if err, ok := a.Value.Any().(error); ok {
			expected = errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
				strings.Contains(err.Error(), errDownloadDisabled)
		}
		return false
	})
	return expected
}
