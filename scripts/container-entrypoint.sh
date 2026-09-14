#!/bin/sh
set -eu

node /app/operations/container-migrate.cjs

case "${SKIP_KNOWLEDGE_INGESTION:-false}" in
  false)
    node /app/operations/ingest.cjs
    ;;
  true)
    printf '%s\n' '{"event":"knowledge_ingestion_skipped"}'
    ;;
  *)
    printf '%s\n' '{"event":"container_configuration_invalid","message":"SKIP_KNOWLEDGE_INGESTION must be true or false."}' >&2
    exit 1
    ;;
esac

exec node /app/server.js
