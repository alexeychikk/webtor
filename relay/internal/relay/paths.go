package relay

import (
	"net/url"
	"strings"
)

// ResolveWebseedPath maps the path WebTorrent appends to a web seed URL onto a file index.
//
// WebTorrent (lib/webconn.js) requests the bare URL for single-file torrents and URL + "/" +
// "<torrent name>/<path>" for multi-file ones, without percent-encoding. So a '?' in a file name
// turns the rest into a query string and a '#' cuts the rest off entirely. paths are anacrolix
// File.Path() values ("<name>/<path>" for multi-file torrents, the name for single-file ones);
// rawQuery is the request's raw query string.
func ResolveWebseedPath(name string, paths []string, requested, rawQuery string) (int, bool) {
	requested = strings.TrimPrefix(requested, "/")
	if len(paths) == 1 && (requested == "" || requested == name || requested == paths[0]) {
		return 0, true
	}
	want := requested
	if rawQuery != "" {
		if q, err := url.PathUnescape(rawQuery); err == nil {
			want = requested + "?" + q
		}
	}
	for i, p := range paths {
		if p == want {
			return i, true
		}
	}
	// A '#' truncated the name: accept a unique file whose path continues with '#'.
	found := -1
	for i, p := range paths {
		if strings.HasPrefix(p, want) && len(p) > len(want) && p[len(want)] == '#' {
			if found >= 0 {
				return 0, false
			}
			found = i
		}
	}
	return found, found >= 0
}
