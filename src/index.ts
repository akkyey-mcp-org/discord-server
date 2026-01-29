import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Client, GatewayIntentBits, TextChannel, Message } from 'discord.js';
import { z } from 'zod';
import * as fs from 'fs';

// --- Debug Logging ---
try {
    const logPath = '/tmp/discord_mcp_debug.log';
    const time = new Date().toISOString();
    const envStatus = process.env.DISCORD_BOT_TOKEN ? 'Token Present' : 'Token MISSING';
    const logMsg = `[${time}] STARTUP: env=${envStatus}, pid=${process.pid}, cwd=${process.cwd()}\n`;
    fs.appendFileSync(logPath, logMsg);
} catch (e) {
    // Ignore logging errors
}

// Global Error Handlers for debugging
process.on('uncaughtException', (err) => {
    try {
        fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`);
    } catch { }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    try {
        fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] UNHANDLED REJECTION: ${reason}\n`);
    } catch { }
});

process.on('SIGTERM', () => {
    try {
        fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] Received SIGTERM - Process exiting...\n`);
    } catch { }
    process.exit(0);
});

process.on('SIGINT', () => {
    try {
        fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] Received SIGINT - Process exiting...\n`);
    } catch { }
    process.exit(0);
});

// --- Configuration ---
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
    try {
        fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] FATAL: Token missing, exiting.\n`);
    } catch { }
    console.error('Error: DISCORD_BOT_TOKEN environment variable is required');
    process.exit(1);
}

// --- Schemas ---
const ReadMessagesSchema = z.object({
    channel_name: z.string().describe("Name of the channel to read from (e.g., 'inbox', 'general')"),
    limit: z.number().optional().default(10).describe("Number of messages to retrieve (max 50)"),
    unread_only: z.boolean().optional().default(false).describe("If true, filters out messages that have been marked with ✅ by the bot"),
    reaction_filter: z.string().optional().describe("If provided, only returns messages that have this reaction (e.g. '🔴')"),
});

const SendMessageSchema = z.object({
    channel_name: z.string().describe("Name of the channel to send to"),
    content: z.string().describe("Message content to send"),
    project_name: z.string().optional().describe("Project name to display in the message"),
});

const ReactionSchema = z.object({
    channel_name: z.string().describe("Name of the channel"),
    message_id: z.string().describe("ID of the message to react to"),
    emoji: z.string().optional().default('✅').describe("Emoji to use (default: ✅)"),
});

const DeleteMessageSchema = z.object({
    channel_name: z.string().describe("Name of the channel"),
    message_id: z.string().describe("ID of the message to delete"),
});

// --- Server Implementation ---
class DiscordMcpServer {
    private server: Server;
    private client: Client;
    private ready: boolean = false;
    private loggingIn: boolean = false;
    private pendingMessages: { channel_name: string; content: string }[] = [];
    private loginPromise: Promise<void> | null = null;

    constructor() {
        this.server = new Server(
            {
                name: 'discord-server',
                version: '1.0.1',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
        });

        this.setupDiscordEvents();
        this.setupToolHandlers();

        // Error handling
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.client.destroy();
            await this.server.close();
            process.exit(0);
        });
    }

    private setupDiscordEvents() {
        this.client.once('ready', () => {
            console.error(`[Discord] Logged in as ${this.client.user?.tag}`);
            this.ready = true;
            this.loggingIn = false;
            this.flushPendingMessages();
        });

        this.client.on('error', (error) => {
            console.error('[Discord Error]', error);
            this.loggingIn = false;
        });

        this.client.on('shardDisconnect', () => {
            console.error('[Discord] Disconnected');
            this.ready = false;
        });

        this.client.on('shardReconnecting', () => {
            console.error('[Discord] Reconnecting...');
        });
    }



    private async flushPendingMessages() {
        if (this.pendingMessages.length === 0) return;

        console.error(`[Discord] Flushing ${this.pendingMessages.length} pending messages...`);
        const messages = [...this.pendingMessages];
        this.pendingMessages = [];

        for (const msg of messages) {
            try {
                const channel = await this.getChannelByName(msg.channel_name);
                await channel.send(`${msg.content}\n\n*(Note: This message was delayed due to connection issues)*`);
            } catch (error) {
                console.error(`[Discord] Failed to send pending message: ${error}`);
                // Put back in queue if it's a connection issue
                this.pendingMessages.push(msg);
            }
        }
    }

    private async getChannelByName(name: string): Promise<TextChannel> {
        // ensureConnected should have been called before
        if (!this.ready) {
            throw new McpError(ErrorCode.InternalError, 'Discord client is not ready.');
        }

        for (const guild of this.client.guilds.cache.values()) {
            const channel = guild.channels.cache.find(
                (c) => c.name === name && c.isTextBased()
            );
            if (channel) {
                return channel as TextChannel;
            }
        }
        throw new McpError(ErrorCode.InvalidParams, `Channel #${name} not found.`);
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'read_recent_messages',
                    description: 'Read recent messages from a Discord channel.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            limit: { type: 'number' },
                            unread_only: { type: 'boolean' },
                            reaction_filter: { type: 'string' }
                        },
                        required: ['channel_name']
                    },
                },
                {
                    name: 'send_message',
                    description: 'Send a message to a Discord channel. If offline, the message will be queued.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            content: { type: 'string' },
                            project_name: { type: 'string', description: 'Project name to display in the message' }
                        },
                        required: ['channel_name', 'content']
                    },
                },
                {
                    name: 'add_reaction',
                    description: 'Add a reaction to a message.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            message_id: { type: 'string' },
                            emoji: { type: 'string' }
                        },
                        required: ['channel_name', 'message_id']
                    },
                }
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                // Read operations require connection
                if (request.params.name !== 'send_message') {
                    await this.ensureConnected();
                }

                switch (request.params.name) {
                    case 'read_recent_messages': {
                        const { channel_name, limit, unread_only, reaction_filter } = ReadMessagesSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);
                        const fetchLimit = (unread_only || reaction_filter) ? Math.min(limit * 3, 100) : Math.min(limit, 50);
                        const messages = await channel.messages.fetch({ limit: fetchLimit });
                        let filtered = Array.from(messages.values());

                        if (reaction_filter) {
                            filtered = filtered.filter(m => m.reactions.cache.some(r => r.emoji.name === reaction_filter));
                        }
                        if (unread_only) {
                            filtered = filtered.filter(m => !m.reactions.cache.find(r => r.emoji.name === '✅' && r.me));
                        }

                        filtered = filtered.slice(0, limit);
                        const formatted = filtered.map(m => {
                            const time = m.createdAt.toISOString();
                            const author = m.author.username;
                            const isRead = m.reactions.cache.find(r => r.emoji.name === '✅' && r.me) ? '[READ]' : '[NEW]';
                            return `ID:${m.id} ${isRead} [${time}] ${author}: ${m.content}`;
                        }).reverse().join('\n');

                        return { content: [{ type: 'text', text: formatted || 'No messages found.' }] };
                    }
                    case 'send_message': {
                        const { channel_name, content, project_name } = SendMessageSchema.parse(request.params.arguments);
                        const projectName = project_name || process.env.PROJECT_NAME || process.env.MCP_PROJECT_NAME;
                        const messageContent = projectName ? `[${projectName}] ${content}` : content;

                        try {
                            await this.ensureConnected();
                            const channel = await this.getChannelByName(channel_name);
                            await channel.send(messageContent);
                            return { content: [{ type: 'text', text: `✅ Message sent to #${channel_name}` }] };
                        } catch (error) {
                            console.error(`[Discord] Send failed, queuing message: ${error}`);
                            this.pendingMessages.push({ channel_name, content: messageContent });

                            // Check if it's a persistent connection issue
                            const isAuthError = error instanceof Error && (error.message.includes('Token') || error.message.includes('Auth'));
                            const suggestion = isAuthError
                                ? "設定をご確認ください。"
                                : "接続が不安定なようです。VSCodeウィンドウをリロード(Ctrl+R)すると改善する場合があります。";

                            return {
                                content: [{
                                    type: 'text',
                                    text: `⚠️ [QUEUE] メッセージを送信待ちリストに保存しました。\n${suggestion}\n(現在、再接続を試みています...)`
                                }]
                            };
                        }
                    }
                    case 'add_reaction': {
                        const { channel_name, message_id, emoji } = ReactionSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);
                        const message = await channel.messages.fetch(message_id);
                        await message.react(emoji || '✅');
                        return { content: [{ type: 'text', text: `Added ${emoji || '✅'} to message ${message_id}` }] };
                    }
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
                }
            } catch (error: any) {
                if (error instanceof z.ZodError) {
                    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.errors.map((e: any) => e.message).join(', ')}`);
                }
                throw error;
            }
        });
    }

    async run() {
        try {
            fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] Connecting to transport...\n`);
            const transport = new StdioServerTransport();
            await this.server.connect(transport);
            fs.appendFileSync('/tmp/discord_mcp_debug.log', `[${new Date().toISOString()}] MCP Connected!\n`);
            console.error('Discord MCP Server connected to stdio');

            // DELAYED login to prevent startup timeout
            // Wait 5 seconds before attempting to login
            setTimeout(() => {
                this.ensureConnected().catch(err => {
                    const msg = `[${new Date().toISOString()}] Background login failed: ${err.message}\n`;
                    fs.appendFileSync('/tmp/discord_mcp_debug.log', msg);
                    console.error('[Discord] Initial connection failed (will retry on demand):', err.message);
                });
            }, 5000);

        } catch (error) {
            const msg = `[${new Date().toISOString()}] FATAL CRASH in run(): ${error}\n`;
            fs.appendFileSync('/tmp/discord_mcp_debug.log', msg);
            throw error;
        }
    }

    private async ensureConnected() {
        if (this.ready) return;

        if (this.loggingIn) {
            if (this.loginPromise) {
                await this.loginPromise;
            }
            return;
        }

        console.error('[Discord] Attempting to login...');
        this.loggingIn = true;
        this.loginPromise = (async () => {
            try {
                await this.client.login(TOKEN);

                // Wait for ready event
                if (!this.ready) {
                    await new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('Login timeout (15s)'));
                        }, 15000);

                        const onReady = () => {
                            clearTimeout(timeout);
                            this.client.off('error', onError);
                            resolve();
                        };

                        const onError = (err: any) => {
                            clearTimeout(timeout);
                            this.client.off('ready', onReady);
                            reject(err);
                        };

                        this.client.once('ready', onReady);
                        this.client.once('error', onError);
                    });
                }
            } catch (error) {
                console.error('[Discord] Login failed:', error);
                throw error;
            } finally {
                this.loggingIn = false;
                this.loginPromise = null;
            }
        })();

        await this.loginPromise;
    }
}

const server = new DiscordMcpServer();
server.run().catch(console.error);
