# webtor

Stream torrents in your browser — paste a magnet link or open a .torrent file, pick the file, audio and
subtitles, watch. No server: peer-to-peer over WebRTC (WebTorrent), remuxed in the tab (Mediabunny)
and played through Media Source Extensions.

Browsers can only connect to WebRTC-capable peers, so many public torrents will not start. See
[`CLAUDE.md`](CLAUDE.md) and [`docs/decisions/`](docs/decisions/) for how it works and its limits.
To reach regular BitTorrent peers, run [webtor-relay](relay/README.md) on your computer or a server
([download](https://github.com/alexeychikk/webtor/releases/latest)).

Keyboard: Space play/pause · ←/→ seek 5 s · F fullscreen · M mute · C next subtitle track. Subtitles
can be shifted in 0.5 s steps; "Copy share link" copies a link that plays the same file.

```sh
pnpm install && pnpm dev
```
