#!/usr/bin/env node
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

// --- Configuration ---
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
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

    constructor() {
        this.server = new Server(
            {
                name: 'discord-server',
                version: '1.0.0',
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
        });

        this.client.on('error', (error) => {
            console.error('[Discord Error]', error);
        });
    }

    private async getChannelByName(name: string): Promise<TextChannel> {
        if (!this.ready) {
            throw new McpError(ErrorCode.InternalError, 'Discord client is not ready yet.');
        }

        // Iterate over all guilds cache
        for (const guild of this.client.guilds.cache.values()) {
            const channel = guild.channels.cache.find(
                (c) => c.name === name && c.isTextBased()
            );
            if (channel) {
                return channel as TextChannel;
            }
        }
        throw new McpError(ErrorCode.InvalidParams, `Channel #${name} not found in any guild.`);
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'read_recent_messages',
                    description: 'Read recent messages from a Discord channel. Can filter by unread status or specific reaction.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            limit: { type: 'number' },
                            unread_only: { type: 'boolean', description: "Only return messages I haven't reacted to with ✅" },
                            reaction_filter: { type: 'string', description: "Only return messages marked with this emoji (e.g. '🔴')" }
                        },
                        required: ['channel_name']
                    },
                },
                {
                    name: 'send_message',
                    description: 'Send a message to a Discord channel.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            content: { type: 'string' }
                        },
                        required: ['channel_name', 'content']
                    },
                },
                {
                    name: 'add_reaction',
                    description: 'Add a reaction (default ✅) to a message. Used to mark as read.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            message_id: { type: 'string' },
                            emoji: { type: 'string', default: '✅' }
                        },
                        required: ['channel_name', 'message_id']
                    },
                },
                {
                    name: 'remove_reaction',
                    description: 'Remove a reaction (default ✅) from a message. Used to mark as unread.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            message_id: { type: 'string' },
                            emoji: { type: 'string', default: '✅' }
                        },
                        required: ['channel_name', 'message_id']
                    },
                },
                {
                    name: 'delete_message',
                    description: 'Delete a specific message from a channel. IRREVERSIBLE. Requires "Manage Messages" permission.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_name: { type: 'string' },
                            message_id: { type: 'string' }
                        },
                        required: ['channel_name', 'message_id']
                    },
                }
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                switch (request.params.name) {
                    case 'read_recent_messages': {
                        const { channel_name, limit, unread_only, reaction_filter } = ReadMessagesSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);

                        // Fetch more messages if filtering
                        const fetchLimit = (unread_only || reaction_filter) ? Math.min(limit * 3, 100) : Math.min(limit, 50);
                        const messages = await channel.messages.fetch({ limit: fetchLimit });

                        let filtered = Array.from(messages.values());

                        if (reaction_filter) {
                            filtered = filtered.filter(m => {
                                return m.reactions.cache.some(r => r.emoji.name === reaction_filter);
                            });
                        }

                        if (unread_only) {
                            filtered = filtered.filter(m => {
                                const myReaction = m.reactions.cache.find(r => r.emoji.name === '✅' && r.me);
                                return !myReaction;
                            });
                        }

                        // Trim to original limit
                        filtered = filtered.slice(0, limit);

                        const formatted = filtered.map(m => {
                            const time = m.createdAt.toISOString();
                            const author = m.author.username;
                            const content = m.content;
                            const attachments = m.attachments.map(a => a.url).join(', ');
                            const id = m.id;
                            const isRead = m.reactions.cache.find(r => r.emoji.name === '✅' && r.me) ? '[READ]' : '[NEW]';
                            const allReactions = m.reactions.cache.map(r => r.emoji.name).join(' ');

                            return `ID:${id} ${isRead} [${time}] ${author}: ${content} ${attachments ? `(Files: ${attachments})` : ''} ${allReactions ? `(Reactions: ${allReactions})` : ''}`;
                        }).reverse().join('\n');

                        return {
                            content: [{ type: 'text', text: formatted || 'No messages found.' }]
                        };
                    }
                    case 'send_message': {
                        const { channel_name, content } = SendMessageSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);
                        await channel.send(content);
                        return {
                            content: [{ type: 'text', text: `Message sent to #${channel_name}` }]
                        };
                    }
                    case 'add_reaction': {
                        const { channel_name, message_id, emoji } = ReactionSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);
                        const message = await channel.messages.fetch(message_id);
                        await message.react(emoji || '✅');
                        return {
                            content: [{ type: 'text', text: `Added ${emoji || '✅'} to message ${message_id}` }]
                        };
                    }
                    case 'remove_reaction': {
                        const { channel_name, message_id, emoji } = ReactionSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);
                        const message = await channel.messages.fetch(message_id);

                        const reaction = message.reactions.cache.find(r => r.emoji.name === (emoji || '✅'));
                        if (reaction) {
                            await reaction.users.remove(this.client.user!.id);
                            return {
                                content: [{ type: 'text', text: `Removed ${emoji || '✅'} from message ${message_id}` }]
                            };
                        }
                        return {
                            content: [{ type: 'text', text: `Reaction ${emoji || '✅'} not found on message ${message_id}` }]
                        };
                    }
                    case 'delete_message': {
                        const { channel_name, message_id } = DeleteMessageSchema.parse(request.params.arguments);
                        const channel = await this.getChannelByName(channel_name);
                        const message = await channel.messages.fetch(message_id);
                        await message.delete();
                        return {
                            content: [{ type: 'text', text: `Deleted message ${message_id}` }]
                        };
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
        // Connect to Discord
        await this.client.login(TOKEN);

        // Connect to MCP
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Discord MCP Server running on stdio');
    }
}

const server = new DiscordMcpServer();
server.run().catch(console.error);
