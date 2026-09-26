// WHICH FILE A `path:` CLAIM NAMES (MX-977).
//
// A claim key used to be the string as typed, so `path:README.md` held in browser-cluster
// refused a passive-income lane editing ITS README.md (2026-09-11, rc 75, until the other
// lane let go), while `path:setup/lib/x.py` and `path:/Users/…/setup/lib/x.py` — the same
// file — were two free resources. Both failures are one defect: the key named a spelling,
// not a file.
//
// The key is now `path:<main repo root>/<path relative to the repo>`. A relative path is
// read against the repo the CALLER stands in (`PluginCliContext.cwd`), never the server's.
// Every git worktree of one repo maps to the MAIN checkout's root — two worktrees editing
// the same file is exactly the collision a claim exists for. Outside any repo a relative
// path names nothing stable, so it is REFUSED rather than keyed on the caller's cwd, which
// would split one resource into as many keys as there are directories to stand in.
//
// Pure over an injected filesystem, so the tests build repos in memory.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { prKey } from "./refs.ts";

export interface Fs {
  exists(p: string): boolean;
  isFile(p: string): boolean;
  read(p: string): string;
  home: string;
}

export const realFs: Fs = {
  exists: existsSync,
  isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  read: (p) => readFileSync(p, "utf8"),
  home: homedir(),
};

/** The worktree root holding `p` (the nearest ancestor with a `.git`), or null. */
function worktreeRoot(p: string, fs: Fs): string | null {
  for (let d = p; ; d = dirname(d)) {
    if (fs.exists(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * The MAIN checkout a worktree belongs to. A linked worktree's `.git` is a FILE naming
 * `<main>/.git/worktrees/<name>`, whose `commondir` points back at `<main>/.git`. Anything
 * unreadable here falls back to the worktree itself: a key that is too narrow still
 * refuses the other worktrees' SAME spelling, and never merges two different repos.
 */
function mainRoot(wt: string, fs: Fs): string {
  const dotgit = join(wt, ".git");
  if (!fs.isFile(dotgit)) return wt;
  const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.read(dotgit));
  if (!m) return wt;
  const gitdir = resolve(wt, m[1]!.trim());
  const cd = join(gitdir, "commondir");
  const common = fs.exists(cd) ? resolve(gitdir, fs.read(cd).trim()) : null;
  return common && common.endsWith(`${sep}.git`) ? dirname(common) : wt;
}

/** `resource` as the claim key. Non-`path:` resources are returned unchanged. */
export function claimKey(resource: string, cwd: string | null, fs: Fs = realFs):
    { key: string } | { error: string } {
  if (resource.startsWith("pr:")) return { key: prKey(resource) };
  if (!resource.startsWith("path:")) return { key: resource };
  let raw = resource.slice("path:".length);
  if (raw === "~" || raw.startsWith("~/")) raw = fs.home + raw.slice(1);

  let abs: string;
  if (isAbsolute(raw)) {
    abs = normalize(raw);
  } else {
    const here = cwd ? worktreeRoot(resolve(cwd), fs) : null;
    if (!here) {
      return { error:
        `bus: '${resource}' is relative, and ${cwd ? `${cwd} is in no git repo` : "there is no cwd"} — ` +
        `a relative path: claim names a file only inside a repo (MX-977). Run it from the repo, ` +
        `or claim the absolute path.` };
    }
    abs = resolve(here, raw);
    // THE DOUBLED REPO NAME (MX-1203). `path:dotfiles/setup/phases`, the spelling several
    // briefs use for the deploy lock, is read from the repo root and resolves to
    // `<repo>/dotfiles/setup/phases` — a directory that does not exist, and a DIFFERENT key
    // from the `path:setup/phases` another thread claims for the same lock. Two correct-
    // looking spellings of one lock that do not arbitrate is the failure a claim exists to
    // prevent, and it is silent: both are admitted. Refused only when the first segment
    // repeats the repo's own directory name AND the path is not there, so a repo that really
    // holds a `dotfiles/` directory (this machine's does) keeps working.
    const first = normalize(raw).split(sep)[0];
    if (first === basename(here) && !fs.exists(abs)) {
      const fixed = normalize(raw).split(sep).slice(1).join("/");
      return { error:
        `bus: '${resource}' starts with the repo's own name and ${abs} does not exist — a ` +
        `relative path: claim is read from the repo root, so this is not the file you mean ` +
        `and it is a different key from the one another thread claims (MX-1203). ` +
        (fixed ? `Claim 'path:${fixed}' instead.` : `Claim the path inside the repo instead.`) };
    }
  }
  if (abs.length > 1 && abs.endsWith(sep)) abs = abs.slice(0, -1);

  const wt = worktreeRoot(abs, fs);
  if (!wt) return { key: `path:${abs}` };
  const rel = relative(wt, abs);
  return { key: `path:${rel ? join(mainRoot(wt, fs), rel) : mainRoot(wt, fs)}` };
}
