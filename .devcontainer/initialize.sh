#!/usr/bin/env bash
#
# Runs on the HOST, before the containers are created.
#
# docker-compose.yml declares `SESSION_SECRET: ${SESSION_SECRET:?...}`, and
# compose interpolates the whole file when it loads it — including services it
# has not been asked to start. Without a .env the devcontainer therefore fails
# to come up at all, with an error about a variable rather than about setup.
# Creating the file here is the only place early enough to prevent that.
#
# An existing .env is never touched: it is the contributor's, and it may hold
# real keys.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f .env ]; then
  echo "devcontainer: .env already exists, leaving it alone"
  exit 0
fi

cp .env.example .env
echo "devcontainer: created .env from .env.example"
