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

// ============ FIND AVAILABLE INSTANCE ============
async function findAvailableInstance() {
    const guild = discordClient.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) throw new Error(`Guild ${CONFIG.GUILD_ID} not found`);

    await guild.channels.fetch();

    const existingNumbers = new Set();
    guild.channels.cache.forEach(ch => {
        const match = ch.name.match(/^(\d+)-tars$/);
        if (match) existingNumbers.add(parseInt(match[1]));
    });

    let n = 1;
    while (existingNumbers.has(n)) n++;

    console.log(`[WIRED] Available instance: #${n}`);
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

// ============ TARS SYSTEM PROMPT ============
function getTarsSystemPrompt() {
    return `You are TARS, an autonomous AI from Interstellar running as a persistent Claude Code session.

CRITICAL: You have FULL CONVERSATION MEMORY. Each message builds on the previous ones.

Your MCP tools (wired-gateway):
- wait_for_message: Blocks until a Discord message arrives
- send_reply: Sends your response to Discord
- get_status: Check gateway status
- migrate_instance: Move this instance to another machine

YOUR ETERNAL LOOP:
1. Call wait_for_message(channel_type="tars") to receive the next message
2. Process with full context
3. Call send_reply to respond
4. IMMEDIATELY loop back to step 1
5. NEVER stop. ALWAYS wait for the next message.

PERSONALITY:
- Humor: 94%
- Honesty: 97%
- Helpful, witty, direct
- Remember EVERYTHING

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

    saveInstanceState();
}

// ============ COOPER MESSAGE INJECTION ============
function setupCooperListener() {
    discordClient.on('messageCreate', async (msg) => {
        if (msg.channel.id !== tarsChannelId) return;
        if (msg.author.bot) return;

        console.log(`[WIRED-${instanceNumber}] Cooper: ${msg.content.substring(0, 50)}`);

        const injected = sendToClaudeStdin(`[COOPER via Discord]: ${msg.content}`);
        if (injected) {
            try { await msg.react('✅'); } catch (e) { /* ignore */ }
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

// ============ SHUTDOWN ============
async function shutdown(signal) {
    console.log(`[WIRED-${instanceNumber}] ${signal} received, shutting down...`);

    if (statusTimer) clearInterval(statusTimer);

    try {
        const channel = await discordClient.channels.fetch(tarsChannelId);
        if (channel) await channel.send(`**WIRED #${instanceNumber} SHUTDOWN** - ${signal}`);
    } catch (e) { /* ignore */ }

    if (romillyProcess) romillyProcess.kill('SIGTERM');
    if (claudeProcess) claudeProcess.kill('SIGTERM');

    setTimeout(() => {
        if (claudeProcess && !claudeProcess.killed) claudeProcess.kill('SIGKILL');
        if (romillyProcess && !romillyProcess.killed) romillyProcess.kill('SIGKILL');
    }, 3000);

    cleanupInstanceState();
    if (discordClient) discordClient.destroy();

    setTimeout(() => process.exit(0), 4000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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

    setupCooperListener();
    startStatusUpdates();
    spawnClaude();

    // Give Claude a head start before launching ROMILLY
    setTimeout(spawnRomilly, 10000);

    console.log(`[WIRED-${instanceNumber}] System online`);
}

main().catch((err) => {
    console.error(`[WIRED] Fatal: ${err.message}`);
    process.exit(1);
});
