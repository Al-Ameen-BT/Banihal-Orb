#!/usr/bin/env bash
# Swap the three DB URLs in server/.env for their *_test twins and run vitest.
set -euo pipefail
SRV="$(cd "$(dirname "$0")" && pwd)"
ENV="$SRV/.env"

val() { grep -E "^$1=" "$ENV" | tail -1 | cut -d= -f2- | sed -E 's/^"//; s/"$//'; }
swap() { echo "$1" | sed -E "s#/b2b[a-z_]*(\?|$)#/b2b_test$2#"; }

MAIN="${DATABASE_URL:-$(val DATABASE_URL)}"
TICKET="${TICKET_DATABASE_URL:-$(val TICKET_DATABASE_URL)}"
ADMIN="${ADMIN_TICKETING_DATABASE_URL:-$(val ADMIN_TICKETING_DATABASE_URL)}"

case "$MAIN" in *b2b_test*) ;; *) MAIN="$(echo "$MAIN" | sed -E 's#/b2b(\?|$)#/b2b_test\1#')" ;; esac
case "$TICKET" in *b2b_ticket_test*) ;; *) TICKET="$(echo "$TICKET" | sed -E 's#/b2b_ticket(\?|$)#/b2b_ticket_test\1#')" ;; esac
case "$ADMIN" in *b2b_ticketing_admin_test*) ;; *) ADMIN="$(echo "$ADMIN" | sed -E 's#/b2b_ticketing_admin(\?|$)#/b2b_ticketing_admin_test\1#')" ;; esac

export DATABASE_URL="$MAIN"
export TICKET_DATABASE_URL="$TICKET"
export ADMIN_TICKETING_DATABASE_URL="$ADMIN"

echo "→ main=$MAIN"
echo "→ ticket=$TICKET"
echo "→ admin=$ADMIN"
exec npx vitest run "$@"