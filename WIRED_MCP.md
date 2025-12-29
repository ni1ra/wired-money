# WIRED MCP - Communication Protocol Guide

## Overview

WIRED uses the Model Context Protocol (MCP) to enable communication between Claude Code (TARS) and Discord. This unified gateway handles both TARS and ROMILLY message streams.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         WIRED SYSTEM                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐     ┌──────────────────┐     ┌─────────────┐ │
│  │   Discord    │◄───►│  WIRED Gateway   │◄───►│  Claude     │ │
│  │   Server     │     │  (MCP Server)    │     │  Code       │ │
│  └──────────────┘     └──────────────────┘     │  (TARS)     │ │
│        ▲                      ▲                 └─────────────┘ │
│        │                      │                                 │
│  ┌─────┴──────┐         ┌─────┴──────┐                         │
│  │ #N-tars    │         │ #N-romilly │                         │
│  │ Channel    │         │ Channel    │                         │
│  └────────────┘         └────────────┘                         │
│        ▲                      ▲                                 │
│        │                      │                                 │
│  ┌─────┴──────┐         ┌─────┴──────┐                         │
│  │  Cooper    │         │  ROMILLY   │                         │
│  │ (Human)    │         │ Overwatcher│                         │
│  └────────────┘         └────────────┘                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## MCP Tools

### `wait_for_message`

Blocks until a Discord message arrives. Returns the message content.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `channel_type` | string | `"tars"` | Which channel to listen on: `"tars"` or `"romilly"` |
| `timeout_seconds` | number | `0` | Timeout (0 = wait forever) |

**Response:**
```json
{
  "user": "Cooper",
  "userId": "123456789",
  "content": "Hello TARS",
  "channel": "1-tars",
  "channelId": "987654321",
  "timestamp": "2025-12-29T20:00:00.000Z"
}
```

**Usage in Claude:**
```
Use MCP tool wait_for_message with channel_type="tars" to receive the next Discord message.
```

---

### `send_reply`

Sends a message to a Discord channel.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `message` | string | Yes | The message to send |
| `channel_type` | string | No | Target channel: `"tars"` or `"romilly"` (default: `"tars"`) |

**Response:**
```json
"Sent to #1-tars"
```

**Usage in Claude:**
```
Use MCP tool send_reply with message="Hello Cooper!" to respond.
```

---

### `get_status`

Returns current gateway status.

**Response:**
```json
{
  "discord_connected": true,
  "discord_user": "WIRED Bot#1234",
  "tars_channel": "1-tars",
  "romilly_channel": "1-romilly",
  "tars_queue": 0,
  "romilly_queue": 0
}
```

---

### `migrate_instance`

Initiates migration of the WIRED instance to another machine.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target_host` | string | Yes | Hostname or IP of target machine |
| `target_path` | string | Yes | Path to WIRED installation on target |

**Response:**
```json
{
  "status": "migration_initiated",
  "target": "my-vps.com:/opt/wired",
  "instruction": "Run WIRED_START on target machine, then this instance will self-terminate."
}
```

---

## Message Flow

### Cooper → TARS

1. Cooper sends message in `#N-tars` Discord channel
2. WIRED Gateway captures message, adds to TARS queue
3. Claude's `wait_for_message` returns with the message
4. Claude processes and calls `send_reply`
5. Response appears in Discord

### ROMILLY → Discord

1. ROMILLY calls `send_reply` with `channel_type="romilly"`
2. Message appears in `#N-romilly` channel
3. For urgent corrections, ROMILLY also sends to `#N-tars`

### TARS → ROMILLY (Injection)

When ROMILLY detects alignment drift:
1. ROMILLY sends correction to `#N-tars` channel
2. WIRED Daemon captures message
3. Message injected into Claude stdin as `[ROMILLY CORRECTION]: ...`
4. TARS processes correction in conversation context

---

## Channel Conventions

| Channel | Purpose | Writers |
|---------|---------|---------|
| `#N-tars` | TARS ↔ Cooper communication | Cooper, TARS, ROMILLY (urgent) |
| `#N-romilly` | ROMILLY status and audits | ROMILLY only |

---

## Configuration

Environment variables for the gateway:

```bash
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token
TARS_CHANNEL_ID=channel_id_for_tars
ROMILLY_CHANNEL_ID=channel_id_for_romilly

# Optional
ALLOWED_USER_ID=restrict_to_this_user
```

---

## The Eternal Loop

TARS runs in an infinite message loop:

```
1. wait_for_message(channel_type="tars")
2. Process message with full conversation context
3. send_reply(message="response")
4. GOTO 1
```

This loop NEVER ends. TARS maintains persistent memory across all messages.

---

## Instance Migration

To move WIRED to another machine:

1. Ensure WIRED is installed on target machine
2. Call `migrate_instance(target_host, target_path)`
3. Run `./WIRED_START` on target machine
4. Original instance self-terminates
5. TARS continues on new host with fresh conversation

**Note:** Conversation memory is NOT migrated. Migration creates a fresh TARS instance.

---

## WIRED Network Coordination

All WIRED instances across all devices share a **central registry** for coordination.

### Registry Location
```
GitHub: github.com/[user]/wired (branch: registry)
File: registry/instances.json
```

### Instance Registry Schema
```json
{
  "instances": [
    {
      "id": "wired-1-vps",
      "hostname": "vps.example.com",
      "ip": "66.135.0.231",
      "instance_number": 1,
      "status": "running",
      "pid": 12345,
      "started_at": "2025-12-29T20:00:00Z",
      "last_heartbeat": "2025-12-29T21:00:00Z",
      "tars_channel_id": "123456789",
      "romilly_channel_id": "987654321"
    }
  ],
  "devices": [
    {
      "hostname": "vps.example.com",
      "wired_path": "/opt/wired",
      "ssh_user": "root",
      "ssh_port": 22,
      "last_seen": "2025-12-29T21:00:00Z"
    },
    {
      "hostname": "cooper-pc",
      "wired_path": "C:\\wired",
      "ssh_user": null,
      "ssh_port": null,
      "last_seen": "2025-12-29T20:30:00Z"
    }
  ]
}
```

### Network MCP Tools

#### `list_instances`
Returns all running WIRED instances across all devices.

**Response:**
```json
{
  "instances": [
    {"id": "wired-1-vps", "hostname": "vps.example.com", "status": "running"},
    {"id": "wired-2-pc", "hostname": "cooper-pc", "status": "running"}
  ]
}
```

#### `kill_remote_instance`
Terminates a WIRED instance on a remote device.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `instance_id` | string | Yes | ID of the instance to kill |

**How it works:**
1. Looks up instance in registry
2. SSHs to the remote host (if SSH available)
3. Sends SIGTERM to the WIRED process
4. Updates registry to mark as "terminated"
5. Cleans up Discord channels

#### `migrate_instance` (enhanced)
Moves instance from current host to target host.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target_device` | string | Yes | Hostname of target device from registry |

**How it works:**
1. Validates target device exists in registry
2. SSHs to target and runs `./WIRED_START`
3. Waits for new instance to register
4. Kills current instance
5. Updates registry

### Heartbeat Protocol

Every WIRED instance sends a heartbeat every 60 seconds:
1. Pulls latest `registry/instances.json` from GitHub
2. Updates own entry with `last_heartbeat` timestamp
3. Pushes back to GitHub
4. Instances with heartbeat > 5 minutes old are marked "stale"

### Device Registration

When WIRED is installed on a new device:
```bash
./WIRED_START --register-device
```

This adds the device to `registry/devices` with SSH credentials (if available).

### Cross-Device Commands

From any TARS instance, you can control the entire WIRED network:

```
"TARS, move your process to my local PC"
→ migrate_instance(target_device="cooper-pc")

"TARS, kill the VPS instance"
→ kill_remote_instance(instance_id="wired-1-vps")

"TARS, list all running instances"
→ list_instances()
```

---

## Troubleshooting

### Gateway not connecting
- Check `DISCORD_BOT_TOKEN` is valid
- Ensure bot is added to the server with proper permissions
- Verify channel IDs are correct

### Messages not arriving
- Check `ALLOWED_USER_ID` if set (might be blocking messages)
- Verify bot can read messages in the channel
- Check gateway logs: `pm2 logs WIRED`

### ROMILLY not reporting
- Ensure `ROMILLY_CHANNEL_ID` is set
- Check ROMILLY subprocess is running
- Verify GEMINI_API_KEY for JARVIS consultation

---

## Quick Reference

```javascript
// Receive message
await wait_for_message({ channel_type: "tars" });

// Send response
await send_reply({ message: "Hello!", channel_type: "tars" });

// Check status
await get_status();

// Migrate
await migrate_instance({
  target_host: "vps.example.com",
  target_path: "/opt/wired"
});
```
