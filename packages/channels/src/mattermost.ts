#!/usr/bin/env node
/**
 * Mattermost Client for TinyAGI
 * Connects via WebSocket for incoming DMs, sends responses via REST API.
 * Does NOT call agents directly — that's handled by the queue processor.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { ensureSenderPaired, genId } from '@tinyagi/core';
import { createSSEClient } from './sse-client';
import { applyDefaultAgent } from './default-agent';

const API_PORT = parseInt(process.env.TINYAGI_API_PORT || '3777', 10);
const API_BASE = `http://localhost:${API_PORT}`;

const SCRIPT_DIR = path.resolve(__dirname, '..', '..');
const TINYAGI_HOME = process.env.TINYAGI_HOME
    || path.join(require('os').homedir(), '.tinyagi');
const LOG_FILE = path.join(TINYAGI_HOME, 'logs/mattermost.log');
const SETTINGS_FILE = path.join(TINYAGI_HOME, 'settings.json');
const FILES_DIR = path.join(TINYAGI_HOME, 'files');
const PAIRING_FILE = path.join(TINYAGI_HOME, 'pairing.json');

// Ensure directories exist
[path.dirname(LOG_FILE), FILES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Validate required env vars
const MATTERMOST_BOT_TOKEN = process.env.MATTERMOST_BOT_TOKEN;
if (!MATTERMOST_BOT_TOKEN || MATTERMOST_BOT_TOKEN === 'your_token_here') {
    console.error('ERROR: MATTERMOST_BOT_TOKEN is not set');
    process.exit(1);
}

const MATTERMOST_URL = (process.env.MATTERMOST_URL || '').replace(/\/+$/, '');
if (!MATTERMOST_URL) {
    console.error('ERROR: MATTERMOST_URL is not set (e.g. https://mattermost.example.com)');
    process.exit(1);
}

const MM_API = `${MATTERMOST_URL}/api/v4`;
const MM_WS_URL = `${MATTERMOST_URL.replace(/^http/, 'ws')}/api/v4/websocket`;

const MM_HEADERS: Record<string, string> = {
    'Authorization': `Bearer ${MATTERMOST_BOT_TOKEN}`,
    'Content-Type': 'application/json',
};

let botUserId = '';

// ── Utilities ────────────────────────────────────────────────────────────────

function sanitizeFileName(fileName: string): string {
    const baseName = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    return baseName.length > 0 ? baseName : 'file.bin';
}

function buildUniqueFilePath(dir: string, preferredName: string): string {
    const cleanName = sanitizeFileName(preferredName);
    const ext = path.extname(cleanName);
    const stem = path.basename(cleanName, ext);
    let candidate = path.join(dir, cleanName);
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}_${counter}${ext}`);
        counter++;
    }
    return candidate;
}

function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (url.startsWith('https') ? https.get(url, handleResponse) : http.get(url, handleResponse));

        function handleResponse(response: http.IncomingMessage): void {
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    fs.unlinkSync(destPath);
                    downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
                    return;
                }
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }

        request.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

function getTeamListText(): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const teams = settings.teams;
        if (!teams || Object.keys(teams).length === 0) {
            return 'No teams configured.\n\nCreate a team with `tinyagi team add`.';
        }
        let text = '**Available Teams:**\n';
        for (const [id, team] of Object.entries(teams) as [string, any][]) {
            text += `\n**@${id}** - ${team.name}`;
            text += `\n  Agents: ${team.agents.join(', ')}`;
            text += `\n  Leader: @${team.leader_agent}`;
        }
        text += '\n\nUsage: Start your message with `@team_id` to route to a team.';
        return text;
    } catch {
        return 'Could not load team configuration.';
    }
}

function getAgentListText(): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const agents = settings.agents;
        if (!agents || Object.keys(agents).length === 0) {
            return 'No agents configured. Using default single-agent mode.\n\nConfigure agents in `.tinyagi/settings.json` or run `tinyagi agent add`.';
        }
        let text = '**Available Agents:**\n';
        for (const [id, agent] of Object.entries(agents) as [string, any][]) {
            text += `\n**@${id}** - ${agent.name}`;
            text += `\n  Provider: ${agent.provider}/${agent.model}`;
            text += `\n  Directory: ${agent.working_directory}`;
            if (agent.system_prompt) text += `\n  Has custom system prompt`;
            if (agent.prompt_file) text += `\n  Prompt file: ${agent.prompt_file}`;
        }
        text += '\n\nUsage: Start your message with `@agent_id` to route to a specific agent.';
        return text;
    } catch {
        return 'Could not load agent configuration.';
    }
}

function splitMessage(text: string, maxLength = 4000): string[] {
    if (text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex <= 0) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex <= 0) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n/, '');
    }

    return chunks;
}

function pairingMessage(code: string): string {
    return [
        'This sender is not paired yet.',
        `Your pairing code: ${code}`,
        'Ask the TinyAGI owner to approve you with:',
        `tinyagi pairing approve ${code}`,
    ].join('\n');
}

// ── Mattermost REST API ──────────────────────────────────────────────────────

async function mmGet(endpoint: string): Promise<any> {
    const res = await fetch(`${MM_API}${endpoint}`, { headers: MM_HEADERS });
    if (!res.ok) throw new Error(`MM API GET ${endpoint} failed: ${res.status} ${res.statusText}`);
    return res.json();
}

async function mmPost(endpoint: string, body: any): Promise<any> {
    const res = await fetch(`${MM_API}${endpoint}`, {
        method: 'POST',
        headers: MM_HEADERS,
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MM API POST ${endpoint} failed: ${res.status} ${res.statusText}`);
    return res.json();
}

async function sendPost(channelId: string, message: string, rootId?: string): Promise<void> {
    const chunks = splitMessage(message);
    for (const chunk of chunks) {
        await mmPost('/posts', {
            channel_id: channelId,
            message: chunk,
            root_id: rootId || '',
        });
    }
}

async function uploadAndSendFile(channelId: string, filePath: string, rootId?: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;

    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    // Multipart upload: POST /api/v4/files
    const boundary = `----TinyAGI${Date.now()}`;
    const bodyParts: Buffer[] = [];

    // channel_id field
    bodyParts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="channel_id"\r\n\r\n${channelId}\r\n`
    ));

    // file field
    bodyParts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    bodyParts.push(fileData);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const multipartBody = Buffer.concat(bodyParts);

    const uploadRes = await fetch(`${MM_API}/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${MATTERMOST_BOT_TOKEN}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
    });

    if (!uploadRes.ok) {
        log('ERROR', `File upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
        return;
    }

    const uploadData = await uploadRes.json() as any;
    const fileIds = (uploadData.file_infos || []).map((f: any) => f.id);

    if (fileIds.length > 0) {
        await mmPost('/posts', {
            channel_id: channelId,
            message: '',
            root_id: rootId || '',
            file_ids: fileIds,
        });
    }
}

async function getOrCreateDMChannel(userId: string): Promise<string> {
    const channel = await mmPost('/channels/direct', [botUserId, userId]);
    return channel.id;
}

// ── Pending Messages ─────────────────────────────────────────────────────────

interface PendingMessage {
    channelId: string;
    postId: string;
    senderId: string;
    senderName: string;
    timestamp: number;
}

const pendingMessages = new Map<string, PendingMessage>();
let processingOutgoingQueue = false;

// ── WebSocket Connection ─────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let wsSeq = 1;

function connectWebSocket(): void {
    log('INFO', `Connecting WebSocket to ${MM_WS_URL}...`);
    ws = new WebSocket(MM_WS_URL);

    ws.onopen = () => {
        log('INFO', 'WebSocket connected, authenticating...');
        ws!.send(JSON.stringify({
            seq: wsSeq++,
            action: 'authentication_challenge',
            data: { token: MATTERMOST_BOT_TOKEN },
        }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(String(event.data));

            if (data.event === 'hello') {
                log('INFO', 'Mattermost WebSocket authenticated');
            } else if (data.event === 'posted') {
                handlePostedEvent(data).catch(err => {
                    log('ERROR', `Error handling posted event: ${(err as Error).message}`);
                });
            }
        } catch {
            // ignore malformed messages
        }
    };

    ws.onclose = () => {
        log('INFO', 'WebSocket closed, reconnecting in 5s...');
        setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (err) => {
        log('ERROR', `WebSocket error: ${err}`);
    };
}

// ── Message Handler ──────────────────────────────────────────────────────────

async function handlePostedEvent(wsEvent: any): Promise<void> {
    const post = JSON.parse(wsEvent.data.post);

    // Skip bot's own messages
    if (post.user_id === botUserId) return;

    // Only handle DMs
    if (wsEvent.data.channel_type !== 'D') return;

    const senderId = post.user_id;
    const senderName = wsEvent.data.sender_name?.replace(/^@/, '') || senderId;
    const messageText = post.message || '';
    const channelId = post.channel_id;

    const hasAttachments = post.file_ids && post.file_ids.length > 0;
    if (!messageText.trim() && !hasAttachments) return;

    const messageId = genId('mattermost');

    // Download any file attachments
    const downloadedFiles: string[] = [];
    if (hasAttachments) {
        for (const fileId of post.file_ids) {
            try {
                const fileInfo = await mmGet(`/files/${fileId}/info`);
                const fileName = fileInfo.name || `mattermost_${messageId}_${Date.now()}.bin`;
                const localName = `mattermost_${messageId}_${fileName}`;
                const localPath = buildUniqueFilePath(FILES_DIR, localName);

                // Download file content with auth header
                const fileRes = await fetch(`${MM_API}/files/${fileId}`, {
                    headers: { 'Authorization': `Bearer ${MATTERMOST_BOT_TOKEN}` },
                });
                if (fileRes.ok) {
                    const buffer = Buffer.from(await fileRes.arrayBuffer());
                    fs.writeFileSync(localPath, buffer);
                    downloadedFiles.push(localPath);
                    log('INFO', `Downloaded attachment: ${path.basename(localPath)}`);
                }
            } catch (dlErr) {
                log('ERROR', `Failed to download file ${fileId}: ${(dlErr as Error).message}`);
            }
        }
    }

    let msgText = messageText;

    log('INFO', `Message from ${senderName}: ${msgText.substring(0, 50)}${downloadedFiles.length > 0 ? ` [+${downloadedFiles.length} file(s)]` : ''}...`);

    // Pairing check
    const pairing = ensureSenderPaired(PAIRING_FILE, 'mattermost', senderId, senderName);
    if (!pairing.approved && pairing.code) {
        if (pairing.isNewPending) {
            log('INFO', `Blocked unpaired Mattermost sender ${senderName} (${senderId}) with code ${pairing.code}`);
            await sendPost(channelId, pairingMessage(pairing.code));
        } else {
            log('INFO', `Blocked pending Mattermost sender ${senderName} (${senderId}) without re-sending pairing message`);
        }
        return;
    }

    // Slash commands
    if (msgText.trim().match(/^[!/]agent$/i)) {
        log('INFO', 'Agent list command received');
        await sendPost(channelId, getAgentListText());
        return;
    }

    if (msgText.trim().match(/^[!/]team$/i)) {
        log('INFO', 'Team list command received');
        await sendPost(channelId, getTeamListText());
        return;
    }

    // Reset command
    const resetMatch = msgText.trim().match(/^[!/]reset\s+(.+)$/i);
    if (msgText.trim().match(/^[!/]reset$/i)) {
        await sendPost(channelId, 'Usage: `/reset @agent_id [@agent_id2 ...]`\nSpecify which agent(s) to reset.');
        return;
    }
    if (resetMatch) {
        log('INFO', 'Per-agent reset command received');
        const agentArgs = resetMatch[1].split(/\s+/).map((a: string) => a.replace(/^@/, '').toLowerCase());
        try {
            const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const settings = JSON.parse(settingsData);
            const agents = settings.agents || {};
            const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyagi-workspace');
            const resetResults: string[] = [];
            for (const agentId of agentArgs) {
                if (!agents[agentId]) {
                    resetResults.push(`Agent '${agentId}' not found.`);
                    continue;
                }
                const flagDir = path.join(workspacePath, agentId);
                if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
                fs.writeFileSync(path.join(flagDir, 'reset_flag'), 'reset');
                resetResults.push(`Reset @${agentId} (${agents[agentId].name}).`);
            }
            await sendPost(channelId, resetResults.join('\n'));
        } catch {
            await sendPost(channelId, 'Could not process reset command. Check settings.');
        }
        return;
    }

    // Restart command
    if (msgText.trim().match(/^[!/]restart$/i)) {
        log('INFO', 'Restart command received');
        await sendPost(channelId, 'Restarting TinyAGI...');
        const { exec } = require('child_process');
        exec(`"${path.join(SCRIPT_DIR, 'lib', 'tinyagi.sh')}" restart`, { detached: true, stdio: 'ignore' });
        return;
    }

    // Apply default agent routing
    const { message: routedMessage, switchNotification } = applyDefaultAgent(
        senderId, msgText, SETTINGS_FILE,
    );
    if (switchNotification) {
        await sendPost(channelId, switchNotification);
    }
    if (routedMessage === null) {
        return;
    }
    msgText = routedMessage;

    // Build message text with file references
    let fullMessage = msgText;
    if (downloadedFiles.length > 0) {
        const fileRefs = downloadedFiles.map(f => `[file: ${f}]`).join('\n');
        fullMessage = fullMessage ? `${fullMessage}\n\n${fileRefs}` : fileRefs;
    }

    // Write to queue via API
    await fetch(`${API_BASE}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            channel: 'mattermost',
            sender: senderName,
            senderId,
            message: fullMessage,
            messageId,
        }),
    });

    log('INFO', `Queued message ${messageId}`);

    // Store pending message for response matching
    pendingMessages.set(messageId, {
        channelId,
        postId: post.id,
        senderId,
        senderName,
        timestamp: Date.now(),
    });

    // Clean up old pending messages (older than 10 minutes)
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    for (const [id, data] of pendingMessages.entries()) {
        if (data.timestamp < tenMinutesAgo) {
            pendingMessages.delete(id);
        }
    }
}

// ── Response Delivery ────────────────────────────────────────────────────────

async function checkOutgoingQueue(): Promise<void> {
    if (processingOutgoingQueue) return;
    processingOutgoingQueue = true;

    try {
        const res = await fetch(`${API_BASE}/api/responses/pending?channel=mattermost`);
        if (!res.ok) return;
        const responses = await res.json() as any[];

        for (const resp of responses) {
            try {
                const responseText = resp.message;
                const messageId = resp.messageId;
                const sender = resp.sender;
                const senderId = resp.senderId;
                const files: string[] = resp.files || [];

                const pending = pendingMessages.get(messageId);
                let channelId = pending?.channelId ?? null;

                // For proactive messages, find/create DM channel
                if (!channelId && senderId) {
                    try {
                        channelId = await getOrCreateDMChannel(senderId);
                    } catch (err) {
                        log('ERROR', `Could not open DM for senderId ${senderId}: ${(err as Error).message}`);
                    }
                }

                if (channelId) {
                    // Send any attached files
                    if (files.length > 0) {
                        for (const file of files) {
                            try {
                                await uploadAndSendFile(channelId, file);
                                log('INFO', `Sent file to Mattermost: ${path.basename(file)}`);
                            } catch (fileErr) {
                                log('ERROR', `Failed to send file ${file}: ${(fileErr as Error).message}`);
                            }
                        }
                    }

                    // Send text response
                    if (responseText) {
                        await sendPost(channelId, responseText);
                    }

                    log('INFO', `Sent ${pending ? 'response' : 'proactive message'} to ${sender} (${responseText.length} chars${files.length > 0 ? `, ${files.length} file(s)` : ''})`);

                    if (pending) pendingMessages.delete(messageId);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST' });
                } else {
                    log('WARN', `No pending message for ${messageId} and no senderId, acking`);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST' });
                }
            } catch (error) {
                log('ERROR', `Error processing response ${resp.id}: ${(error as Error).message}`);
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${(error as Error).message}`);
    } finally {
        processingOutgoingQueue = false;
    }
}

// ── SSE-driven response delivery ─────────────────────────────────────────────

createSSEClient({
    port: API_PORT,
    onEvent: (eventType, data) => {
        if (eventType === 'message:done' && data.channel === 'mattermost') {
            checkOutgoingQueue();
        }
    },
    onConnect: () => {
        log('INFO', 'SSE connected — listening for responses');
        checkOutgoingQueue();
    },
});

// Refresh typing indicator every 5 seconds while messages are pending
setInterval(() => {
    for (const [, data] of pendingMessages.entries()) {
        fetch(`${MM_API}/users/${botUserId}/typing`, {
            method: 'POST',
            headers: MM_HEADERS,
            body: JSON.stringify({ channel_id: data.channelId }),
        }).catch(() => {
            // Ignore typing errors silently
        });
    }
}, 5000);

// ── Error handling & Shutdown ────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
    log('ERROR', `Unhandled rejection: ${reason}`);
});
process.on('uncaughtException', (error) => {
    log('ERROR', `Uncaught exception: ${error.message}\n${error.stack}`);
});

process.on('SIGINT', () => {
    log('INFO', 'Shutting down Mattermost client...');
    ws?.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down Mattermost client...');
    ws?.close();
    process.exit(0);
});

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    log('INFO', 'Starting Mattermost client...');
    try {
        const me = await mmGet('/users/me');
        botUserId = me.id;
        log('INFO', `Mattermost bot connected as ${me.username} (${botUserId})`);
        connectWebSocket();
    } catch (err) {
        log('ERROR', `Failed to connect to Mattermost: ${(err as Error).message}`);
        log('ERROR', `Check MATTERMOST_URL (${MATTERMOST_URL}) and MATTERMOST_BOT_TOKEN`);
        process.exit(1);
    }
}

main();
