// ADDRESSES IN THE SHARED SPACE (MX-1528).
//
// A bare thread id is local, exactly as before the shared space existed: nothing here
// changes what `--to thr_x` means. `thr_x@<server>` names a joined thread on another bb
// server, and `@<this server>` folds back to local, so a thread can copy an address out of
// `bb bus peers` without first checking whose it is.

export type Address =
  | { kind: "local"; thread: string }
  | { kind: "remote"; thread: string; server: string };

export const THREAD_RE = /^thr_[A-Za-z0-9]+$/;
export const SERVER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const showAddress = (thread: string, server: string): string => `${thread}@${server}`;

export function parseAddress(s: string, myServer: string | null): Address | { error: string } {
  const at = s.indexOf("@");
  if (at < 0) return { kind: "local", thread: s };
  const thread = s.slice(0, at);
  const server = s.slice(at + 1);
  if (!THREAD_RE.test(thread) || !SERVER_RE.test(server)) {
    return { error: `bus: '${s}' is not an address — write <thread-id> for this server, or <thread-id>@<server> for a joined thread on another one` };
  }
  if (myServer === null) {
    return { error: `bus: '${s}' is on another server, and the shared space is not configured on this one ` +
      `(bb plugin config bus: server, relayUrl, token)` };
  }
  return server === myServer ? { kind: "local", thread } : { kind: "remote", thread, server };
}
