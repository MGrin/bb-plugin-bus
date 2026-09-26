// The two prefixed vocabularies. They are DIFFERENT on purpose: a `ref` points at the
// thing a message is ABOUT, a `resource` names something a claim can hold exclusively.
// `branch:` is claimable and is not a subject; `thread:` is a subject and is claimed
// under its own `thread:` resource by cc-guard's rule, which validates it there.
//
// Both are validated because the old bus validated neither, and an unvalidated address
// is how message #4828 reached a thread that had never joined anything and reported
// `woke 1/1`. A prefix that names nothing is the same failure one level down.

export const REF_PREFIXES = ["task:", "pr:", "path:", "thread:", "store:"] as const;
// `thread:` is HERE because a thread delete is one of the four acts the claim protocol
// covers, and it was omitted while the comment three lines up already said it was claimed
// "under its own `thread:` resource". The code and its own comment disagreed, and the way
// that surfaced is the shape worth remembering: the live suite's teardown claims
// `thread:<id>` before deleting, ignores the rc, and deleted anyway — so the claim had
// been refused on every run since the rework and nothing was worse for it. It becomes
// load-bearing the moment cc-guard's `bus_claim_required` lands (MX-812), which REFUSES a
// thread delete without a claim: an unclaimable resource would make that verb unusable.
export const RESOURCE_PREFIXES =
  ["pr:", "task:", "branch:", "path:", "store:", "thread:"] as const;

const STORES = ["memory", "tasks", "bus"] as const;

// A PR IN ANOTHER REPO (MX-1312). A bare `pr:<n>` carries no repo, so it could only ever
// mean dotfiles, and a plugin repo's PR could not be claimed before its merge at all
// (`pr:bb-plugin-bus-27` was refused, and the merge went ahead unclaimed).
const REPO_PR = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;

// The repo a bare `pr:<n>` has always meant, so both spellings of one dotfiles PR are ONE
// key: two threads merging the same PR under different spellings must collide.
const BARE_PR_REPO = "mgrin/dotfiles";

/** The claim key of a `pr:` resource: `owner/repo` lower-cased (GitHub compares it
 *  case-insensitively), and a dotfiles PR in its bare `pr:<n>` form. */
export function prKey(resource: string): string {
  const m = REPO_PR.exec(resource.slice("pr:".length));
  if (!m) return resource;
  const repo = m[1].toLowerCase();
  return repo === BARE_PR_REPO ? `pr:${m[2]}` : `pr:${repo}#${m[2]}`;
}

function check(value: string, prefixes: readonly string[], what: string): string | null {
  const prefix = prefixes.find((p) => value.startsWith(p));
  if (!prefix) {
    return `bus: '${value}' is not a ${what} — it must start with one of ${prefixes.join(" ")}`;
  }
  const rest = value.slice(prefix.length);
  if (!rest) return `bus: '${value}' has an empty ${what} after '${prefix}' — it names nothing`;
  // `pr:main` is the shape that addresses the wrong thing while looking right.
  if (prefix === "pr:" && !/^\d+$/.test(rest) && !REPO_PR.test(rest)) {
    return `bus: '${value}' — a pr: ${what} is a number (a MGrin/dotfiles PR) or ` +
      `<owner>/<repo>#<n>, got '${rest}'`;
  }
  if (prefix === "store:" && !(STORES as readonly string[]).includes(rest)) {
    return `bus: '${value}' — store: must be one of ${STORES.join("|")}`;
  }
  return null;
}

export const validateRef = (s: string): string | null => check(s, REF_PREFIXES, "ref");
export const validateResource = (s: string): string | null =>
  check(s, RESOURCE_PREFIXES, "resource");
