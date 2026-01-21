#!/bin/bash
echo "$(date): Discord MCP starter called" >> /home/irom/discord_start_log.txt
env >> /home/irom/discord_start_log.txt
exec /usr/local/bin/node /home/irom/mcp-servers/discord-server/build/index.js "$@"
