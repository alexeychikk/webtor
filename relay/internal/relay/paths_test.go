package relay

import (
	"strings"
	"testing"
)

func TestResolveWebseedPath(t *testing.T) {
	multi := []WebseedFile{
		{"Show/S01/Ep 1.mkv", 100}, {"Show/S01/Ep #2.mkv", 100}, {"Show/What?.mkv", 100},
		{"Show/a#1.srt", 10}, {"Show/a#2.srt", 20}, {"Show/b?#1.srt", 10},
	}
	cases := []struct {
		name, requested, query string
		minLength              int64
		files                  []WebseedFile
		want                   int
		ok                     bool
	}{
		{"single file, bare url", "", "", 0, []WebseedFile{{"movie.mkv", 5}}, 0, true},
		{"single file, named", "movie.mkv", "", 0, []WebseedFile{{"movie.mkv", 5}}, 0, true},
		{"single file, # in the name", "a", "", 0, []WebseedFile{{"a#b.mkv", 5}}, 0, true},
		{"multi exact", "Show/S01/Ep 1.mkv", "", 0, multi, 0, true},
		{"leading slash", "/Show/S01/Ep 1.mkv", "", 0, multi, 0, true},
		{"percent-encoded #", "Show/S01/Ep #2.mkv", "", 0, multi, 1, true},
		{"hash truncated", "Show/S01/Ep ", "", 0, multi, 1, true},
		{"question mark became a query", "Show/What", "?.mkv", 0, multi, 2, true},
		{"? then #", "Show/b", "?", 0, multi, 5, true},
		{"ambiguous hash truncation", "Show/a", "", 5, multi, 0, false},
		{"hash truncation, range only fits one", "Show/a", "", 15, multi, 4, true},
		{"hash truncation, range fits none", "Show/a", "", 25, multi, 0, false},
		{"unknown", "Show/nope.mkv", "", 0, multi, 0, false},
		{"multi needs a path", "", "", 0, multi, 0, false},
	}
	for _, c := range cases {
		got, ok := ResolveWebseedPath(c.files, c.requested, c.query, c.minLength)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("%s: got (%d, %v), want (%d, %v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestRangeMinLength(t *testing.T) {
	cases := map[string]int64{"": 0, "bytes=0-99": 100, "bytes=500-": 501, "bytes=-100": 0, "bytes=0-1,5-9": 0, "bytes=9-1": 0}
	for h, want := range cases {
		if got := RangeMinLength(h); got != want {
			t.Errorf("RangeMinLength(%q) = %d, want %d", h, got, want)
		}
	}
}

func TestRangeEnd(t *testing.T) {
	const size = 1000
	cases := map[string]int64{
		"":                 size,
		"bytes=0-99":       100,
		"bytes=500-":       size,
		"bytes=900-999":    size,
		"bytes=900-5000":   size,
		"bytes=-100":       size,
		"bytes=0-1,5-9":    size,
		"bytes=x-9":        size,
		"items=0-9":        size,
		"bytes= 10-19":     20,
		"bytes=10-garbage": size,
	}
	for h, want := range cases {
		if got := RangeEnd(h, size); got != want {
			t.Errorf("RangeEnd(%q) = %d, want %d", h, got, want)
		}
	}
}

func TestMakeLinks(t *testing.T) {
	cases := []struct{ public, listen, relay, open string }{
		{"", "127.0.0.1:7881", "http://127.0.0.1:7881/tok12345", "http://127.0.0.1:7881/#relay=http%3A%2F%2F127.0.0.1%3A7881%2Ftok12345"},
		{"", "0.0.0.0:7881", "http://127.0.0.1:7881/tok12345", "http://127.0.0.1:7881/#relay=http%3A%2F%2F127.0.0.1%3A7881%2Ftok12345"},
		{"", "[::]:7881", "http://127.0.0.1:7881/tok12345", "http://127.0.0.1:7881/#relay=http%3A%2F%2F127.0.0.1%3A7881%2Ftok12345"},
		{"", "[::1]:7881", "http://[::1]:7881/tok12345", "http://[::1]:7881/#relay=http%3A%2F%2F%5B%3A%3A1%5D%3A7881%2Ftok12345"},
		{"https://relay.example.com/", "0.0.0.0:7881", "https://relay.example.com/tok12345", "https://relay.example.com/#relay=https%3A%2F%2Frelay.example.com%2Ftok12345"},
	}
	for _, c := range cases {
		l := MakeLinks(c.public, c.listen, "tok12345")
		if l.Relay != c.relay || l.Open != c.open || l.Hosted != HostedApp+c.open[strings.Index(c.open, "#"):] {
			t.Errorf("MakeLinks(%q, %q) = %+v", c.public, c.listen, l)
		}
	}
}
