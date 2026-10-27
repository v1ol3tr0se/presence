#!/usr/bin/env bash
set -euo pipefail

HOST="${DEPLOY_HOST:-vps}"
REMOTE_DIR="${DEPLOY_DIR:-discord-online}"
UNIT="discord-online.service"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "==> Building and testing"
yarn test

echo "==> Syncing to $HOST:~/$REMOTE_DIR"
rsync -az --delete \
	--exclude ".git" \
	--exclude "node_modules" \
	--exclude ".env" \
	dist src deploy package.json tsconfig.json .env.example README.md \
	"$HOST:$REMOTE_DIR/"

rsync -az --delete --relative node_modules/ws "$HOST:$REMOTE_DIR/"

echo "==> Installing the unit"
ssh "$HOST" "
	set -e
	mkdir -p ~/.config/systemd/user
	sed 's|^WorkingDirectory=.*|WorkingDirectory=%h/$REMOTE_DIR|' ~/$REMOTE_DIR/deploy/$UNIT > ~/.config/systemd/user/$UNIT
	chmod 644 ~/.config/systemd/user/$UNIT
	systemctl --user daemon-reload
	systemctl --user enable $UNIT
	if [ -s ~/$REMOTE_DIR/.env ]; then
		systemctl --user restart $UNIT
		echo '==> Restarted'
	else
		echo '==> ~/$REMOTE_DIR/.env is missing or empty; not starting.'
	fi
"

echo "==> Done"
