package relay

import (
	"context"
	"errors"
	"fmt"
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

// ScrubURLs wraps the torrent library's log handler and reduces every URL in a record's message
// and values to its scheme and host (scrubURLs): the library quotes tracker URLs, which can carry
// a login or a passkey, in its log lines and errors. Wrap it inside QuietReadErrors, which needs
// the original error values.
func ScrubURLs(h slog.Handler) slog.Handler { return scrubHandler{h} }

type scrubHandler struct{ slog.Handler }

func (s scrubHandler) Handle(ctx context.Context, r slog.Record) error {
	out := slog.NewRecord(r.Time, r.Level, scrubURLs(r.Message), r.PC)
	r.Attrs(func(a slog.Attr) bool {
		out.AddAttrs(scrubAttr(a))
		return true
	})
	return s.Handler.Handle(ctx, out)
}

func (s scrubHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	scrubbed := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		scrubbed[i] = scrubAttr(a)
	}
	return scrubHandler{s.Handler.WithAttrs(scrubbed)}
}

func (s scrubHandler) WithGroup(name string) slog.Handler {
	return scrubHandler{s.Handler.WithGroup(name)}
}

func scrubAttr(a slog.Attr) slog.Attr {
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindString:
		return slog.String(a.Key, scrubURLs(v.String()))
	case slog.KindGroup:
		group := v.Group()
		scrubbed := make([]any, len(group))
		for i, g := range group {
			scrubbed[i] = scrubAttr(g)
		}
		return slog.Group(a.Key, scrubbed...)
	case slog.KindAny:
		if text := fmt.Sprint(v.Any()); strings.Contains(text, "://") {
			return slog.String(a.Key, scrubURLs(text))
		}
	}
	return slog.Attr{Key: a.Key, Value: v}
}
