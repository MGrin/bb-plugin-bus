#!/usr/bin/env bash
# Join this bb server to a shared bus space, in one command: install bb-plugin-bus (or update
# it if it is already installed), set its three settings, reload it, and check the relay.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/MGrin/bb-plugin-bus/main/scripts/install-shared.sh) \
#     --server <this server's name> --relay <relay URL>
#
# It asks for the token without echoing it. --token-file <path> reads it from a file instead.
# The token is never printed and never written anywhere but bb's own secret setting.
set -euo pipefail

MIN_BB=0.46.0   # = package.json engines.bb; src/install-script.test.ts keeps the two equal
SOURCE=git:https://github.com/MGrin/bb-plugin-bus.git@main
PLUGIN=bus

die() { echo "install-shared: $*" >&2; exit 1; }
usage() { die "usage: install-shared.sh --server <name> --relay <url> [--token-file <path>]"; }

server="" relay="" token_file=""
while [ $# -gt 0 ]; do
  case $1 in
    --server) server=${2:-}; shift 2 || usage ;;
    --relay) relay=${2:-}; shift 2 || usage ;;
    --token-file) token_file=${2:-}; shift 2 || usage ;;
    *) usage ;;
  esac
done
[ -n "$server" ] && [ -n "$relay" ] || usage
[[ $server =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "'$server' is not a server name (lower-case letters, digits, dashes)"
[[ $relay =~ ^https?:// ]] || die "'$relay' is not a URL"

command -v bb >/dev/null || die "bb is not on PATH. Install bb first: https://getbb.app"
have=$(bb --version 2>/dev/null | head -1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' || true)
[ -n "$have" ] || die "could not read the bb version from 'bb --version'"
if [ "$(printf '%s\n%s\n' "$MIN_BB" "$have" | sort -V | head -1)" != "$MIN_BB" ]; then
  die "bb $have is older than $MIN_BB, which this plugin needs. Update bb, then run this command again."
fi

if bb plugin source "$PLUGIN" >/dev/null 2>&1; then
  echo "== updating the $PLUGIN plugin"
  bb plugin update "$PLUGIN" --yes
else
  echo "== installing the $PLUGIN plugin"
  bb plugin install "$SOURCE" --yes
fi

if [ -n "$token_file" ]; then
  token=$(tr -d '[:space:]' < "$token_file")
else
  read -rsp "Token for server '$server' (it is not shown): " token </dev/tty
  echo
fi
[ "${#token}" -ge 32 ] || die "that token is too short (${#token} characters); paste the whole token"

echo "== settings"
bb plugin config "$PLUGIN" set server "$server" >/dev/null
bb plugin config "$PLUGIN" set relayUrl "$relay" >/dev/null
bb plugin config "$PLUGIN" set token "$token" >/dev/null
unset token
bb plugin reload "$PLUGIN" >/dev/null

echo "== the relay, as this server sees it"
if ! bb bus peers; then
  die "installed, but the relay did not answer with this token. Check --relay and the token, then run this again."
fi
echo
echo "Done. A thread joins with: bb bus join --description '<what it does, one line>'"
