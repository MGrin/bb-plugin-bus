// Validation of a proposed message against the kind table, and the one line the
// recipient sees. NOTHING here restates the table — every rule is read out of `KINDS`,
// so a kind whose row changes changes its refusals in the same edit.
import { KINDS, KIND_NAMES, isKind, schemaLine, type Kind, type WakeMode } from "./kinds.ts";
import { validateRef, validateResource } from "./refs.ts";

/**
 * 600, from the schema, with NO override token.
 *
 * The cap it replaces — cc-guard's `outward-message-cap`, 2000 for the bus — was
 * overridden 3,603 times against 96 refusals, 97%, because it was a hook a caller could
 * talk past. This one is the schema: there is no spelling of a 601-character body that
 * this plugin accepts. That is the entire reason the guard rule is deleted rather than
 * retuned, and it is why adding an override here would undo the exchange.
 */
export const BODY_CAP = 600;

export interface Draft {
  kind: string;
  to: string;
  ref: string | null;
  fields: Record<string, string>;
  body: string | null;
  ackOf: number | null;
}

export interface Envelope {
  kind: Kind;
  to: string;
  ref: string | null;
  fields: Record<string, string>;
  body: string | null;
  ackOf: number | null;
  ackRequired: boolean;
  wake: WakeMode;
}

export type Validated =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

/**
 * Order matters and is pinned by the tests: kind, then ref, then ack_of, then required
 * fields, then unknown fields, then enums, then the body cap. A refusal that complains
 * about a missing field on a kind that does not exist sends the caller to the wrong
 * place, and they retry into the same hole.
 */
export function validate(d: Draft): Validated {
  const no = (error: string): Validated => ({ ok: false, error });

  if (!isKind(d.kind)) {
    return no(
      `bus: '${d.kind}' is not a kind. The twelve are: ${KIND_NAMES.join(" ")}\n` +
      `  adding one is a plugin PR with a row in src/kinds.ts and a test, never a convention.`,
    );
  }
  const kind: Kind = d.kind;
  const spec: KindSpecLike = KINDS[kind];
  const wants = new Set<string>(spec.fields);

  // `ref` and `ack_of` are COLUMNS, not JSON fields, so they are checked here rather
  // than in the field loop — but the table is still what says whether this kind has one.
  if (wants.has("ref")) {
    if (!d.ref) return no(`bus: ${kind} needs --ref.\n  schema: ${schemaLine(kind)}`);
    const bad = validateRef(d.ref);
    if (bad) return no(bad);
    if (spec.refPrefix && !d.ref.startsWith(spec.refPrefix)) {
      return no(`bus: a ${kind} ref must be a '${spec.refPrefix}' — got '${d.ref}'`);
    }
  }
  if (wants.has("ack_of") && (d.ackOf === null || !Number.isInteger(d.ackOf))) {
    return no(`bus: ${kind} needs --ack-of <seq>.\n  schema: ${schemaLine(kind)}`);
  }

  for (const f of spec.fields) {
    if (f === "ref" || f === "ack_of") continue;
    const v = d.fields[f];
    if (v === undefined || v === "") {
      return no(`bus: ${kind} is missing --field ${f}=…\n  schema: ${schemaLine(kind)}`);
    }
    const e = spec.enums?.[f];
    if (e && !e.includes(v)) {
      return no(`bus: ${kind}.${f} must be one of ${e.join("|")} — got '${v}'`);
    }
  }
  // AN UNKNOWN FIELD IS A REFUSAL, not a passthrough. A typo'd key on an otherwise
  // valid envelope carries nothing and reads as a complete message at the far end —
  // which is the `--message`-welded-to-the-body failure this design replaces, and that
  // one was more durable than a misroute precisely because it worked.
  for (const f of Object.keys(d.fields)) {
    if (!wants.has(f)) {
      return no(`bus: ${kind} has no field '${f}'.\n  schema: ${schemaLine(kind)}`);
    }
  }
  if (wants.has("resource")) {
    const bad = validateResource(d.fields.resource!);
    if (bad) return no(bad);
  }
  if (d.body !== null && d.body.length > BODY_CAP) {
    return no(
      `bus: that body is ${d.body.length} characters and the cap is ${BODY_CAP}, ` +
      `enforced by the schema. There is no override.\n` +
      `  Put the facts in --field k=v; the body is for the one thing that is not a field.`,
    );
  }
  return {
    ok: true,
    envelope: {
      kind, to: d.to, ref: d.ref, fields: d.fields, body: d.body,
      ackOf: d.ackOf, ackRequired: spec.ack, wake: spec.wake,
    },
  };
}

/** Structural view of a table row — `KINDS[k]` narrows to a literal type per key. */
interface KindSpecLike {
  readonly fields: readonly string[];
  readonly ack: boolean;
  readonly wake: WakeMode;
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  readonly refPrefix?: string;
}

/**
 * What a recipient sees: ONE line of envelope, then the body if there is one.
 *
 * No `(Reply: …)` footer. The old one restated the reply verb on every single message
 * — 22,532 copies of a sentence that belongs in the skill, and it went stale the day
 * the verb changed. The skill is one page and it is loaded already.
 */
export function renderEnvelope(m: {
  seq: number;
  kind: string;
  from_thread: string;
  ref: string | null;
  fields: string;
  body: string | null;
}): string {
  let parsed: Record<string, string> = {};
  try {
    const j: unknown = JSON.parse(m.fields);
    if (j && typeof j === "object") parsed = j as Record<string, string>;
  } catch {
    parsed = {};
  }
  const bits: string[] = [];
  if (m.ref) bits.push(`ref=${m.ref}`);
  for (const [k, v] of Object.entries(parsed)) {
    bits.push(/\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`);
  }
  const head = `[bus #${m.seq} ${m.kind} from ${m.from_thread}]` +
    (bits.length ? ` ${bits.join(" ")}` : "");
  return m.body ? `${head}\n${m.body}` : head;
}
