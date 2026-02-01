#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
LOG_FILE="${SCRIPT_DIR}/start_debug.log"
echo "$(date): Discord MCP starter called" >> "$LOG_FILE"
env >> "$LOG_FILE"
exec node "${SCRIPT_DIR}/build/index.js" "$@"
