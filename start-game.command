#!/bin/zsh
set -e
cd -- "$(dirname "$0")"
npm run build
node server.mjs

