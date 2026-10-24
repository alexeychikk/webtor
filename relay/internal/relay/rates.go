package relay

import (
	"sync"
	"time"
)

// rateWindow is how far back a rateMeter looks: long enough to smooth WebTorrent's piece-sized
// bursts, short enough that the stats panel follows a change within seconds.
const rateWindow = 5 * time.Second

// rateSampleEvery keeps a meter's samples apart, so frequent callers don't grow it.
const rateSampleEvery = 250 * time.Millisecond

// rateMeter turns a growing byte counter into bytes per second over the last rateWindow. Callers
// pass the counter's total whenever they need the rate (stats requests, readahead decisions);
// there is no ticker.
type rateMeter struct {
	mu      sync.Mutex
	samples []rateSample
}

type rateSample struct {
	at    time.Time
	total int64
}

// observe records total at now and returns the rate since the oldest sample within rateWindow
// (0 until two samples are rateSampleEvery apart).
func (m *rateMeter) observe(now time.Time, total int64) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n := len(m.samples); n == 0 || now.Sub(m.samples[n-1].at) >= rateSampleEvery {
		m.samples = append(m.samples, rateSample{now, total})
	} else if total < m.samples[n-1].total {
		m.samples[n-1].total = total // a counter that went back (never expected): don't go negative
	}
	// Keep one sample at or before the window's start as the base.
	cut := 0
	for cut+1 < len(m.samples) && now.Sub(m.samples[cut+1].at) >= rateWindow {
		cut++
	}
	m.samples = m.samples[cut:]
	base := m.samples[0]
	dt := now.Sub(base.at).Seconds()
	if dt <= 0 || total <= base.total {
		return 0
	}
	return float64(total-base.total) / dt
}

// ReadaheadSeconds is how much of the stream, at its recent served rate, the relay downloads past
// the browser's last request.
const ReadaheadSeconds = 30

// DefaultMaxReadahead bounds the adaptive readahead (and so the extra disk a torrent uses past what
// was watched). 512 MiB is 30 s of a ~17 MB/s stream.
const DefaultMaxReadahead = 512 << 20

// AdaptiveReadahead is the prefetch window for a stream served at rate bytes/s: ReadaheadSeconds of
// it, at least minRA and at most maxRA.
func AdaptiveReadahead(rate float64, minRA, maxRA int64) int64 {
	maxRA = max(maxRA, minRA)
	if rate <= 0 {
		return minRA
	}
	want := rate * ReadaheadSeconds
	if want >= float64(maxRA) {
		return maxRA
	}
	return max(minRA, int64(want))
}

// pieceSpan is the piece index range [begin, end) holding the byte range [off, off+n) of a torrent
// with pieces of pieceLength bytes, clamped to the torrent's length.
func pieceSpan(off, n, length, pieceLength int64) (begin, end int) {
	if pieceLength <= 0 || n <= 0 || off >= length {
		return 0, 0
	}
	stop := min(off+n, length)
	return int(off / pieceLength), int((stop + pieceLength - 1) / pieceLength)
}

// pieceRange is a half-open piece index range [begin, end).
type pieceRange struct{ begin, end int }

// nextWindow moves the prefetch window (pieces raised to Normal priority) from old to want. A
// window that overlaps or touches the old one keeps its far end (a request that arrives late, or a
// smaller readahead, doesn't give up pieces already asked for) and gives up what is behind
// want.begin; a disjoint one (a seek) gives up all of old. cancel lists the ranges to lower again.
func nextWindow(old, want pieceRange) (next pieceRange, cancel []pieceRange) {
	if want.begin >= want.end {
		if old.begin < old.end {
			cancel = append(cancel, old)
		}
		return pieceRange{}, cancel
	}
	if old.begin >= old.end || want.begin > old.end || want.end < old.begin {
		if old.begin < old.end {
			cancel = append(cancel, old)
		}
		return want, cancel
	}
	next = pieceRange{want.begin, max(want.end, old.end)}
	if old.begin < want.begin {
		cancel = append(cancel, pieceRange{old.begin, want.begin})
	}
	return next, cancel
}
