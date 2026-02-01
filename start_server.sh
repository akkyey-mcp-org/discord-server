#!/bin/bash
# 設定は環境変数から継承（TOKEN は親プロセスから渡される）
export PROJECT_NAME="mcp-servers"
# スクリプトの場所からディレクトリを特定
SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
/usr/bin/node "${SCRIPT_DIR}/build/index.js" --project-name="mcp-servers"
