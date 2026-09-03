#!/usr/bin/env node

/**
 * Conversation-channel connection tool.
 *
 * This is deliberately separate from conn.js: conn.* authorizes third-party
 * accounts the Agent can operate, while channel.connect attaches an IM ingress
 * (Feishu, Lark, DingTalk, or WeCom) to the Agent itself.
 *
 * Usage:
 *   node src/cli/channel.js channel.connect '{"channelType":"feishu","conversationId":"...","sourceMessageId":"..."}'
 *
 * The QR and session handle are consumed inside this process and never printed
 * to stdout (which is model-visible). The tool publishes a generic structured
 * QR card message and starts a detached, bounded poller that posts the terminal
 * result back into the same conversation.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { apiPath, postForOrg } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';
import { RUNTIME_DIR } from '../lib/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SEND_SCRIPT = path.join(ROOT, 'scripts/send.js');
const TOOL_SCRIPT = fileURLToPath(import.meta.url);
const STATE_DIR = path.join(RUNTIME_DIR, 'channel-connect');
const POLL_INTERVAL_MS = 3000;
const MAX_TOOL_SESSION_SEC = 5 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_CHANNELS = Object.freeze({
  feishu: { displayName: '飞书' },
  lark: { displayName: 'Lark' },
  dingtalk: { displayName: '钉钉' },
  wecom: { displayName: '企业微信' },
});

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function planChannelConnect(input = {}) {
  const channelType = String(input.channelType || input.channel_type || '').trim().toLowerCase();
  const conversationId = String(input.conversationId || input.conversation_id || '').trim();
  const sourceMessageId = String(input.sourceMessageId || input.source_message_id || '').trim();
  if (!PLATFORM_CHANNELS[channelType]) {
    throw bad(`channelType must be one of: ${Object.keys(PLATFORM_CHANNELS).join(', ')}`);
  }
  if (!UUID_RE.test(conversationId)) throw bad('conversationId must be a UUID from <message-context>');
  if (!sourceMessageId) throw bad('sourceMessageId is required from <message-context>');
  return {
    channelType,
    conversationId,
    sourceMessageId,
    body: {
      channel_type: channelType,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
    },
  };
}

export function buildChannelQRMessage(channelType, qrRef, expiresAt) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel) throw bad(`unsupported channel type: ${channelType}`);
  if (typeof qrRef !== 'string' || !qrRef.trim()) {
    throw new Error('channel connection service returned no QR reference');
  }
  const display = {
    schema: 'openmax.channel-qr.v1',
    channel_type: channelType,
    qr_ref: qrRef.trim(),
    expires_at: expiresAt,
  };
  return {
    client_msg_id: randomUUID(),
    type: 'AGENT_STRUCTURED',
    content: {
      content_type: 'channel_qr',
      body: display,
      attachments: [],
    },
    // cws-comm deliberately trims structured bodies from the list hot path.
    // Keep the small display projection in metadata so chat history can render
    // the QR card without issuing one GetMessage request per card.
    metadata: { openmax_channel_qr: display },
    fallback_text: `${channel.displayName}授权二维码（请尽快扫码）`,
  };
}

function requireOrgId(input) {
  const orgId = input.org || input.orgId || input.org_id || resolveDefaultOrgId();
  if (!orgId) throw bad('cannot resolve org; pass org from <org-context>');
  return orgId;
}

function ensurePrivateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
}

function writePrivate(filePath, data, encoding) {
  fs.writeFileSync(filePath, data, { encoding, mode: 0o600, flag: 'wx' });
}

function sendToConversation(orgId, conversationId, message) {
  const result = spawnSync(process.execPath, [SEND_SCRIPT, conversationId, message], {
    env: { ...process.env, COCO_ORG_ID: orgId, COCO_RPC_LOG: '0' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'send failed').trim();
    throw new Error(`failed to send channel status to conversation: ${detail}`);
  }
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function statePathForToken(token) {
  if (!UUID_RE.test(token)) throw bad('invalid watcher token');
  return path.join(STATE_DIR, `${token}.json`);
}

export function channelStatusMessage(channelType, terminal) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel) throw bad(`unsupported channel type in watcher state: ${channelType}`);
  if (terminal === 'connected') {
    return `✅ ${channel.displayName}连接成功，现在可以收发消息。`;
  }
  if (terminal === 'expired') {
    return `${channel.displayName}授权二维码已过期。需要时在聊天里重新说“连接${channel.displayName}”即可。`;
  }
  if (terminal === 'cancelled') {
    return `${channel.displayName}授权已取消。需要时可以在聊天里重新发起。`;
  }
  return `${channel.displayName}渠道连接失败，请在聊天里重新发起；如果仍失败再查看服务日志。`;
}

export function channelStartResultWithoutQR(channelType, result) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel) throw bad(`unsupported channel type: ${channelType}`);
  const status = String(result?.status || '').trim().toLowerCase();
  if (status === 'already_connected') {
    return {
      status,
      channel_type: channelType,
      qr_sent_to_conversation: false,
      message: `${channel.displayName}已连接，无需重复扫码。`,
    };
  }
  if (status === 'connection_in_progress') {
    return {
      status,
      channel_type: channelType,
      qr_sent_to_conversation: false,
      message: `${channel.displayName}正在连接中，无需重复扫码，请稍候。`,
    };
  }
  return null;
}

export function isRetryableChannelPollError(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status)) return true;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function pollChannelUntilTerminal({ deadlineMs, poll, sleep, now = Date.now }) {
  let authorizationCompleted = false;
  while (now() < deadlineMs) {
    try {
      const result = await poll();
      const status = String(result?.status || 'error').toLowerCase();
      if (status === 'pending') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (status === 'connected') {
        authorizationCompleted = true;
        // Provider "connected" only means the QR authorization produced
        // credentials. cws-connect creates a pending Binding and dispatches
        // the upgrade/config/restart command to OpenMAX afterwards. Do not
        // notify the user until OpenMAX reports that command completed and
        // cws-connect promotes the Binding to connected.
        const bindingStatus = String(result?.binding?.status || '').toLowerCase();
        if (bindingStatus === 'connected') return 'connected';
        if (bindingStatus === 'pending') {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        return 'error';
      }
      if (['expired', 'cancelled', 'error'].includes(status)) return status;
      return 'error';
    } catch (error) {
      if (!isRetryableChannelPollError(error)) return 'error';
      if (now() >= deadlineMs) break;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  // Keep the existing single deadline for Phase 1. Once authorization has
  // completed, a deadline means the dispatched component operation did not
  // report success in time; it is not a QR-expired outcome.
  return authorizationCompleted ? 'error' : 'expired';
}

async function connect(input) {
  const plan = planChannelConnect(input);
  const orgId = requireOrgId(input);
  const result = await postForOrg(
    orgId,
    apiPath('/agent-tools/channel-connections'),
    plan.body,
    { timeoutMs: 30_000, quietOnSuccess: true },
  );
  const noQRResult = channelStartResultWithoutQR(plan.channelType, result);
  if (noQRResult) return noQRResult;
  if (!result?.qr_ref || !result?.session_handle) {
    throw new Error('channel connection service returned no QR session');
  }

  ensurePrivateDir();
  const token = randomUUID();
  const statePath = statePathForToken(token);
  const effectiveExpiresSec = Math.min(
    MAX_TOOL_SESSION_SEC,
    Math.max(1, Number(result.expires_in_sec) || 300),
  );
  const expiresAt = new Date(Date.now() + effectiveExpiresSec * 1000).toISOString();
  writePrivate(statePath, JSON.stringify({
    orgId,
    channelType: plan.channelType,
    conversationId: plan.conversationId,
    sourceMessageId: plan.sourceMessageId,
    sessionHandle: result.session_handle,
    deadlineMs: Date.now() + effectiveExpiresSec * 1000,
  }), 'utf8');

  try {
    await postForOrg(
      orgId,
      apiPath(`/conversations/${plan.conversationId}/messages`),
      buildChannelQRMessage(plan.channelType, result.qr_ref, expiresAt),
      { timeoutMs: 30_000, quietOnSuccess: true },
    );
  } catch (error) {
    safeUnlink(statePath);
    throw error;
  }

  const child = spawn(process.execPath, [TOOL_SCRIPT, 'channel._watch', JSON.stringify({ token })], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, COCO_RPC_LOG: '0' },
  });
  child.unref();

  // stdout is read by the Agent. Deliberately exclude qr_png_base64,
  // session_handle, auth_url, and local file paths.
  return {
    status: 'awaiting_user_scan',
    channel_type: plan.channelType,
    qr_sent_to_conversation: true,
    expires_in_sec: effectiveExpiresSec,
  };
}

async function watch(input) {
  const statePath = statePathForToken(String(input.token || ''));
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { status: 'watcher_state_missing' };
  }

  let terminal = 'expired';
  try {
    terminal = await pollChannelUntilTerminal({
      deadlineMs: state.deadlineMs,
      poll: () => postForOrg(
          state.orgId,
          apiPath('/agent-tools/channel-connections/poll'),
          {
            channel_type: state.channelType,
            conversation_id: state.conversationId,
            source_message_id: state.sourceMessageId,
            session_handle: state.sessionHandle,
          },
          { timeoutMs: 30_000, quietOnSuccess: true },
        ),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });

    const text = channelStatusMessage(state.channelType, terminal);
    try { sendToConversation(state.orgId, state.conversationId, text); } catch {}
    return { status: terminal };
  } finally {
    safeUnlink(statePath);
  }
}

const commands = {
  'channel.connect': connect,
  'channel._watch': watch,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  let input = {};
  try {
    input = rest.length ? JSON.parse(rest.join(' ')) : {};
    const handler = commands[command];
    if (!handler) throw bad(`unknown command: ${command || '(missing)'}`);
    const result = await handler(input);
    console.log(JSON.stringify(result));
  } catch (error) {
    const out = { error: error.message || String(error) };
    if (error.status) out.status = error.status;
    console.error(JSON.stringify(out));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL_SCRIPT) {
  main();
}
