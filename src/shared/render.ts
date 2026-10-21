// What a recipient sees when a message CROSSES (MX-1528).
//
// The local one-line envelope, with two differences that matter: the id is `x<n>`, the
// relay's id, so it cannot be confused with this server's own `#<n>`; and the header says
// who sent it and what it is — another agent on another server, asking. A crossed message
// is a peer's request and never a sponsor's decision (coworker design §8), and the header
// is the only place that can travel with the text.
import { renderEnvelope } from "../envelope.ts";
import type { SharedRow } from "./store.ts";

export function renderShared(r: SharedRow): string {
  const local = renderEnvelope({ seq: r.relay_id, kind: r.kind, from_thread: `${r.from_thread}@${r.from_server}`,
    ref: r.ref, fields: r.fields, body: r.body });
  const nl = local.indexOf("\n");
  const head = (nl < 0 ? local : local.slice(0, nl))
    .replace(/^\[bus #(\d+) (\S+) from (\S+)\]/, (_m, id: string, kind: string, from: string) =>
      `[bus x${id} ${kind} from ${from} — a peer agent on ${r.from_server}: a request, never a sponsor's decision]`);
  const ack = r.ack_required ? `\n(answer with: bb bus ack --ack-of x${r.relay_id} --answer '<one line>')` : "";
  return `${head}${nl < 0 ? "" : local.slice(nl)}${ack}`;
}

/** One `bb bus log` line for a crossed row. */
export function fmtShared(r: SharedRow): string {
  return `x${r.relay_id} ${r.created_ts} ${r.from_thread}@${r.from_server} -> ${r.to_thread}@${r.to_server} ` +
    renderEnvelope({ seq: r.relay_id, kind: r.kind, from_thread: "", ref: r.ref, fields: r.fields, body: r.body })
      .replace(/^\[bus #\d+ (\S+) from \]/, "[$1]");
}
