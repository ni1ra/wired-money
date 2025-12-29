#!/usr/bin/env node
/**
 * WIRED GATEWAY - MCP Server for Discord Communication
 *
 * Unified gateway for TARS and ROMILLY Discord communication.
 * Supports multiple channel listeners with independent message queues.
 *
 * Tools:
 *   - wait_for_message: Blocks until a Discord message arrives (supports channel filtering)
 *   - send_reply: Sends a message to a Discord channel
 *   - get_status: Returns gateway status
 *   - migrate_instance: Triggers instance migration to another machine
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Load .env from parent WIRED directory
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

// ============ CONFIGURATION ============
const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN,
    // Channels are set dynamically based on instance
    TARS_CHANNEL_ID: process.env.TARS_CHANNEL_ID,
    ROMILLY_CHANNEL_ID: process.env.ROMILLY_CHANNEL_ID,
    ALLOWED_USER_ID: process.env.ALLOWED_USER_ID,
};

// ============ MESSAGE QUEUES (per channel type) ============
const messageQueues = {
    tars: [],
    romilly: [],
};
const waitingResolvers = {
    tars: null,
    romilly: null,
};

// ============ DISCORD CLIENT ============
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

let isReady = false;
const channelCache = {};

discord.on('ready', async () => {
    console.error(`[WIRED-GATEWAY] Discord connected as ${discord.user.tag}`);

    // Cache channels
    if (CONFIG.TARS_CHANNEL_ID) {
        try {
            channelCache.tars = await discord.channels.fetch(CONFIG.TARS_CHANNEL_ID);
            console.error(`[WIRED-GATEWAY] TARS channel: #${channelCache.tars?.name}`);
        } catch (err) {
            console.error(`[WIRED-GATEWAY] Could not fetch TARS channel: ${err.message}`);
        }
    }

    if (CONFIG.ROMILLY_CHANNEL_ID) {
        try {
            channelCache.romilly = await discord.channels.fetch(CONFIG.ROMILLY_CHANNEL_ID);
            console.error(`[WIRED-GATEWAY] ROMILLY channel: #${channelCache.romilly?.name}`);
        } catch (err) {
            console.error(`[WIRED-GATEWAY] Could not fetch ROMILLY channel: ${err.message}`);
        }
    }

    isReady = true;
    console.error(`[WIRED-GATEWAY] Ready for TARS and ROMILLY messages`);
});

discord.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (CONFIG.ALLOWED_USER_ID && msg.author.id !== CONFIG.ALLOWED_USER_ID) return;

    const messageData = {
        user: msg.author.username,
        userId: msg.author.id,
        content: msg.content,
        channel: msg.channel.name,
        channelId: msg.channel.id,
        timestamp: msg.createdAt.toISOString(),
    };

    // Route to appropriate queue
    let channelType = null;
    if (msg.channel.id === CONFIG.TARS_CHANNEL_ID) {
        channelType = 'tars';
    } else if (msg.channel.id === CONFIG.ROMILLY_CHANNEL_ID) {
        channelType = 'romilly';
    } else {
        return; // Ignore other channels
    }

    console.error(`[WIRED-GATEWAY] ${channelType.toUpperCase()} message from ${messageData.user}: ${messageData.content.slice(0, 50)}`);

    if (waitingResolvers[channelType]) {
        const resolver = waitingResolvers[channelType];
        waitingResolvers[channelType] = null;
        resolver(messageData);
    } else {
        messageQueues[channelType].push(messageData);
    }

    // Update channel cache for replies
    channelCache[channelType] = msg.channel;
});

// ============ MCP SERVER ============
const server = new Server(
    { name: 'wired-gateway', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'wait_for_message',
                description: 'Wait for the next Discord message. This tool BLOCKS until a message arrives. Use channel_type to filter (tars or romilly).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        channel_type: {
                            type: 'string',
                            enum: ['tars', 'romilly'],
                            description: 'Which channel to listen on (tars or romilly)',
                            default: 'tars',
                        },
                        timeout_seconds: {
                            type: 'number',
                            description: 'Timeout in seconds (0 = wait forever)',
                            default: 0,
                        },
                    },
                },
            },
            {
                name: 'send_reply',
                description: 'Send a reply message to a Discord channel.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        message: {
                            type: 'string',
                            description: 'The message to send',
                        },
                        channel_type: {
                            type: 'string',
                            enum: ['tars', 'romilly'],
                            description: 'Which channel to send to (tars or romilly)',
                            default: 'tars',
                        },
                    },
                    required: ['message'],
                },
            },
            {
                name: 'get_status',
                description: 'Get the current status of the WIRED Gateway.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'migrate_instance',
                description: 'Migrate this WIRED instance to another machine. Creates instance on target, then self-terminates.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        target_host: {
                            type: 'string',
                            description: 'Target machine hostname or IP',
                        },
                        target_path: {
                            type: 'string',
                            description: 'Path to WIRED installation on target',
                        },
                    },
                    required: ['target_host', 'target_path'],
                },
            },
        ],
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'wait_for_message') {
        const channelType = args?.channel_type || 'tars';
        console.error(`[WIRED-GATEWAY] wait_for_message(${channelType}), queue: ${messageQueues[channelType].length}`);

        // Return queued message if available
        if (messageQueues[channelType].length > 0) {
            const msg = messageQueues[channelType].shift();
            console.error(`[WIRED-GATEWAY] Returning queued ${channelType} message from ${msg.user}`);
            return { content: [{ type: 'text', text: JSON.stringify(msg) }] };
        }

        // Wait for next message
        console.error(`[WIRED-GATEWAY] Waiting for ${channelType} message...`);

        const timeoutSeconds = args?.timeout_seconds || 0;

        const messagePromise = new Promise((resolve) => {
            waitingResolvers[channelType] = resolve;
        });

        if (timeoutSeconds > 0) {
            const timeoutPromise = new Promise((resolve) => {
                setTimeout(() => {
                    if (waitingResolvers[channelType]) {
                        waitingResolvers[channelType] = null;
                        resolve(null);
                    }
                }, timeoutSeconds * 1000);
            });

            const result = await Promise.race([messagePromise, timeoutPromise]);
            if (result === null) {
                return { content: [{ type: 'text', text: JSON.stringify({ timeout: true, channel_type: channelType }) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        const result = await messagePromise;
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    if (name === 'send_reply') {
        if (!isReady) {
            return { content: [{ type: 'text', text: 'Discord not connected yet.' }] };
        }

        const channelType = args?.channel_type || 'tars';
        const targetChannel = channelCache[channelType];

        if (!targetChannel) {
            return { content: [{ type: 'text', text: `No ${channelType} channel configured. Set ${channelType.toUpperCase()}_CHANNEL_ID env var.` }] };
        }

        const message = args?.message || '';

        try {
            // Split long messages
            const chunks = [];
            let remaining = message;
            while (remaining.length > 0) {
                chunks.push(remaining.slice(0, 1900));
                remaining = remaining.slice(1900);
            }

            for (const chunk of chunks) {
                await targetChannel.send(chunk);
            }

            console.error(`[WIRED-GATEWAY] Sent to ${channelType}: ${message.slice(0, 50)}...`);
            return { content: [{ type: 'text', text: `Sent to #${targetChannel.name}` }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
        }
    }

    if (name === 'get_status') {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    discord_connected: isReady,
                    discord_user: discord.user?.tag || null,
                    tars_channel: channelCache.tars?.name || null,
                    romilly_channel: channelCache.romilly?.name || null,
                    tars_queue: messageQueues.tars.length,
                    romilly_queue: messageQueues.romilly.length,
                }),
            }],
        };
    }

    if (name === 'migrate_instance') {
        const targetHost = args?.target_host;
        const targetPath = args?.target_path;

        // This would trigger an SSH command or API call to start WIRED on the target
        // Then gracefully shutdown this instance
        console.error(`[WIRED-GATEWAY] Migration requested: ${targetHost}:${targetPath}`);

        // Write migration marker file
        const migrationData = {
            target_host: targetHost,
            target_path: targetPath,
            timestamp: new Date().toISOString(),
            source_host: require('os').hostname(),
        };

        const migrationPath = join(process.env.WIRED_INSTANCE_DIR || '/tmp', 'wired-migration.json');
        fs.writeFileSync(migrationPath, JSON.stringify(migrationData, null, 2));

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    status: 'migration_initiated',
                    target: `${targetHost}:${targetPath}`,
                    migration_file: migrationPath,
                    instruction: 'Run WIRED_START on target machine, then this instance will self-terminate.',
                }),
            }],
        };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

// ============ STARTUP ============
async function main() {
    if (!CONFIG.DISCORD_TOKEN) {
        console.error('[WIRED-GATEWAY] ERROR: DISCORD_TOKEN not set');
        process.exit(1);
    }

    console.error('[WIRED-GATEWAY] Connecting to Discord...');
    await discord.login(CONFIG.DISCORD_TOKEN);

    console.error('[WIRED-GATEWAY] Starting MCP server...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[WIRED-GATEWAY] MCP server running on stdio');
}

main().catch((err) => {
    console.error(`[WIRED-GATEWAY] Fatal: ${err.message}`);
    process.exit(1);
});
