package relay

import (
	"fmt"
	"math"
	"testing"
	"time"
)

func TestRateMeter(t *testing.T) {
	t0 := time.Unix(1000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	type step struct {
		ms    int
		total int64
		want  float64
	}
	for _, tc := range []struct {
		name  string
		steps []step
	}{
		{"first sample has no rate", []step{{0, 500, 0}}},
		{"steady 1 MB/s", []step{{0, 0, 0}, {1000, 1e6, 1e6}, {2000, 2e6, 1e6}}},
		{"calls closer than the sample spacing use the older base", []step{{0, 0, 0}, {100, 1e5, 1e6}, {200, 2e5, 1e6}}},
		{"idle counter", []step{{0, 7e6, 0}, {1000, 7e6, 0}, {2000, 7e6, 0}}},
		{"window forgets an old burst", []step{
			// the base is the last sample at or before the window start (500 ms)
			{0, 0, 0}, {500, 50e6, 100e6}, {6000, 50e6, 0}, {7000, 51e6, 1e6 / 6.5},
		}},
		{"counter going back never gives a negative rate", []step{{0, 100, 0}, {1000, 50, 0}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var m rateMeter
			for i, s := range tc.steps {
				got := m.observe(at(s.ms), s.total)
				if math.Abs(got-s.want) > 1 {
					t.Errorf("step %d (%d ms, %d B): rate %.0f, want %.0f", i, s.ms, s.total, got, s.want)
				}
			}
		})
	}
}

func TestRateMeterKeepsFewSamples(t *testing.T) {
	var m rateMeter
	t0 := time.Unix(0, 0)
	for i := range 1000 {
		m.observe(t0.Add(time.Duration(i)*100*time.Millisecond), int64(i))
	}
	if n := len(m.samples); n > int(rateWindow/rateSampleEvery)+2 {
		t.Fatalf("%d samples kept", n)
	}
}

func TestAdaptiveReadahead(t *testing.T) {
	const mib = 1 << 20
	for _, tc := range []struct {
		rate     float64
		min, max int64
		want     int64
	}{
		{0, 32 * mib, 512 * mib, 32 * mib},
		{100e3, 32 * mib, 512 * mib, 32 * mib},     // 30 s of 100 kB/s is under the minimum
		{2 * mib, 32 * mib, 512 * mib, 60 * mib},   // 30 s
		{10 * mib, 32 * mib, 512 * mib, 300 * mib}, // a 4K remux
		{40 * mib, 32 * mib, 512 * mib, 512 * mib}, // capped
		{10 * mib, 32 * mib, 16 * mib, 32 * mib},   // max below min: min wins
		{-5, 32 * mib, 512 * mib, 32 * mib},
	} {
		if got := AdaptiveReadahead(tc.rate, tc.min, tc.max); got != tc.want {
			t.Errorf("AdaptiveReadahead(%.0f, %d, %d) = %d, want %d", tc.rate, tc.min, tc.max, got, tc.want)
		}
	}
}

func TestPieceSpan(t *testing.T) {
	for _, tc := range []struct {
		off, n, length, piece int64
		begin, end            int
	}{
		{0, 100, 1000, 100, 0, 1},
		{0, 101, 1000, 100, 0, 2},
		{150, 100, 1000, 100, 1, 3},
		{950, 500, 1000, 100, 9, 10}, // clamped to the torrent
		{1000, 10, 1000, 100, 0, 0},  // at the end: nothing
		{10, 0, 1000, 100, 0, 0},
		{10, 10, 1000, 0, 0, 0},
	} {
		b, e := pieceSpan(tc.off, tc.n, tc.length, tc.piece)
		if b != tc.begin || e != tc.end {
			t.Errorf("pieceSpan(%d, %d, %d, %d) = [%d, %d), want [%d, %d)", tc.off, tc.n, tc.length, tc.piece, b, e, tc.begin, tc.end)
		}
	}
}

func TestNextWindow(t *testing.T) {
	r := func(b, e int) pieceRange { return pieceRange{b, e} }
	for _, tc := range []struct {
		name      string
		old, want pieceRange
		next      pieceRange
		cancel    []pieceRange
	}{
		{"first window", r(0, 0), r(5, 10), r(5, 10), nil},
		{"moves forward", r(5, 10), r(6, 11), r(6, 11), []pieceRange{r(5, 6)}},
		{"late request keeps the far end", r(6, 11), r(5, 10), r(5, 11), nil},
		{"smaller readahead keeps the far end", r(5, 20), r(6, 10), r(6, 20), []pieceRange{r(5, 6)}},
		{"touching counts as overlapping", r(5, 10), r(10, 15), r(10, 15), []pieceRange{r(5, 10)}},
		{"seek ahead", r(5, 10), r(50, 55), r(50, 55), []pieceRange{r(5, 10)}},
		{"seek back", r(50, 55), r(5, 10), r(5, 10), []pieceRange{r(50, 55)}},
		{"nothing wanted (end of file)", r(5, 10), r(0, 0), r(0, 0), []pieceRange{r(5, 10)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next, cancel := nextWindow(tc.old, tc.want)
			if next != tc.next || fmt.Sprint(cancel) != fmt.Sprint(tc.cancel) {
				t.Errorf("nextWindow(%v, %v) = %v, cancel %v; want %v, cancel %v", tc.old, tc.want, next, cancel, tc.next, tc.cancel)
			}
		})
	}
}
