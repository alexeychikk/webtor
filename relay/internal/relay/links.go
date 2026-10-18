package relay

import (
	"net"
	"net/url"
	"strings"
)

// HostedApp is the public build of the web app.
const HostedApp = "https://alexeychikk.github.io/webtor/"

// Links are what the relay prints at startup.
type Links struct {
	// Relay is the URL to paste into the app's relay setting ({base} of the API).
	Relay string
	// Open is the app this relay serves at "/", configured through the hash: same-origin, so it
	// works in every browser (Safari blocks http://127.0.0.1 from HTTPS pages).
	Open string
	// Hosted is the same link on the hosted site (Chrome and Firefox ask once for local network access).
	Hosted string
}

// MakeLinks builds the startup links from -public-url (may be empty) and the bound listen address.
// An unspecified listen host (0.0.0.0, ::) is shown as 127.0.0.1.
func MakeLinks(publicURL, listenAddr, token string) Links {
	base := strings.TrimSuffix(publicURL, "/")
	if base == "" {
		host, port, err := net.SplitHostPort(listenAddr)
		if err != nil {
			host, port = listenAddr, ""
		}
		if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
			host = "127.0.0.1"
		}
		if port != "" {
			host = net.JoinHostPort(host, port)
		}
		base = "http://" + host
	}
	relayURL := base + "/" + token
	hash := "#relay=" + url.QueryEscape(relayURL)
	return Links{Relay: relayURL, Open: base + "/" + hash, Hosted: HostedApp + hash}
}
