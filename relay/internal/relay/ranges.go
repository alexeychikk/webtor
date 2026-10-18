package relay

import (
	"strconv"
	"strings"
)

// parseRange parses a single-range `Range: bytes=first-[last]` header. last is -1 when open-ended.
// Suffix ranges (bytes=-N), several ranges and malformed headers give ok=false.
func parseRange(header string) (first, last int64, ok bool) {
	spec, ok := strings.CutPrefix(header, "bytes=")
	if !ok || strings.Contains(spec, ",") {
		return 0, 0, false
	}
	a, b, ok := strings.Cut(strings.TrimSpace(spec), "-")
	if !ok || a == "" {
		return 0, 0, false
	}
	first, err := strconv.ParseInt(a, 10, 64)
	if err != nil || first < 0 {
		return 0, 0, false
	}
	if b == "" {
		return first, -1, true
	}
	last, err = strconv.ParseInt(b, 10, 64)
	if err != nil || last < first {
		return 0, 0, false
	}
	return first, last, true
}

// RangeEnd returns the exclusive end offset of the request's byte range in a file of size bytes, or
// size when the header is absent, open-ended or not a single range (http.ServeContent then serves or
// rejects it as a whole). The relay reads ahead up to this end for the request and parks its
// prefetch reader there.
func RangeEnd(header string, size int64) int64 {
	if _, last, ok := parseRange(header); ok && last >= 0 && last+1 < size {
		return last + 1
	}
	return size
}

// RangeMinLength is the smallest file size the request's byte range fits in (0 without a range).
func RangeMinLength(header string) int64 {
	first, last, ok := parseRange(header)
	switch {
	case !ok:
		return 0
	case last < 0:
		return first + 1
	default:
		return last + 1
	}
}
