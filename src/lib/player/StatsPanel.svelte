<script lang="ts">
  /**
   * Content of the stats panel (docs/decisions/0008 §4): peers, speeds, buffer window and quota hits
   * (docs/decisions/0003), progress; live values.
   */
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Layers from '@lucide/svelte/icons/layers';
  import Users from '@lucide/svelte/icons/users';
  import { formatBytes, formatPercent, formatSeconds, formatSpeed } from './format';
  import type { BufferInfo } from './mse-player';
  import type { TorrentStats } from './types';

  let { stats, buffer = null }: { stats: TorrentStats; buffer?: BufferInfo | null } = $props();
</script>

<dl class="stats" data-testid="stats" aria-label="Download stats">
  <div>
    <dt><Users size={16} aria-hidden="true" /> Peers</dt>
    <dd data-testid="stats-peers">
      {stats.numPeers}
      {#if stats.relayPeers !== undefined}
        <span data-testid="relay-peers">· {stats.relayPeers} via relay</span>
      {/if}
    </dd>
  </div>
  <div>
    <dt><ArrowDown size={16} aria-hidden="true" /> Down</dt>
    <dd data-testid="stats-download">{formatSpeed(stats.downloadSpeed)}</dd>
  </div>
  <div>
    <dt><ArrowUp size={16} aria-hidden="true" /> Up</dt>
    <dd data-testid="stats-upload">{formatSpeed(stats.uploadSpeed)}</dd>
  </div>
  {#if buffer}
    <div>
      <dt><Layers size={16} aria-hidden="true" /> Buffer</dt>
      <dd
        data-testid="stats-buffer"
        data-ahead={buffer.ahead.toFixed(1)}
        data-target={buffer.target}
        data-quota-hits={buffer.quotaHits}
      >
        {formatSeconds(buffer.ahead)} of {formatSeconds(buffer.target)} ahead
        {#if buffer.quotaHits > 0}
          <span class="bytes">· {buffer.quotaHits} quota hits</span>
        {/if}
      </dd>
    </div>
  {/if}
  <div class="progress">
    <div class="bar" aria-hidden="true">
      <div style:width="{Math.min(1, stats.progress) * 100}%"></div>
    </div>
    <dt class="sr-only">Progress</dt>
    <dd>
      <span data-testid="stats-progress">{formatPercent(stats.progress)}</span>
      {#if stats.length}
        <span class="bytes">
          {formatBytes(Math.min(stats.downloaded ?? 0, stats.length))} of {formatBytes(
            stats.length,
          )}
        </span>
      {/if}
    </dd>
  </div>
</dl>

<style>
  .stats {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-4);
    font-variant-numeric: tabular-nums;
  }
  .stats > div {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  dt {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 5.5rem;
    color: var(--text-muted);
  }
  dd {
    margin: 0;
  }
  .progress {
    flex-wrap: wrap;
    padding-top: var(--space-1);
  }
  .progress dd {
    display: flex;
    flex: 1;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .bar {
    flex-basis: 100%;
    height: 6px;
    border-radius: 3px;
    background: var(--seek-track);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--seek-played);
  }
  .bytes {
    color: var(--text-muted);
  }
</style>
