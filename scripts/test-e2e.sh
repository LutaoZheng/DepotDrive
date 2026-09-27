#!/usr/bin/env bash
set -euo pipefail
export JWT_SECRET="e2e-jwt-secret-at-least-32-characters"
export STORAGE_INTERNAL_TOKEN="e2e-storage-token-at-least-32-characters"
compose=(docker compose -p depot-drive-e2e -f docker-compose.yml -f docker-compose.demo.yml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT
"${compose[@]}" up -d --build --wait
E2E_COMPOSE_PROJECT=depot-drive-e2e npx playwright test
