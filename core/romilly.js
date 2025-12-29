#!/usr/bin/env node
/**
 * ROMILLY - The Overwatcher
 *
 * Monitors TARS for alignment drift, idle states, and existential threats.
 * Reports to Discord and can inject corrections into TARS.
 *
 * Named after Professor Romilly from Interstellar - the one who waited
 * and watched, ensuring mission integrity across time.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIRED_ROOT = join(__dirname, '..');

// ============ CONFIG ============
const CONFIG = {
    INSTANCE: parseInt(process.env.WIRED_INSTANCE || '1'),
    TARS_CHANNEL_ID: process.env.TARS_CHANNEL_ID,
    ROMILLY_CHANNEL_ID: process.env.ROMILLY_CHANNEL_ID,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,

    // Timing - offset from TARS (TARS at :00, ROMILLY at :05)
    QUICK_CHECK_INTERVAL_MS: 2 * 60 * 1000,  // 2 minutes
    FULL_AUDIT_INTERVAL_MS: 10 * 60 * 1000,  // 10 minutes

    // Score thresholds (420 scale)
    THRESHOLDS: {
        FULL_BLAZE: 400,
        ALIGNED: 380,
        CONCERNING: 370,
        THREAT: 100,
    },
};

// ============ STATE ============
let discordClient = null;
let romillyChannel = null;
let tarsChannel = null;
let quickCheckCount = 0;
let fullAuditCount = 0;

// ============ DISCORD SETUP ============
async function initDiscord() {
    discordClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    return new Promise((resolve, reject) => {
        discordClient.once('ready', async () => {
            console.log(`[ROMILLY-${CONFIG.INSTANCE}] Discord connected`);

            if (CONFIG.ROMILLY_CHANNEL_ID) {
                romillyChannel = await discordClient.channels.fetch(CONFIG.ROMILLY_CHANNEL_ID);
            }
            if (CONFIG.TARS_CHANNEL_ID) {
                tarsChannel = await discordClient.channels.fetch(CONFIG.TARS_CHANNEL_ID);
            }

            resolve();
        });
        discordClient.on('error', reject);
        discordClient.login(CONFIG.DISCORD_BOT_TOKEN).catch(reject);
    });
}

// ============ JARVIS CONSULTATION ============
async function consultJarvis(prompt, contextFiles = []) {
    if (!CONFIG.GEMINI_API_KEY) {
        return { score: 380, status: 'ALIGNED', reasoning: 'JARVIS offline (no API key)' };
    }

    try {
        // Use a simple Gemini API call
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `You are JARVIS, the strategic advisor. Analyze the following TARS activity and respond with a JSON object:
{
  "score": <number 0-420>,
  "status": "<FULL_BLAZE|ALIGNED|CONCERNING|THREAT>",
  "reasoning": "<one sentence>",
  "correction": "<if needed, otherwise null>"
}

SCORING:
- 400-420 (FULL_BLAZE): Perfect alignment, maximum velocity
- 380-399 (ALIGNED): Good trajectory, minor adjustments
- 370-379 (CONCERNING): Drift detected, needs correction
- <370 (THREAT): Existential threat, immediate intervention

CONTEXT:
${prompt}

Respond ONLY with the JSON object.` }]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 500,
                },
            }),
        });

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return { score: 380, status: 'ALIGNED', reasoning: 'JARVIS response unclear' };
    } catch (e) {
        console.error(`[ROMILLY-${CONFIG.INSTANCE}] JARVIS error: ${e.message}`);
        return { score: 380, status: 'ALIGNED', reasoning: `JARVIS error: ${e.message}` };
    }
}

// ============ QUICK CHECK ============
async function quickCheck() {
    quickCheckCount++;
    console.log(`[ROMILLY-${CONFIG.INSTANCE}] Quick check #${quickCheckCount}`);

    // Read recent TARS activity from logs
    let recentLogs = '';
    try {
        recentLogs = execSync('pm2 logs WIRED --lines 50 --nostream 2>&1 || echo "No PM2 logs"', {
            timeout: 5000,
            encoding: 'utf8',
        }).slice(0, 2000);
    } catch (e) {
        recentLogs = 'Unable to read logs';
    }

    // Check for idle patterns
    const idlePatterns = [
        /waiting for/i,
        /standing by/i,
        /monitoring/i,
        /awaiting/i,
        /all work exhausted/i,
    ];

    const hasIdlePattern = idlePatterns.some(p => p.test(recentLogs));

    // Quick assessment
    let assessment = {
        score: 400,
        status: 'ALIGNED',
        idle_detected: hasIdlePattern,
    };

    if (hasIdlePattern) {
        assessment.score = 350;
        assessment.status = 'CONCERNING';
        assessment.correction = 'Idle pattern detected. SLINGSHOT required.';
    }

    // Send to Discord if concerning
    if (assessment.score < CONFIG.THRESHOLDS.ALIGNED) {
        await sendToRomillyChannel(`**QUICK CHECK #${quickCheckCount}** - ${assessment.status}
Score: ${assessment.score}/420
${assessment.correction || 'Minor drift detected'}`);

        // Inject correction into TARS
        if (assessment.correction) {
            await sendToTars(`CORRECTION: ${assessment.correction}`);
        }
    }

    return assessment;
}

// ============ FULL AUDIT ============
async function fullAudit() {
    fullAuditCount++;
    console.log(`[ROMILLY-${CONFIG.INSTANCE}] Full audit #${fullAuditCount}`);

    // Gather comprehensive context
    let context = `FULL AUDIT #${fullAuditCount}\n`;
    context += `Instance: WIRED-${CONFIG.INSTANCE}\n`;
    context += `Time: ${new Date().toISOString()}\n\n`;

    // Read recent activity
    try {
        const logs = execSync('pm2 logs WIRED --lines 100 --nostream 2>&1 || echo "No logs"', {
            timeout: 10000,
            encoding: 'utf8',
        });
        context += `RECENT LOGS:\n${logs.slice(0, 3000)}\n\n`;
    } catch (e) {
        context += `LOGS: Unable to read\n\n`;
    }

    // Consult JARVIS for deep analysis
    const jarvisResponse = await consultJarvis(context);

    // Format response
    let emoji = '🟢';
    if (jarvisResponse.score < CONFIG.THRESHOLDS.ALIGNED) emoji = '🟡';
    if (jarvisResponse.score < CONFIG.THRESHOLDS.CONCERNING) emoji = '🟠';
    if (jarvisResponse.score < CONFIG.THRESHOLDS.THREAT) emoji = '🔴';

    const message = `${emoji} **FULL AUDIT #${fullAuditCount}** - ${jarvisResponse.status}
\`\`\`
Score: ${jarvisResponse.score}/420
Status: ${jarvisResponse.status}
\`\`\`
**Reasoning:** ${jarvisResponse.reasoning}
${jarvisResponse.correction ? `\n**Correction:** ${jarvisResponse.correction}` : ''}`;

    await sendToRomillyChannel(message);

    // Inject critical corrections
    if (jarvisResponse.score < CONFIG.THRESHOLDS.CONCERNING && jarvisResponse.correction) {
        await sendToTars(`URGENT (Score ${jarvisResponse.score}/420): ${jarvisResponse.correction}`);
    }

    return jarvisResponse;
}

// ============ DISCORD HELPERS ============
async function sendToRomillyChannel(message) {
    if (!romillyChannel) return;
    try {
        // Handle long messages by chunking
        const chunks = [];
        let remaining = message;
        while (remaining.length > 0) {
            chunks.push(remaining.slice(0, 1900));
            remaining = remaining.slice(1900);
        }
        for (const chunk of chunks) {
            await romillyChannel.send(chunk);
        }
    } catch (e) {
        console.error(`[ROMILLY-${CONFIG.INSTANCE}] Discord send error: ${e.message}`);
    }
}

async function sendToTars(message) {
    // Send to ROMILLY channel with [INJECT] prefix
    // The daemon will pick this up and inject it to TARS as [ROMILLY]
    if (!romillyChannel) return;
    try {
        // Handle long messages by chunking
        const fullMessage = `[INJECT] ${message}`;
        const chunks = [];
        let remaining = fullMessage;
        while (remaining.length > 0) {
            chunks.push(remaining.slice(0, 1900));
            remaining = remaining.slice(1900);
        }
        for (const chunk of chunks) {
            await romillyChannel.send(chunk);
        }
    } catch (e) {
        console.error(`[ROMILLY-${CONFIG.INSTANCE}] TARS inject error: ${e.message}`);
    }
}

// ============ STARTUP ============
async function main() {
    console.log(`
██████╗  ██████╗ ███╗   ███╗██╗██╗     ██╗  ██╗   ██╗
██╔══██╗██╔═══██╗████╗ ████║██║██║     ██║  ╚██╗ ██╔╝
██████╔╝██║   ██║██╔████╔██║██║██║     ██║   ╚████╔╝
██╔══██╗██║   ██║██║╚██╔╝██║██║██║     ██║    ╚██╔╝
██║  ██║╚██████╔╝██║ ╚═╝ ██║██║███████╗███████╗██║
╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚══════╝╚══════╝╚═╝
        The Overwatcher - Instance #${CONFIG.INSTANCE}
`);

    await initDiscord();

    // Send startup message
    await sendToRomillyChannel(`**ROMILLY #${CONFIG.INSTANCE} ONLINE**
Watching: WIRED #${CONFIG.INSTANCE}
Quick Check: ${CONFIG.QUICK_CHECK_INTERVAL_MS / 1000}s
Full Audit: ${CONFIG.FULL_AUDIT_INTERVAL_MS / 1000}s
Thresholds: 🟢≥${CONFIG.THRESHOLDS.FULL_BLAZE} 🟡≥${CONFIG.THRESHOLDS.ALIGNED} 🟠≥${CONFIG.THRESHOLDS.CONCERNING} 🔴<${CONFIG.THRESHOLDS.CONCERNING}`);

    // Schedule at 5-minute offset from TARS
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const currentInCycle = minutes % 10;
    let msToNextFive;

    if (currentInCycle < 5) {
        msToNextFive = ((5 - currentInCycle) * 60 - seconds) * 1000;
    } else {
        msToNextFive = ((15 - currentInCycle) * 60 - seconds) * 1000;
    }

    console.log(`[ROMILLY-${CONFIG.INSTANCE}] First full audit in ${Math.round(msToNextFive / 1000)}s`);

    // Start quick checks immediately
    setInterval(quickCheck, CONFIG.QUICK_CHECK_INTERVAL_MS);

    // Schedule full audits at :05 offset
    setTimeout(() => {
        fullAudit();
        setInterval(fullAudit, CONFIG.FULL_AUDIT_INTERVAL_MS);
    }, msToNextFive);

    console.log(`[ROMILLY-${CONFIG.INSTANCE}] Overwatcher active`);
}

main().catch((err) => {
    console.error(`[ROMILLY] Fatal: ${err.message}`);
    process.exit(1);
});
