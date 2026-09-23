import { match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { claimKey, type Fs } from "./paths.ts";

// An in-memory machine: two unrelated repos, a linked worktree of the first, and a
// directory that is in no repo. `.git` is a DIRECTORY in a main checkout and a FILE in a
// linked worktree — the shape `git worktree add` writes.
const files: Record<string, string> = {
  "/h/dev/dotfiles/.git/worktrees/wt1/commondir": "../..\n",
  "/h/wt/thr_x/dotfiles/.git": "gitdir: /h/dev/dotfiles/.git/worktrees/wt1\n",
};
const dirs = new Set(["/h/dev/dotfiles/.git", "/h/dev/browser-cluster/.git",
  "/h/dev/dotfiles/.git/worktrees/wt1"]);
const fs: Fs = {
  exists: (p) => dirs.has(p) || p in files,
  isFile: (p) => p in files,
  read: (p) => { const v = files[p]; if (v === undefined) throw new Error(`ENOENT ${p}`); return v; },
  home: "/h",
};
const key = (r: string, cwd: string | null) => {
  const k = claimKey(r, cwd, fs);
  ok("key" in k, `expected a key for ${r} from ${cwd}: ${JSON.stringify(k)}`);
  return k.key;
};

test("MX-977: the same basename in two repos is two resources", () => {
  const a = key("path:README.md", "/h/dev/dotfiles/setup");
  const b = key("path:README.md", "/h/dev/browser-cluster");
  strictEqual(a, "path:/h/dev/dotfiles/README.md");
  strictEqual(b, "path:/h/dev/browser-cluster/README.md");
  notStrictEqual(a, b);
});

test("a relative path is read against the REPO ROOT, from anywhere inside it", () => {
  strictEqual(key("path:setup/lib/x.py", "/h/dev/dotfiles"),
              key("path:setup/lib/x.py", "/h/dev/dotfiles/rust/mx/src"));
});

test("every spelling of one file is one key", () => {
  const want = "path:/h/dev/dotfiles/setup/phases";
  for (const s of ["path:setup/phases", "path:./setup/phases/", "path:setup//phases",
                   "path:/h/dev/dotfiles/setup/phases", "path:~/dev/dotfiles/setup/phases",
                   "path:/h/dev/dotfiles/rust/../setup/phases"]) {
    strictEqual(key(s, "/h/dev/dotfiles"), want, s);
  }
});

test("a linked worktree maps to its MAIN checkout, so two worktrees collide", () => {
  strictEqual(key("path:setup/phases", "/h/wt/thr_x/dotfiles"), "path:/h/dev/dotfiles/setup/phases");
  strictEqual(key("path:/h/wt/thr_x/dotfiles/setup/phases", "/tmp"), "path:/h/dev/dotfiles/setup/phases");
});

test("a relative path outside any repo is refused, never keyed on the cwd", () => {
  const k = claimKey("path:setup/phases", "/h/thread-storage/thr_x", fs);
  ok("error" in k);
  match(k.error, /in no git repo/);
  match(k.error, /MX-977/);
  const none = claimKey("path:setup/phases", null, fs);
  ok("error" in none);
});

test("an absolute path outside any repo is its own key", () => {
  strictEqual(key("path:/h/thread-storage/x/", null), "path:/h/thread-storage/x");
});

test("a resource that is not a path is untouched", () => {
  for (const r of ["pr:685", "task:MX-977", "branch:main", "store:memory", "thread:thr_a"]) {
    strictEqual(key(r, null), r);
  }
});

// MX-1203: the doubled repo name. `path:dotfiles/setup/phases` from a dotfiles checkout is
// read from the repo root, so it names `<repo>/dotfiles/setup/phases` — not the lock the
// thread claiming `path:setup/phases` holds. Both were admitted, and neither arbitrated.
test("MX-1203: a relative claim starting with the repo's own name is refused", () => {
  const r = claimKey("path:dotfiles/setup/phases", "/h/dev/dotfiles/rust", fs);
  ok("error" in r, `expected a refusal: ${JSON.stringify(r)}`);
  match(r.error, /starts with the repo's own name/);
  match(r.error, /Claim 'path:setup\/phases' instead/);
});

test("MX-1203: the falsifier — the two spellings would have been different keys", () => {
  // The corrected spelling still keys the lock every thread means.
  strictEqual(key("path:setup/phases", "/h/dev/dotfiles/rust"), "path:/h/dev/dotfiles/setup/phases");
  // And the doubled one never reaches a key at all.
  ok("error" in claimKey("path:dotfiles/setup/phases", "/h/dev/dotfiles", fs));
});

test("MX-1203: a repo that really holds that directory is untouched", () => {
  // This machine's dotfiles repo has a real `dotfiles/` inside it: existing paths still key.
  const withDir: Fs = { ...fs, exists: (p) => fs.exists(p) || p === "/h/dev/dotfiles/dotfiles/.claude" };
  const r = claimKey("path:dotfiles/.claude", "/h/dev/dotfiles", withDir);
  ok("key" in r, `expected a key: ${JSON.stringify(r)}`);
  strictEqual(r.key, "path:/h/dev/dotfiles/dotfiles/.claude");
});

test("MX-1203: an absolute claim naming the same doubled path is untouched", () => {
  // Only the RELATIVE reading is ambiguous; an absolute path says what it says.
  strictEqual(key("path:/h/dev/dotfiles/dotfiles/setup/phases", "/h/dev/dotfiles"),
              "path:/h/dev/dotfiles/dotfiles/setup/phases");
});
