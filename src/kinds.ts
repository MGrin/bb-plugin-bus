// THE KIND TABLE. Spec §2, and the single source for everything derived from it:
// required fields, ack-requirement, wake mode, the CLI's sugar verbs, the help text
// and every refusal message. There is deliberately no second list of kinds anywhere
// in this plugin — a convention in a skill is not a kind, and adding one is a PR with
// a row here and a test.
//
// The vocabulary is CLOSED because an open one is what the old `text` column was: a
// free field, 22,532 rows, a median of 1,879 characters of English, and no way to ask
// "what is blocked" without a regex. A `report` with ref=task:MX-838 status=blocked
// replaces 1,900 characters of prose because the fields are the message.

export type Kind =
  | "claim" | "release" | "handoff" | "help" | "merge-ready" | "question"
  | "report" | "done" | "decision" | "finding" | "ack" | "note";

/**
 * How a message reaches its recipient.
 *
 * `immediate` steers a live turn — it interrupts. `queue` waits for the current turn
 * to end. The distinction costs the recipient real work, so it belongs in the table
 * beside the kind rather than in a flag a sender picks per message.
 */
export type WakeMode = "immediate" | "queue";

export interface KindSpec {
  /** Required fields, in the order a refusal should list them. */
  readonly fields: readonly string[];
  /** Does an unanswered row of this kind show up in `bb bus unanswered`? */
  readonly ack: boolean;
  readonly wake: WakeMode;
  /** Fields whose value is drawn from a closed set. */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  /** When set, this kind's `ref` must carry this prefix. */
  readonly refPrefix?: string;
}

export const KINDS = {
  claim:         { fields: ["resource", "ttl", "reason"], ack: false, wake: "immediate" },
  release:       { fields: ["resource"],                  ack: false, wake: "queue" },
  handoff:       { fields: ["ref", "done", "next"],       ack: true,  wake: "immediate" },
  help:          { fields: ["ref", "blocked_on"],         ack: true,  wake: "immediate" },
  "merge-ready": { fields: ["ref", "gate"],               ack: true,  wake: "immediate",
                   refPrefix: "pr:" },
  question:      { fields: ["ref", "ask"],                ack: true,  wake: "immediate" },
  report:        { fields: ["ref", "status", "next"],     ack: false, wake: "queue",
                   enums: { status: ["working", "blocked", "done"] } },
  done:          { fields: ["ref", "evidence"],           ack: false, wake: "queue" },
  decision:      { fields: ["ref", "ruling", "by"],       ack: false, wake: "queue" },
  finding:       { fields: ["ref", "what", "filed"],      ack: false, wake: "queue" },
  ack:           { fields: ["ack_of", "answer"],          ack: false, wake: "queue" },
  note:          { fields: [],                            ack: false, wake: "queue" },
} as const satisfies Record<Kind, KindSpec>;

/** The twelve, in the spec's table order — the order every listing prints. */
export const KIND_NAMES = Object.keys(KINDS) as readonly Kind[];

export function isKind(s: string): s is Kind {
  // `hasOwnProperty` and not `s in KINDS`: `in` walks the prototype chain, so
  // "constructor" and "toString" would both answer true and become kinds.
  return Object.prototype.hasOwnProperty.call(KINDS, s);
}

/**
 * The one line a refusal quotes. DERIVED, never written twice: a kind whose fields
 * change here changes its refusal message in the same edit, which is the property the
 * old plugin did not have — its help text, its usage strings and its parser each
 * carried their own copy of the argument list and the three drifted.
 */
export function schemaLine(k: Kind): string {
  const spec: KindSpec = KINDS[k];
  if (spec.fields.length === 0) return `${k}: no fields (body only)`;
  const parts = spec.fields.map((f) => {
    const e = spec.enums?.[f];
    return e ? `${f} (${e.join("|")})` : f;
  });
  return `${k}: ${parts.join(", ")}`;
}
