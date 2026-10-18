<script lang="ts">
  import { shareUrl } from '../url-hash';

  let { magnet, fileIndex }: { magnet: string; fileIndex: number | null } = $props();

  /** `failed`: no clipboard access, so the link is shown selected for a manual copy. */
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const url = $derived(shareUrl(location, magnet, fileIndex));

  async function copy() {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(url);
      copyState = 'copied';
      timer = setTimeout(() => (copyState = 'idle'), 2000);
    } catch {
      copyState = 'failed';
    }
  }

  $effect(() => () => clearTimeout(timer));
</script>

<span class="share">
  <button type="button" data-testid="share-link" data-state={copyState} onclick={copy}>
    {copyState === 'copied' ? 'Link copied' : 'Copy share link'}
  </button>
  {#if copyState === 'failed'}
    <input
      type="text"
      readonly
      value={url}
      data-testid="share-url"
      aria-label="Share link (copy it from here)"
      onfocus={(e) => e.currentTarget.select()}
      {@attach (el) => el.select()}
    />
  {/if}
</span>

<style>
  .share {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    max-width: 100%;
  }
  input {
    min-width: 0;
    width: 20rem;
    max-width: 100%;
  }
</style>
