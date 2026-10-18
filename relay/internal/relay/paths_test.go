package relay

import "testing"

func TestResolveWebseedPath(t *testing.T) {
	multi := []string{"Show/S01/Ep 1.mkv", "Show/S01/Ep #2.mkv", "Show/What?.mkv", "Show/a#1.srt", "Show/a#2.srt"}
	cases := []struct {
		name, requested, query string
		paths                  []string
		want                   int
		ok                     bool
	}{
		{"single file, bare url", "", "", []string{"movie.mkv"}, 0, true},
		{"single file, named", "movie.mkv", "", []string{"movie.mkv"}, 0, true},
		{"multi exact", "Show/S01/Ep 1.mkv", "", multi, 0, true},
		{"leading slash", "/Show/S01/Ep 1.mkv", "", multi, 0, true},
		{"hash truncated", "Show/S01/Ep ", "", multi, 1, true},
		{"question mark became a query", "Show/What", ".mkv", multi, 2, true},
		{"ambiguous hash truncation", "Show/a", "", multi, 0, false},
		{"unknown", "Show/nope.mkv", "", multi, 0, false},
		{"multi needs a path", "", "", multi, 0, false},
	}
	for _, c := range cases {
		got, ok := ResolveWebseedPath("Show", c.paths, c.requested, c.query)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("%s: got (%d, %v), want (%d, %v)", c.name, got, ok, c.want, c.ok)
		}
	}
}
