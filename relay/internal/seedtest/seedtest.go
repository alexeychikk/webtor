// Package seedtest runs a "regular" BitTorrent seeder for tests: TCP only, loopback only, no DHT,
// no trackers, no WebRTC. It stands in for qBittorrent/Transmission in a swarm the browser can't reach.
package seedtest

import (
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"time"

	g "github.com/anacrolix/generics"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
)

// Seeder seeds one file or directory.
type Seeder struct {
	Client   *torrent.Client
	MetaInfo *metainfo.MetaInfo
	InfoHash metainfo.Hash
	// Addr is the seeder's TCP address, for a magnet's `x.pe=`.
	Addr string
}

// Start seeds path (a file or a directory) with the given piece length (0 = 256 KiB).
func Start(path string, pieceLength int64) (*Seeder, error) {
	if pieceLength == 0 {
		pieceLength = 256 << 10
	}
	info := metainfo.Info{PieceLength: pieceLength}
	if err := info.BuildFromFilePath(path); err != nil {
		return nil, err
	}
	ib, err := bencode.Marshal(&info)
	if err != nil {
		return nil, err
	}
	mi := &metainfo.MetaInfo{InfoBytes: ib}

	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.NoDHT = true
	cfg.DisableTrackers = true
	cfg.DisableUTP = true
	cfg.DisableWebtorrent = true
	cfg.DisableIPv6 = true
	cfg.NoDefaultPortForwarding = true
	cfg.Seed = true
	cfg.DataDir = filepath.Dir(path)
	cfg.DefaultStorage = storage.NewFileOpts(storage.NewFileClientOpts{
		ClientBaseDir: filepath.Dir(path),
		UsePartFiles:  g.Some(false),
	})
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, err
	}
	t, err := cl.AddTorrent(mi)
	if err != nil {
		cl.Close()
		return nil, err
	}
	<-t.GotInfo()
	if err := t.VerifyData(); err != nil {
		cl.Close()
		return nil, fmt.Errorf("verifying seed data: %w", err)
	}
	select {
	case <-t.Complete().On():
	case <-time.After(30 * time.Second):
		cl.Close()
		return nil, fmt.Errorf("seed data incomplete after verification")
	}
	return &Seeder{
		Client:   cl,
		MetaInfo: mi,
		InfoHash: t.InfoHash(),
		Addr:     net.JoinHostPort("127.0.0.1", strconv.Itoa(cl.LocalPort())),
	}, nil
}

// Close stops the seeder.
func (s *Seeder) Close() { s.Client.Close() }
