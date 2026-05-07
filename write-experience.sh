#!/bin/bash
# write-experience.sh — Unified experience input channel to submarine
# Usage: bash submarine/write-experience.sh <layer> "<text>" "<source>"
# Examples:
#   bash submarine/write-experience.sh cortex "Discovered that proxy changes port on VPN restart" "opus"
#   bash submarine/write-experience.sh core "Lesson: always check proxy port after VPN reconnect" "deepseek" "lesson" 7

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found" >&2
    exit 1
fi

source "$ENV_FILE"

LAYER="${1:-cortex}"
TEXT="${2:-}"
SOURCE="${3:-unknown}"
CATEGORY="${4:-}"
IMPORTANCE="${5:-}"

if [ -z "$TEXT" ]; then
    echo "ERROR: Text is required" >&2
    echo "Usage: write-experience.sh <layer> \"<text>\" \"<source>\" [category] [importance]" >&2
    exit 1
fi

# Build JSON
JSON="{\"layer\":\"$LAYER\",\"text\":\"[$SOURCE] $TEXT\""

if [ -n "$CATEGORY" ]; then
    JSON="$JSON,\"category\":\"$CATEGORY\""
fi

if [ -n "$IMPORTANCE" ]; then
    JSON="$JSON,\"importance\":$IMPORTANCE"
fi

JSON="$JSON}"

RESPONSE=$(curl -s -X POST \
    -H "X-API-Key: $SUBMARINE_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$JSON" \
    "http://localhost:${SUBMARINE_PORT:-3100}/api/v1/memory" 2>&1)

SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','false'))" 2>/dev/null || echo "false")

if [ "$SUCCESS" = "True" ] || [ "$SUCCESS" = "true" ]; then
    ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','?'))" 2>/dev/null)
    echo "✅ [$LAYER] $ID — recorded"
else
    echo "❌ Error: $RESPONSE" >&2
    exit 1
fi
