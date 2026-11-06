package relay

import (
	"net/url"
	"strings"
)

// trackerSchemes are the announce URL schemes anacrolix handles; it panics on any other one.
var trackerSchemes = map[string]bool{
	"http": true, "https": true, "udp": true, "udp4": true, "udp6": true, "ws": true, "wss": true,
}

// trackerCleanup counts what usableTrackers changed, for the diagnostics.
type trackerCleanup struct {
	ignored       int
	loginsRemoved int
}

// usableTrackers keeps the announce URLs anacrolix can take without panicking (v1.61 panics on
// userinfo, an unknown scheme and a URL that doesn't survive url.Parse + String unchanged): it
// removes userinfo (the library can't send it), normalises each URL and drops the rest. Tiers keep
// their order; empty ones are dropped.
func usableTrackers(tiers [][]string) ([][]string, trackerCleanup) {
	var c trackerCleanup
	out := make([][]string, 0, len(tiers))
	for _, tier := range tiers {
		var kept []string
		for _, raw := range tier {
			if strings.TrimSpace(raw) == "" {
				continue
			}
			u, hadLogin, ok := usableTracker(raw)
			if !ok {
				c.ignored++
				continue
			}
			if hadLogin {
				c.loginsRemoved++
			}
			kept = append(kept, u)
		}
		if kept = dedupe(kept); len(kept) > 0 {
			out = append(out, kept)
		}
	}
	return out, c
}

func usableTracker(raw string) (normalised string, hadLogin, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !trackerSchemes[u.Scheme] || u.Hostname() == "" || u.Opaque != "" {
		return "", false, false
	}
	hadLogin = u.User != nil
	u.User = nil
	u.Fragment, u.RawFragment = "", ""
	normalised = u.String()
	again, err := url.Parse(normalised)
	if err != nil || again.String() != normalised {
		return "", false, false
	}
	return normalised, hadLogin, true
}
