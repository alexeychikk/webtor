<script lang="ts">
  import { formatBytes, formatPercent, formatSpeed } from './format';
  import type { TorrentStats } from './types';

  let { stats }: { stats: TorrentStats } = $props();
</script>

<dl class="stats" data-testid="stats" aria-label="Download stats">
  <div>
    <dt>Peers</dt>
    <dd data-testid="stats-peers">
      {stats.numPeers}
      {#if stats.relayPeers !== undefined}
        <span data-testid="relay-peers">· {stats.relayPeers} via relay</span>
      {/if}
    </dd>
  </div>
  <div>
    <dt>Download</dt>
    <dd data-testid="stats-download">↓ {formatSpeed(stats.downloadSpeed)}</dd>
  </div>
  <div>
    <dt>Upload</dt>
    <dd data-testid="stats-upload">↑ {formatSpeed(stats.uploadSpeed)}</dd>
  </div>
  <div class="progress">
    <dt>Progress</dt>
    <dd>
      <progress max="1" value={stats.progress} aria-label="Downloaded"></progress>
      <span data-testid="stats-progress">{formatPercent(stats.progress)}</span>
      {#if stats.length}
        <span class="bytes">
          ({formatBytes(Math.min(stats.downloaded ?? 0, stats.length))} of {formatBytes(
            stats.length,
          )})
        </span>
      {/if}
    </dd>
  </div>
</dl>

<style>
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, currentColor 6%, transparent);
    font-variant-numeric: tabular-nums;
  }
  dt {
    font-size: 0.8em;
    opacity: 0.7;
  }
  dd {
    margin: 0;
  }
  .progress dd {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  progress {
    width: 8rem;
  }
  .bytes {
    opacity: 0.75;
  }
  @media (max-width: 30rem) {
    .stats > div {
      flex: 1 1 40%;
    }
    .stats > .progress {
      flex-basis: 100%;
    }
    progress {
      flex: 1;
    }
  }
</style>
