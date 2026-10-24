<script lang="ts">
  /**
   * Content of the stats panel (docs/decisions/0008 §4): peers, speeds, the relay's rates (ADR 0006),
   * buffer window and quota hits (docs/decisions/0003), the video's HDR format (ADR 0010), progress;
   * live values.
   */
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Layers from '@lucide/svelte/icons/layers';
  import Server from '@lucide/svelte/icons/server';
  import Sun from '@lucide/svelte/icons/sun';
  import Users from '@lucide/svelte/icons/users';
  import { formatBytes, formatPercent, formatSeconds, formatSpeed } from './format';
  import { HDR_LABELS, type HdrFormat } from './hdr';
  import type { BufferInfo } from './mse-player';
  import type { TorrentStats } from './types';
  import { relayRateRows } from '../torrent/relay';

  let {
    stats,
    buffer = null,
    hdr = null,
    toneMapped = false,
  }: {
    stats: TorrentStats;
    buffer?: BufferInfo | null;
    /** HDR format of the video playing; null = SDR (no row). */
    hdr?: HdrFormat | null;
    /** The display shows only SDR, so the HDR video is tone-mapped. */
    toneMapped?: boolean;
  } = $props();
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
  {#if stats.relayRates}
    <!-- Where a slow relay stream is limited: the swarm, the relay's uplink, or this side. -->
    <div class="relay" data-testid="relay-rates">
      <dt><Server size={16} aria-hidden="true" /> Relay</dt>
      <dd>
        <dl>
          {#each relayRateRows(stats.relayRates, formatSpeed) as row (row.key)}
            <div>
              <dt>{row.label}</dt>
              <dd data-testid="relay-{row.key}">{row.value}</dd>
            </div>
          {/each}
        </dl>
      </dd>
    </div>
  {/if}
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
  {#if hdr}
    <div>
      <dt><Sun size={16} aria-hidden="true" /> Video</dt>
      <dd>
        <span class="chip" data-testid="stats-hdr" data-format={hdr}>{HDR_LABELS[hdr]}</span>
        {#if toneMapped}
          <span class="bytes" data-testid="stats-hdr-tone-mapped">· shown as SDR</span>
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
  .stats > .relay {
    align-items: flex-start;
  }
  .relay dl {
    display: grid;
    gap: var(--space-1);
    margin: 0;
  }
  .relay dl div {
    display: flex;
    gap: var(--space-2);
  }
  .relay dl dt {
    width: auto;
    min-width: 5.5rem;
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
  .chip {
    padding: 0 var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
    line-height: var(--leading-normal);
    letter-spacing: 0.04em;
  }
</style>
