package relay

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// LogEvery is how often a repeated stdout line (same key) gets through; the rest are counted and
// reported as "suppressed" on the next one, so the relay's output (journald on a VM) stays small
// at any uptime. Details live in the diagnostics logs instead.
const LogEvery = time.Minute

// maxThrottleKeys bounds a logThrottle's memory; past it the oldest state is forgotten.
const maxThrottleKeys = 256

// logThrottle lets a line with a given key through at most once per every.
type logThrottle struct {
	mu    sync.Mutex
	every time.Duration
	seen  map[string]*throttled
}

type throttled struct {
	last       time.Time
	suppressed int
}

func newLogThrottle(every time.Duration) *logThrottle {
	return &logThrottle{every: every, seen: map[string]*throttled{}}
}

// allow says whether a line with key may be written at now, and how many were held back since the
// last one that was.
func (t *logThrottle) allow(key string, now time.Time) (ok bool, suppressed int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.seen[key]
	if st == nil {
		if len(t.seen) >= maxThrottleKeys {
			t.forgetLocked(now)
		}
		t.seen[key] = &throttled{last: now}
		return true, 0
	}
	if now.Sub(st.last) < t.every {
		st.suppressed++
		return false, 0
	}
	suppressed = st.suppressed
	st.last, st.suppressed = now, 0
	return true, suppressed
}

func (t *logThrottle) forgetLocked(now time.Time) {
	for k, st := range t.seen {
		if now.Sub(st.last) >= t.every {
			delete(t.seen, k)
		}
	}
	if len(t.seen) >= maxThrottleKeys {
		clear(t.seen)
	}
}

// ThrottleLog wraps a handler so that each message goes through at most once per every (the
// torrent library repeats its warnings per peer and per piece).
func ThrottleLog(h slog.Handler, every time.Duration) slog.Handler {
	return &throttleHandler{Handler: h, t: newLogThrottle(every)}
}

type throttleHandler struct {
	slog.Handler
	t *logThrottle
}

func (h *throttleHandler) Handle(ctx context.Context, r slog.Record) error {
	ok, suppressed := h.t.allow(r.Message, r.Time)
	if !ok {
		return nil
	}
	if suppressed > 0 {
		r = r.Clone()
		r.AddAttrs(slog.Int("suppressed", suppressed))
	}
	return h.Handler.Handle(ctx, r)
}

func (h *throttleHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &throttleHandler{Handler: h.Handler.WithAttrs(attrs), t: h.t}
}

func (h *throttleHandler) WithGroup(name string) slog.Handler {
	return &throttleHandler{Handler: h.Handler.WithGroup(name), t: h.t}
}
