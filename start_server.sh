#!/bin/bash
# 設定は環境変数から継承（TOKEN は親プロセスから渡される）
export PROJECT_NAME="mcp-servers"
/usr/bin/node /home/irom/mcp-servers/discord-server/build/index.js --project-name="mcp-servers"
