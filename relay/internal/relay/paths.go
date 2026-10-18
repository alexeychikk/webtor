package relay

import (
	"net/url"
	"strings"
)

// WebseedFile is what ResolveWebseedPath needs to know about a torrent file.
type WebseedFile struct {
	// Path is anacrolix's File.Path(): "<name>/<path>" for multi-file torrents, the name otherwise.
	Path   string
	Length int64
}

// ResolveWebseedPath maps the path WebTorrent appends to a web seed URL onto a file index.
//
// WebTorrent (lib/webconn.js) requests the bare URL for single-file torrents and URL +
// "<torrent name>/<path>" for multi-file ones, without percent-encoding. So a '?' in a name turns the
// rest into a query string (query: the request's "?"+RawQuery, or "" without a '?'; it is put back), and a '#' cuts the rest off entirely. For
// the latter, the files whose path continues the requested prefix with a '#' are candidates, and
// minLength (the end of the requested byte range, see RangeMinLength) rules out files too short for
// the request. The match must be unique: files whose paths only differ after a '#' can be ambiguous.
// Percent-encoded paths always match exactly.
func ResolveWebseedPath(files []WebseedFile, requested, query string, minLength int64) (int, bool) {
	requested = strings.TrimPrefix(requested, "/")
	if len(files) == 1 && (requested == "" || requested == files[0].Path) {
		return 0, true
	}
	want := requested
	if query != "" {
		if q, err := url.PathUnescape(query); err == nil {
			want = requested + q
		}
	}
	for i, f := range files {
		if f.Path == want {
			return i, true
		}
	}
	found := -1
	for i, f := range files {
		p := f.Path
		if strings.HasPrefix(p, want) && len(p) > len(want) && p[len(want)] == '#' && f.Length >= minLength {
			if found >= 0 {
				return 0, false
			}
			found = i
		}
	}
	return found, found >= 0
}
