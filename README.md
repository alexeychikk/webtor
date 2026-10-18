# webtor

Stream torrents in your browser — paste a magnet link, pick audio and subtitles, watch. No server:
peer-to-peer over WebRTC (WebTorrent), remuxed in the tab (Mediabunny) and played through Media Source
Extensions.

Browsers can only connect to WebRTC-capable peers, so many public torrents will not start. See
[`CLAUDE.md`](CLAUDE.md) and [`docs/decisions/`](docs/decisions/) for how it works and its limits.

```sh
pnpm install && pnpm dev
```
