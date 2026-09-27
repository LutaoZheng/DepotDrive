#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose -p depot-drive-test -f docker-compose.test.yml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT

"${compose[@]}" up -d --build --wait
export TEST_DATABASE_URL="postgresql://depot_test:depot_test@127.0.0.1:55432/depot_drive_test"
export DATABASE_URL="$TEST_DATABASE_URL"
export STORAGE_NODE_ENDPOINTS="node-a|Storage Node A|http://127.0.0.1:4101,node-b|Storage Node B|http://127.0.0.1:4102"
export STORAGE_INTERNAL_TOKEN="integration-test-storage-token-at-least-32-characters"
export STORAGE_REQUEST_TIMEOUT_MS="1000"
export RUN_DOCKER_FAULT_TESTS="true"

npm run prisma:deploy -w @depot-drive/api
npm run test:unit
npm run test:integration -w @depot-drive/api
npm run test:e2e
