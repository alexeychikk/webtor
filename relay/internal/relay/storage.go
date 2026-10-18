package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
)

// NewStorage stores each torrent's pieces in dir/<infohash>/, one file per torrent file, named by a
// hash of its path so names that are invalid or too long on the host OS (`?` on Windows, …) still
// work. Piece completion lives in memory only: the data is a cache for the tab streaming it, so
// nothing has to survive a restart, and TorrentDir can be deleted at any time after a drop.
func NewStorage(dir string) storage.ClientImplCloser {
	return storage.NewFileOpts(storage.NewFileClientOpts{
		ClientBaseDir: dir,
		TorrentDirMaker: func(base string, _ *metainfo.Info, ih metainfo.Hash) string {
			return TorrentDir(base, ih)
		},
		FilePathMaker: func(o storage.FilePathMakerOpts) string {
			sum := sha256.Sum256([]byte(strings.Join(o.File.BestPath(), "/")))
			return hex.EncodeToString(sum[:12])
		},
		PieceCompletion: storage.NewMapPieceCompletion(),
	})
}

// TorrentDir is where NewStorage keeps one torrent's data.
func TorrentDir(dataDir string, ih metainfo.Hash) string {
	return filepath.Join(dataDir, ih.HexString())
}

// ResetDataDir deletes everything a previous run left in dir and recreates it empty.
func ResetDataDir(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o700)
}
