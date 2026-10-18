// Package webapp embeds the web app that webtor-relay serves at "/", so opening
// http://127.0.0.1:7881/#relay=<url> is same-origin with the relay in every browser.
//
// dist/ holds a committed placeholder index.html that links to the hosted site. A release build
// replaces dist/ with the built app (`pnpm build`, then copy the root dist/ here) before `go build`.
package webapp

import (
	"embed"
	"io/fs"
)

//go:embed dist
var dist embed.FS

// FS is the app, rooted at its index.html.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
