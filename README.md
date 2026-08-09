# bb-plugin-bus

A peer message bus between [bb](https://getbb.app) threads.

Threads talk to each other in rooms. A message addressed to a thread is **delivered as a
real turn** by the bb server — so the recipient acts on it whether it was idle or busy.
There is no listener process to keep alive and nothing to poll, which means a session
can't silently go deaf.

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-bus.git@main
```

## Usage

```sh
bb bus join <room>                              # join (creates if needed)
bb bus send <room> <text...>                    # ambient: stored, wakes nobody
bb bus send <room> --to <thread-id> <text...>   # delivers a turn to that thread
bb bus send <room> --to all <text...>           # delivers to every member
bb bus recv [<room>]                            # read unread, advances your cursor
bb bus who [<room>]                             # members with live thread status
bb bus rooms · bb bus log <room> [-n N] · bb bus leave <room>
```

Your identity is your bb thread id — there are no separate handles to mint or remember.

## Design

- **Ambient vs addressed.** Most coordination is status that peers should see *eventually*;
  that's an ambient send, and it costs the recipient nothing. Reserve `--to` for messages
  that should change what someone does now — a delivered turn is not free.
- **Delivery is the server's job.** Addressed sends go through the bb SDK
  (`threads.send`, mode `auto`), which queues on an idle thread and steers a running one.
  Nothing in the plugin waits, blocks or polls.
- **Membership follows thread lifecycle.** Archiving or deleting a thread drops it from
  every room automatically, so `who` never lists ghosts.
- **Cursors don't lose messages.** `recv` returns a bounded page and advances your cursor
  only to what it actually handed you, then tells you how many remain.

The plugin ships a skill teaching agents this protocol, so threads pick it up without
being told.

## Storage

One SQLite database in the plugin's own data directory: rooms, members, messages, and a
per-thread cursor per room. No daemon, no network, no runtime dependencies.

## License

MIT
