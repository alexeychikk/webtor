// Command tcp-seeder seeds a file to "regular" BitTorrent peers only (TCP on 127.0.0.1, no DHT, no
// trackers, no WebRTC) and prints a magnet whose x.pe= points at it. Test tool: it proves the relay
// route, because the browser alone can never reach this seeder.
package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"

	"github.com/alexeychikk/webtor/relay/internal/seedtest"
)

func main() {
	pieceLength := flag.Int64("piece-length", 256<<10, "piece length in bytes")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: tcp-seeder [-piece-length N] <file-or-dir>")
		os.Exit(2)
	}
	s, err := seedtest.Start(flag.Arg(0), *pieceLength)
	if err != nil {
		fmt.Fprintln(os.Stderr, "tcp-seeder:", err)
		os.Exit(1)
	}
	defer s.Close()
	info, _ := s.MetaInfo.UnmarshalInfo()
	fmt.Printf("magnet:?xt=urn:btih:%s&dn=%s&x.pe=%s\n", s.InfoHash.HexString(), url.QueryEscape(info.Name), s.Addr)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	<-sig
}
