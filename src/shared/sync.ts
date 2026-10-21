// ONE SYNC WITH THE RELAY (MX-1528): the loop's body, pure over its dependencies.
//
// The bus never polled before this, and its README says why: a listener or a poller is a
// thing that can go deaf in silence. The shared space cannot avoid one — nothing may
// connect INTO a Mac (spec §5), so the Mac must ask. What keeps it honest is that nothing
// here is the only copy of anything: the relay keeps every message, a failed delivery is
// retried on the next tick and shown in `bb bus log` after the last, and an unreachable
// relay is logged rather than swallowed.
import { RelayRefused, type RelayClient } from "./relay.ts";
import type { SharedRow, SharedStore } from "./store.ts";

export const SYNC_INTERVAL_MS = 10_000;
/** History older than this before a store's FIRST sync is stored but never delivered. */
export const BACKFILL_MS = 60 * 60_000;
const PAGE = 500;
const MAX_PAGES = 5;

export async function syncOnce(d: {
  client: RelayClient;
  store: SharedStore;
  myServer: string;
  now: () => Date;
  deliver: (row: SharedRow) => Promise<{ ok: true } | { ok: false; error: string }>;
  warn: (message: string) => void;
}): Promise<{ stored: number; delivered: number; failed: number }> {
  const { client, store } = d;

  // An archived thread leaves the space; the event fired while the relay was away.
  for (const p of store.pendingLeaves()) {
    try {
      await client.leave(p.thread, p.cause);
      store.removePendingLeave(p.thread);
    } catch (e) {
      if (!(e instanceof RelayRefused)) break;
      d.warn(`shared leave for ${p.thread} refused, dropped: ${e.message}`);
      store.removePendingLeave(p.thread);
    }
  }

  let first = store.getMeta("first_sync");
  if (!first) {
    first = d.now().toISOString();
    store.setMeta("first_sync", first);
  }
  const floor = Date.parse(first) - BACKFILL_MS;
  let cursor = Number(store.getMeta("cursor") ?? "0");
  let stored = 0;

  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await client.sync(cursor);
    const known = store.getMeta("relay");
    if (known !== res.relay) {
      store.setMeta("relay", res.relay);
      if (known !== null) {
        // A NEW relay database: its ids start again, so the old cursor would skip them all.
        d.warn(`the relay's database changed (${known} -> ${res.relay}); reading it from the start`);
        cursor = 0;
        store.setMeta("cursor", "0");
        continue;
      }
    }
    for (const m of res.messages) {
      const mine = m.from_server === d.myServer;
      const deliverable = m.to_server === d.myServer && Date.parse(m.created) >= floor;
      if (store.putMessage(m, deliverable, mine ? m.created : null)) stored++;
      cursor = Math.max(cursor, m.id);
    }
    store.setMeta("cursor", String(cursor));
    store.setPeers(res.peers);
    store.setClaims(res.claims);
    store.setMeta("synced_at", d.now().toISOString());
    if (res.messages.length < PAGE) break;
  }

  let delivered = 0;
  let failed = 0;
  for (const row of store.undelivered(d.myServer)) {
    const r = await d.deliver(row);
    if (r.ok) {
      store.markDelivered(row.relay_id, d.now().toISOString());
      delivered++;
    } else {
      store.markFailed(row.relay_id, r.error);
      failed++;
    }
  }
  return { stored, delivered, failed };
}

