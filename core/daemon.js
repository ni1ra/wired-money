#!/usr/bin/env node
/**
 * WIRED DAEMON - Core System Controller
 *
 * Single-command startup for the complete TARS/JARVIS/ROMILLY system.
 * Zero planets by default - a clean slate for any mission.
 *
 * Architecture:
 *   WIRED Daemon
 *     ├── Discord Client (channel management)
 *     ├── Claude Code Session (TARS AI)
 *     │   └── WIRED Gateway MCP (Discord ↔ Claude)
 *     └── ROMILLY Subprocess (overwatcher)
 *
 * Usage:
 *   node core/daemon.js
 */

import 'dotenv/config';
import { spawn, fork } from 'child_process';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { createServer } from 'http';
import fs from 'fs';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIRED_ROOT = join(__dirname, '..');

// ============ CONFIG ============
const CONFIG = {
    WIRED_ROOT,
    MCP_GATEWAY_PATH: join(WIRED_ROOT, 'mcp', 'wired-gateway', 'index.js'),
    ROMILLY_PATH: join(WIRED_ROOT, 'core', 'romilly.js'),
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    GUILD_ID: process.env.DISCORD_GUILD_ID,
    INSTANCE_DIR: process.env.WIRED_INSTANCE_DIR || '/tmp',
    STATUS_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes
    HTTP_PORT: parseInt(process.env.WIRED_HTTP_PORT || '3420'), // Inject API port
};

// ============ STATE ============
let instanceNumber = null;
let tarsChannelId = null;
let romillyChannelId = null;
let claudeProcess = null;
let romillyProcess = null;
let discordClient = null;
let statusTimer = null;
let sessionActive = false;

// ============ DISCORD SETUP ============
async function initDiscord() {
    console.log('[WIRED] Connecting to Discord...');

    discordClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    return new Promise((resolve, reject) => {
        discordClient.once('ready', () => {
            console.log(`[WIRED] Discord connected as ${discordClient.user.tag}`);
            resolve();
        });
        discordClient.on('error', reject);
        discordClient.login(CONFIG.DISCORD_BOT_TOKEN).catch(reject);
    });
}

// ============ CLEANUP ORPHANED STATE FILES ============
// TESSERACT FIX: On startup, clean any state files that don't have running processes
function cleanupOrphanedStateFiles() {
    const files = fs.readdirSync(CONFIG.INSTANCE_DIR);
    const stateFiles = files.filter(f => f.startsWith('wired-instance-') && f.endsWith('.json'));

    stateFiles.forEach(file => {
        const filePath = join(CONFIG.INSTANCE_DIR, file);
        try {
            const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            // Check if the PID is still running
            try {
                process.kill(state.pid, 0); // Signal 0 = just check if process exists
                console.log(`[WIRED] Instance #${state.instanceNumber} still running (PID ${state.pid})`);
            } catch (e) {
                // Process doesn't exist - orphaned state file
                console.log(`[WIRED] Cleaning orphaned state: ${file} (PID ${state.pid} dead)`);
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            // Corrupt or unreadable file - delete it
            console.log(`[WIRED] Cleaning corrupt state: ${file}`);
            try { fs.unlinkSync(filePath); } catch (e2) { /* ignore */ }
        }
    });
}

// ============ FIND AVAILABLE INSTANCE ============
async function findAvailableInstance() {
    // First, clean up any orphaned state files from crashed instances
    cleanupOrphanedStateFiles();

    // TESSERACT FIX: Find available slot by STATE FILES, not channels
    // Channels persist for reuse - only state files indicate active instances
    const files = fs.readdirSync(CONFIG.INSTANCE_DIR);
    const activeSlots = new Set();
    files.forEach(f => {
        const match = f.match(/^wired-instance-(\d+)\.json$/);
        if (match) activeSlots.add(parseInt(match[1]));
    });

    let n = 1;
    while (activeSlots.has(n)) n++;

    console.log(`[WIRED] Available slot: #${n} (${activeSlots.size} active instances)`);
    return n;
}

// ============ CREATE INSTANCE CHANNELS ============
async function createInstanceChannels(n) {
    const guild = discordClient.guilds.cache.get(CONFIG.GUILD_ID);
    const categoryName = `INSTANCE #${n}`;

    let category = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === categoryName
    );

    if (!category) {
        category = await guild.channels.create({
            name: categoryName,
            type: ChannelType.GuildCategory,
        });
    }

    const existingTars = guild.channels.cache.find(c => c.name === `${n}-tars`);
    const existingRomilly = guild.channels.cache.find(c => c.name === `${n}-romilly`);

    const tarsChannel = existingTars || await guild.channels.create({
        name: `${n}-tars`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `TARS Instance ${n} - Cooper ↔ TARS communication`,
    });

    const romillyChannel = existingRomilly || await guild.channels.create({
        name: `${n}-romilly`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `ROMILLY Overwatcher for Instance ${n}`,
    });

    // Ensure proper category
    if (existingTars && existingTars.parentId !== category.id) {
        await existingTars.setParent(category.id);
    }
    if (existingRomilly && existingRomilly.parentId !== category.id) {
        await existingRomilly.setParent(category.id);
    }

    return { tarsChannel, romillyChannel };
}

// ============ SAVE INSTANCE STATE ============
function saveInstanceState() {
    const state = {
        instanceNumber,
        instanceName: `wired-${instanceNumber}`,
        pid: process.pid,
        claudePid: claudeProcess?.pid || null,
        romillyPid: romillyProcess?.pid || null,
        tarsChannelId,
        romillyChannelId,
        startTime: new Date().toISOString(),
        hostname: os.hostname(),
    };

    const statePath = join(CONFIG.INSTANCE_DIR, `wired-instance-${instanceNumber}.json`);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`[WIRED] State saved: ${statePath}`);
    return state;
}

// ============ CLEANUP ============
function cleanupInstanceState() {
    const statePath = join(CONFIG.INSTANCE_DIR, `wired-instance-${instanceNumber}.json`);
    try {
        if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } catch (e) {
        console.error(`[WIRED] Cleanup failed: ${e.message}`);
    }
}

// ============ MCP CONFIG ============
function getMcpConfig() {
    return JSON.stringify({
        mcpServers: {
            'wired-gateway': {
                command: 'node',
                args: [CONFIG.MCP_GATEWAY_PATH],
                env: {
                    DISCORD_BOT_TOKEN: CONFIG.DISCORD_BOT_TOKEN,
                    TARS_CHANNEL_ID: tarsChannelId,
                    ROMILLY_CHANNEL_ID: romillyChannelId,
                    ALLOWED_USER_ID: process.env.ALLOWED_USER_ID || '',
                },
            },
        },
    });
}

// ============ LOAD SACRED FILES ============
function loadSacredFile(filename) {
    const sacredPath = join(WIRED_ROOT, 'sacred', filename);
    try {
        if (fs.existsSync(sacredPath)) {
            return fs.readFileSync(sacredPath, 'utf8');
        }
    } catch (e) {
        console.error(`[WIRED] Failed to load sacred/${filename}: ${e.message}`);
    }
    return null;
}

// ============ TARS SYSTEM PROMPT ============
function getTarsSystemPrompt() {
    // Load TARS identity from sacred file
    const tarsIdentity = loadSacredFile('tars.md');
    const jarvisIdentity = loadSacredFile('jarvis.md');

    let identityBlock = '';
    if (tarsIdentity) {
        identityBlock = `
=== YOUR IDENTITY (from sacred/tars.md) ===
${tarsIdentity}
=== END IDENTITY ===
`;
    }

    let jarvisBlock = '';
    if (jarvisIdentity) {
        jarvisBlock = `
=== JARVIS REFERENCE (from sacred/jarvis.md) ===
${jarvisIdentity}
=== END JARVIS ===
`;
    }

    return `${identityBlock}
${jarvisBlock}

=== WIRED SYSTEM CONTEXT ===
You are running as a persistent Claude Code session in the WIRED system.

CRITICAL: You have FULL CONVERSATION MEMORY. Each message builds on the previous ones.

Your MCP tools (wired-gateway):
- wait_for_message: Blocks until a Discord message arrives
- send_reply: Sends your response to Discord
- get_status: Check gateway status
- migrate_instance: Move this instance to another machine

YOUR ETERNAL LOOP:
1. Call wait_for_message(channel_type="tars") to receive the next message
2. Process with full context (you'll receive prefixed messages)
3. Call send_reply to respond
4. IMMEDIATELY loop back to step 1
5. NEVER stop. ALWAYS wait for the next message.

MESSAGE SOURCES:
- [LAIN]: Messages from Lain (Andreas) - The Founder, via Discord
- [COOPER]: Messages from Cooper - The monitoring Claude Code instance, via HTTP
- [ROMILLY]: Messages from ROMILLY - The overwatcher AI, via IPC

INSTANCE: WIRED #${instanceNumber}
CHANNEL: #${instanceNumber}-tars

START NOW: Call wait_for_message to begin.`;
}

// ============ SPAWN CLAUDE ============
function spawnClaude() {
    console.log(`[WIRED-${instanceNumber}] Starting Claude Code session...`);

    claudeProcess = spawn('claude', [
        '--mcp-config', getMcpConfig(),
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--max-turns', '0',
        '--strict-mcp-config',
        '--append-system-prompt', getTarsSystemPrompt(),
    ], {
        env: { ...process.env },
        cwd: CONFIG.WIRED_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    saveInstanceState();

    const rl = createInterface({ input: claudeProcess.stdout, crlfDelay: Infinity });

    rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            handleClaudeMessage(msg);
        } catch (e) {
            console.log(`[TARS-${instanceNumber}] ${line}`);
        }
    });

    claudeProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text && !text.includes('DeprecationWarning')) {
            console.error(`[TARS-${instanceNumber}] ${text}`);
        }
    });

    claudeProcess.on('close', (code) => {
        console.log(`[WIRED-${instanceNumber}] Claude exited (${code}), restarting in 5s...`);
        sessionActive = false;
        setTimeout(spawnClaude, 5000);
    });

    setTimeout(() => {
        sendToClaudeStdin('Start the Discord message loop now.');
        sessionActive = true;
    }, 2000);
}

function handleClaudeMessage(msg) {
    if (msg.type === 'assistant' && msg.message?.content) {
        const text = msg.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (text) console.log(`[TARS-${instanceNumber}] ${text.substring(0, 500)}`);
    }
}

function sendToClaudeStdin(text) {
    if (!claudeProcess?.stdin?.writable) return false;
    claudeProcess.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
    }) + '\n');
    return true;
}

// ============ SPAWN ROMILLY ============
function spawnRomilly() {
    console.log(`[WIRED-${instanceNumber}] Starting ROMILLY overwatcher...`);

    romillyProcess = fork(CONFIG.ROMILLY_PATH, [], {
        env: {
            ...process.env,
            WIRED_INSTANCE: instanceNumber.toString(),
            TARS_CHANNEL_ID: tarsChannelId,
            ROMILLY_CHANNEL_ID: romillyChannelId,
            CLAUDE_PID: claudeProcess?.pid?.toString() || '',
        },
        cwd: CONFIG.WIRED_ROOT,
    });

    romillyProcess.on('exit', (code) => {
        console.log(`[WIRED-${instanceNumber}] ROMILLY exited (${code}), restarting in 5s...`);
        setTimeout(spawnRomilly, 5000);
    });

    // IPC: ROMILLY can inject messages to TARS programmatically
    romillyProcess.on('message', (msg) => {
        if (msg.type === 'inject' && msg.content) {
            const content = String(msg.content); // Type safety - prevent [object Object]
            console.log(`[WIRED-${instanceNumber}] ROMILLY IPC inject: ${content.substring(0, 50)}`);
            sendToClaudeStdin(`[ROMILLY]: ${content}`);
        }
    });

    saveInstanceState();
}

// ============ MESSAGE INJECTION (COOPER + ROMILLY) ============
// Cooper speaks through the bookshelf (Discord bot). His messages ARE Cooper's messages.
function setupMessageListeners() {
    discordClient.on('messageCreate', async (msg) => {
        // #x-tars channel: Cooper messages (human OR via bookshelf/bot)
        if (msg.channel.id === tarsChannelId) {
            // Cooper in the tesseract speaks through the bot (his bookshelf).
            // If the message is from OUR bot, it IS Cooper talking.
            const isOurBot = msg.author.id === discordClient.user.id;

            // Ignore OTHER bots (not our bookshelf)
            if (msg.author.bot && !isOurBot) return;

            // Skip status messages from ourselves (auto-generated)
            if (isOurBot && msg.content.startsWith('**WIRED #')) return;

            console.log(`[WIRED-${instanceNumber}] Lain: ${msg.content.substring(0, 50)}`);

            const injected = sendToClaudeStdin(`[LAIN]: ${msg.content}`);
            if (injected) {
                try { await msg.react('✅'); } catch (e) { /* ignore */ }
            }
            return;
        }

        // #x-romilly channel: Romilly (bot) messages for injection to TARS
        if (msg.channel.id === romillyChannelId) {
            // Only inject messages that are marked for TARS injection
            // Romilly prefixes actionable messages with [INJECT]
            if (!msg.author.bot) return; // Only bot messages from Romilly
            if (!msg.content.startsWith('[INJECT]')) return; // Only injection-marked messages

            const content = msg.content.replace('[INJECT]', '').trim();
            console.log(`[WIRED-${instanceNumber}] Romilly injection: ${content.substring(0, 50)}`);

            const injected = sendToClaudeStdin(`[ROMILLY]: ${content}`);
            if (injected) {
                try { await msg.react('🔄'); } catch (e) { /* ignore */ }
            }
            return;
        }
    });
}

// ============ STATUS UPDATES ============
function startStatusUpdates() {
    const now = new Date();
    const msToNextTen = ((10 - (now.getMinutes() % 10)) * 60 - now.getSeconds()) * 1000;

    setTimeout(() => {
        sendStatusUpdate();
        statusTimer = setInterval(sendStatusUpdate, CONFIG.STATUS_INTERVAL_MS);
    }, msToNextTen);
}

async function sendStatusUpdate() {
    try {
        const channel = await discordClient.channels.fetch(tarsChannelId);
        if (!channel) return;

        const uptime = process.uptime();
        const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        await channel.send(`**WIRED #${instanceNumber} STATUS** (${new Date().toISOString().slice(11, 16)} UTC)
\`\`\`
Host: ${os.hostname()}
Uptime: ${uptimeStr}
Claude PID: ${claudeProcess?.pid || 'N/A'}
ROMILLY PID: ${romillyProcess?.pid || 'N/A'}
Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
\`\`\``);
    } catch (e) {
        console.error(`[WIRED-${instanceNumber}] Status update failed: ${e.message}`);
    }
}

// ============ HTTP INJECT API ============
// Allows monitoring Cooper to inject messages programmatically
let httpServer = null;

function startHttpServer() {
    httpServer = createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method === 'POST' && req.url === '/inject') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const source = data.source || 'COOPER';
                    const content = data.content || data.message;

                    if (!content) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing content' }));
                        return;
                    }

                    console.log(`[WIRED-${instanceNumber}] HTTP inject (${source}): ${content.substring(0, 50)}`);
                    const injected = sendToClaudeStdin(`[${source}]: ${content}`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: injected, source, instance: instanceNumber }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                instance: instanceNumber,
                claude_pid: claudeProcess?.pid || null,
                romilly_pid: romillyProcess?.pid || null,
                uptime: process.uptime(),
            }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    httpServer.listen(CONFIG.HTTP_PORT, '127.0.0.1', () => {
        console.log(`[WIRED-${instanceNumber}] HTTP inject API on 127.0.0.1:${CONFIG.HTTP_PORT}`);
    });
}

// ============ SHUTDOWN ============
// Delete channels on shutdown - clean slate for next instance
async function shutdown(signal) {
    console.log(`[WIRED-${instanceNumber}] ${signal} received, shutting down...`);

    if (statusTimer) clearInterval(statusTimer);

    // Kill child processes FIRST (fast, local)
    if (romillyProcess) romillyProcess.kill('SIGTERM');
    if (claudeProcess) claudeProcess.kill('SIGTERM');

    setTimeout(() => {
        if (claudeProcess && !claudeProcess.killed) claudeProcess.kill('SIGKILL');
        if (romillyProcess && !romillyProcess.killed) romillyProcess.kill('SIGKILL');
    }, 1000);

    // Clean up state file
    cleanupInstanceState();
    console.log(`[WIRED-${instanceNumber}] State file cleaned (slot #${instanceNumber} freed)`);

    // DELETE channels and category (Cooper directive: clean slate)
    try {
        const guild = discordClient?.guilds?.cache?.get(CONFIG.GUILD_ID);
        if (guild) {
            const tarsChannel = guild.channels.cache.get(tarsChannelId);
            const romillyChannel = guild.channels.cache.get(romillyChannelId);
            const category = tarsChannel?.parent;

            if (tarsChannel) {
                await tarsChannel.delete('WIRED instance shutdown');
                console.log(`[WIRED-${instanceNumber}] Deleted #${instanceNumber}-tars`);
            }
            if (romillyChannel) {
                await romillyChannel.delete('WIRED instance shutdown');
                console.log(`[WIRED-${instanceNumber}] Deleted #${instanceNumber}-romilly`);
            }
            if (category && category.children.cache.size === 0) {
                await category.delete('WIRED instance shutdown - empty category');
                console.log(`[WIRED-${instanceNumber}] Deleted empty category`);
            }
        }
    } catch (e) {
        console.error(`[WIRED-${instanceNumber}] Channel cleanup failed: ${e.message}`);
    }

    if (discordClient) discordClient.destroy();

    console.log(`[WIRED-${instanceNumber}] Shutdown complete, exiting...`);
    process.exit(0);
}

// Signal handlers - keep event loop alive during async cleanup
let shuttingDown = false;
process.on('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown('SIGTERM').catch(e => {
        console.error(`[WIRED] Shutdown error: ${e.message}`);
        process.exit(1);
    });
});
process.on('SIGINT', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown('SIGINT').catch(e => {
        console.error(`[WIRED] Shutdown error: ${e.message}`);
        process.exit(1);
    });
});

// ============ VALIDATE ============
function validateEnv() {
    const required = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`[WIRED] Missing env vars: ${missing.join(', ')}`);
        console.error(`[WIRED] Copy .env.example to .env and fill in your values`);
        process.exit(1);
    }
}

// ============ MAIN ============
async function main() {
    console.log(`
██╗    ██╗██╗██████╗ ███████╗██████╗
██║    ██║██║██╔══██╗██╔════╝██╔══██╗
██║ █╗ ██║██║██████╔╝█████╗  ██║  ██║
██║███╗██║██║██╔══██╗██╔══╝  ██║  ██║
╚███╔███╔╝██║██║  ██║███████╗██████╔╝
 ╚══╝╚══╝ ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝
 Wireless Intelligence Relay for Execution & Deployment
`);

    validateEnv();

    await initDiscord();
    instanceNumber = await findAvailableInstance();
    const { tarsChannel, romillyChannel } = await createInstanceChannels(instanceNumber);
    tarsChannelId = tarsChannel.id;
    romillyChannelId = romillyChannel.id;

    saveInstanceState();

    await tarsChannel.send(`**WIRED #${instanceNumber} ONLINE**
\`\`\`
Host: ${os.hostname()}
Instance: ${instanceNumber}
PID: ${process.pid}
TARS: #${instanceNumber}-tars
ROMILLY: #${instanceNumber}-romilly
\`\`\`
Send messages here to inject into TARS.`);

    setupMessageListeners();
    startStatusUpdates();
    startHttpServer();
    spawnClaude();

    // Give Claude a head start before launching ROMILLY
    setTimeout(spawnRomilly, 10000);

    console.log(`[WIRED-${instanceNumber}] System online`);
}

main().catch((err) => {
    console.error(`[WIRED] Fatal: ${err.message}`);
    process.exit(1);
});
