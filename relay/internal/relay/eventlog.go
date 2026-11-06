package relay

import (
	"encoding/json"
	"sync"
	"time"
)

// maxEventBytes caps one encoded event; a bigger one keeps only its time and kind.
const maxEventBytes = 2 << 10

// maxEventString caps every string value of an event.
const maxEventString = 300

// eventLog is a ring of JSON-encoded events bounded by count and by bytes: adding to a full log
// drops the oldest events. Its memory never depends on uptime.
type eventLog struct {
	mu       sync.Mutex
	maxCount int
	maxBytes int
	items    []json.RawMessage
	bytes    int
	dropped  int64
	now      func() time.Time
}

func newEventLog(maxCount, maxBytes int) *eventLog {
	return &eventLog{maxCount: maxCount, maxBytes: maxBytes, now: time.Now}
}

// add records an event of kind with key/value pairs (string keys; odd trailing values are ignored).
func (l *eventLog) add(kind string, kv ...any) {
	if l == nil {
		return
	}
	ev := make(map[string]any, len(kv)/2+2)
	for i := 0; i+1 < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			continue
		}
		ev[k] = eventValue(kv[i+1])
	}
	ev["t"] = l.now().UTC().Format("2006-01-02T15:04:05.000Z")
	ev["kind"] = kind
	b, err := json.Marshal(ev)
	if err != nil || len(b) > maxEventBytes {
		b, _ = json.Marshal(map[string]any{"t": ev["t"], "kind": kind, "truncated": true})
	}
	l.push(b)
}

func eventValue(v any) any {
	switch x := v.(type) {
	case string:
		return clip(x, maxEventString)
	case error:
		if x == nil {
			return nil
		}
		return clip(x.Error(), maxEventString)
	case time.Duration:
		return x.Milliseconds()
	default:
		return v
	}
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (l *eventLog) push(b json.RawMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for len(l.items) > 0 && (len(l.items) >= l.maxCount || l.bytes+len(b) > l.maxBytes) {
		l.dropOldestLocked()
	}
	// Dropping re-slices from the front; append copies the live events into a new array (at most
	// twice their count) once the old one is full, so the backing array stays bounded too.
	l.items = append(l.items, b)
	l.bytes += len(b)
}

func (l *eventLog) dropOldestLocked() {
	l.bytes -= len(l.items[0])
	l.items[0] = nil
	l.items = l.items[1:]
	l.dropped++
}

// eventsJSON is a log as served by /v1/diagnostics.
type eventsJSON struct {
	Events   []json.RawMessage `json:"events"`
	Dropped  int64             `json:"dropped"`
	MaxCount int               `json:"maxCount"`
	MaxBytes int               `json:"maxBytes"`
}

func (l *eventLog) snapshot() eventsJSON {
	l.mu.Lock()
	defer l.mu.Unlock()
	return eventsJSON{
		Events: append([]json.RawMessage{}, l.items...), Dropped: l.dropped,
		MaxCount: l.maxCount, MaxBytes: l.maxBytes,
	}
}

func (l *eventLog) size() (count, bytes int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.items), l.bytes
}
