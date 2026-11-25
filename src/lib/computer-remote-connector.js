// Workspace desktop enrollment is a control-plane operation. The Comm frame
// only wakes this Agent; Core authenticates the current operation before a
// component or pairing credential can be changed.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { publicBaseUrlFromEnv, resolveAgentBaseUrl } from './agent-domain.js';

const CHANNEL = 'computer-remote';
const SERVICE = 'zylos-computer-remote';
const AGENT_PATH = '/v1/workspace-enrollment';
const CORE_PATH = '/connect/computer-use/connections';
const TIMEOUT = 15_000;
const HIDE_RPC_BODY = { sensitiveBody: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_NIL = '00000000-0000-0000-0000-000000000000';
const exec = promisify(execFile);
const validId = (value) => typeof value === 'string' && UUID.test(value) && value !== UUID_NIL;

export const isComputerRemoteCommand = (data) => data?.channel_type === CHANNEL;

function localError(message, status) {
  return Object.assign(new Error(message), { status });
}

function readLocalFile(dir, name, fsDep) {
  const fd = fsDep.openSync(path.join(dir, name), fsDep.constants.O_RDONLY | fsDep.constants.O_NOFOLLOW);
  try {
    const stat = fsDep.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 256 ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Computer Remote credentials are not private');
    }
    return fsDep.readFileSync(fd, 'utf8').trim();
  } finally {
    fsDep.closeSync(fd);
  }
}

/** No automatic redirects, proxies, public destination, or credential logging. */
export function createComputerRemoteLocalClient({
  dataDir = process.env.COMPUTER_REMOTE_DATA_DIR || path.join(os.homedir(), 'zylos/components', CHANNEL),
  fsDep = fs,
  request = http.request,
} = {}) {
  return async (method, route, body) => {
    const token = readLocalFile(dataDir, 'agent.token', fsDep);
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('Invalid Computer Remote local token');
    let port = 3805;
    try {
      const portText = readLocalFile(dataDir, 'agent.port', fsDep);
      if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
        throw new Error('Invalid Computer Remote local port');
      }
      port = Number(portText);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          'X-Computer-Remote-Token': token,
          ...(payload === undefined ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
        },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024) res.destroy(new Error('Oversized Computer Remote response'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(localError('Computer Remote request refused', res.statusCode));
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('Invalid Computer Remote response')); }
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  };
}

function remoteBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Computer Remote public URL must be HTTPS');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/computer-remote`;
  return url.href;
}

function createPublicBaseResolver({ getForOrg, apiPath, env }) {
  return async (orgId) => {
    const result = await resolveAgentBaseUrl({
      getFn: (route) => getForOrg(orgId, route, undefined, { timeoutMs: TIMEOUT }),
      apiPathFn: apiPath,
      env: { ...env, AGENT_PUBLIC_BASE_URL: publicBaseUrlFromEnv({ env }) || '' },
    });
    if (!result.ok) throw new Error('Agent public URL unavailable');
    return result.base_url;
  };
}

function validDevicePublicKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length !== 124) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
      key.export({ type: 'spki', format: 'der' }).toString('base64') === encoded;
  } catch { return false; }
}

function payloadOf(response) {
  return response?.data ?? response;
}

function finalPlatformError(error) {
  return [400, 403, 404, 409, 410, 422].includes(error?.status);
}

export function createComputerRemoteConnector({
  getForOrg,
  postForOrg,
  apiPath,
  env = process.env,
  resolvePublicBase = createPublicBaseResolver({ getForOrg, apiPath, env }),
  remote = createComputerRemoteLocalClient(),
  fetchImpl = fetch,
  execFile = exec,
  now = Date.now,
  wait = sleep,
  persistConnectedCheck = () => {},
  log = () => {},
  warn = () => {},
}) {
  const running = new Map();
  let ensureInFlight;

  async function componentInfo() {
    let result;
    try {
      result = await execFile('zylos', ['info', CHANNEL, '--json'], { timeout: TIMEOUT });
    } catch (error) {
      if (String(error?.stderr || '').trim() === 'Error: Component "computer-remote" is not installed.') return null;
      throw new Error('Computer Remote installation status unavailable');
    }
    const info = JSON.parse(String(result.stdout));
    if (info?.name !== CHANNEL || info.service?.name !== SERVICE) {
      throw new Error('Computer Remote service identity is invalid');
    }
    return info;
  }

  async function ensureService() {
    if (!ensureInFlight) ensureInFlight = (async () => {
      const info = await componentInfo();
      if (!info) {
        await execFile('zylos', ['add', CHANNEL, '--yes'], { timeout: 180_000 });
      } else if (info.service.status === 'stopped') {
        await execFile('pm2', ['restart', SERVICE], { timeout: TIMEOUT });
      }
      // An already-online service is never restarted or automatically upgraded.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if ((await remote('GET', '/v1/health'))?.ok === true) return;
        } catch { /* A just-installed service may still be starting. */ }
        if (attempt < 4) await wait(1000);
      }
      throw new Error('Computer Remote did not become healthy');
    })().finally(() => { ensureInFlight = null; });
    return ensureInFlight;
  }

  const coreRoute = ({ bindingId }, suffix) => apiPath(`${CORE_PATH}/${bindingId}/${suffix}`);
  const post = (meta, suffix, body) => postForOrg(meta.orgId, coreRoute(meta, suffix),
    { request_id: meta.requestId, ...body }, {
      timeoutMs: TIMEOUT, ...HIDE_RPC_BODY,
    });
  const localPayload = (meta) => ({ connection_id: meta.bindingId, request_id: meta.requestId });

  async function input(meta, action) {
    const response = payloadOf(await getForOrg(meta.orgId, coreRoute(meta, `${action}-input`),
      { request_id: meta.requestId }, {
        timeoutMs: TIMEOUT, quietStatuses: [404, 409, 410], ...HIDE_RPC_BODY,
      }));
    if (response?.connection_id !== meta.bindingId || response?.request_id !== meta.requestId ||
        response?.agent_member_id !== meta.memberId) {
      throw new Error('Computer Use core operation identity mismatch');
    }
    return response;
  }

  async function probePublic(base) {
    const response = await fetchImpl(`${base}/device/v1/ws`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
    });
    if (response.status !== 426) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Computer Remote public route unavailable');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024) throw new Error('Invalid Computer Remote public route response');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body?.error !== 'upgrade_required') throw new Error('Computer Remote public route is not a device lane');
  }

  async function failPrepare(meta, phase) {
    // Raw subprocess, HTTP, URL and upstream errors could carry credentials.
    await post(meta, 'prepare-result', { ok: false, error: phase });
  }

  async function prepare(meta) {
    const initial = await input(meta, 'prepare');
    if (!validDevicePublicKey(initial.public_key) || typeof initial.device_name !== 'string' ||
        !initial.device_name || initial.device_name.length > 120) {
      await failPrepare(meta, 'invalid_prepare_input');
      return;
    }

    let base;
    try { base = remoteBase(await resolvePublicBase(meta.orgId)); }
    catch { await failPrepare(meta, 'public_url_unavailable'); return; }
    // Resolve may wait on Core; confirm the operation again before installation.
    const current = await input(meta, 'prepare');
    if (current.public_key !== initial.public_key || current.device_name !== initial.device_name) return;

    try { await ensureService(); }
    catch { await failPrepare(meta, 'remote_unavailable'); return; }
    try { await probePublic(base); }
    catch { await failPrepare(meta, 'public_route_unavailable'); return; }

    // Installation and the public probe may outlive a revoke or timeout.
    const prepared = await input(meta, 'prepare');
    if (prepared.public_key !== initial.public_key || prepared.device_name !== initial.device_name) return;

    let result;
    try {
      result = await remote('POST', AGENT_PATH, {
        ...localPayload(meta), public_key: prepared.public_key, device_name: prepared.device_name,
      });
    } catch (error) {
      // Transport failures leave the issuance outcome unknown. Keep the same
      // operation for Connect's repush so Remote can answer idempotently.
      if (error?.status === 404) await failPrepare(meta, 'remote_enrollment_unsupported');
      if (error?.status === 410) await failPrepare(meta, 'enrollment_expired');
      return;
    }
    if (typeof result?.ticket !== 'string' || !/^[a-zA-Z0-9_-]{32,512}$/.test(result.ticket) ||
        typeof result.expires_at !== 'string' || !(Date.parse(result.expires_at) > now())) {
      await remote('POST', `${AGENT_PATH}/discard`, localPayload(meta)).catch(() => {});
      await failPrepare(meta, 'invalid_remote_enrollment');
      return;
    }
    // Record metadata before reporting the ticket. A service restart or a
    // lost result reply cannot strand an already-paired device unreported.
    if (await persistConnectedCheck({ ...meta, kind: 'computer-connected', status: 'pending' }) === false) {
      await remote('POST', `${AGENT_PATH}/discard`, localPayload(meta)).catch(() => {});
      await failPrepare(meta, 'receipt_storage_unavailable');
      return;
    }
    try {
      await post(meta, 'prepare-result', {
        ok: true, remote_url: base, ticket: result.ticket, expires_at: result.expires_at,
      });
      log(`computer-remote prepare reported binding=${meta.bindingId}`);
    } catch (error) {
      if (finalPlatformError(error)) {
        // Compensate this exact unconsumed request only, never a different
        // ticket or an already-paired device.
        await remote('POST', `${AGENT_PATH}/discard`, localPayload(meta)).catch(() => {});
      }
      // Non-final responses may have committed the result. Connect either
      // repushes the same operation or our connected reconciliation follows.
      warn(`computer-remote prepare result not confirmed binding=${meta.bindingId}`);
    }
  }

  async function revoke(meta) {
    await input(meta, 'revoke');
    const result = await remote('POST', `${AGENT_PATH}/revoke`, localPayload(meta));
    if (result?.revoked !== true) throw new Error('Computer Remote revocation is not confirmed');
    await post(meta, 'revoke-ack', {});
    log(`computer-remote revocation confirmed binding=${meta.bindingId}`);
  }

  async function verifyConnected(meta) {
    if (!validId(meta.orgId) || !validId(meta.bindingId) || !validId(meta.requestId)) return;
    const query = new URLSearchParams(localPayload(meta));
    let result;
    try { result = await remote('GET', `${AGENT_PATH}?${query}`); }
    catch (error) {
      if (error?.status === 410) return;
      throw new Error('Computer Remote enrollment status unavailable');
    }
    if (result?.state === 'revoked') return;
    if (result?.state !== 'paired' || result.online !== true || !validId(result.device_id)) {
      throw new Error('Waiting for a verified Computer Remote handshake');
    }
    try {
      await post(meta, 'connected', { device_id: result.device_id });
    } catch (error) {
      if (!finalPlatformError(error)) throw new Error('Computer Use connected report unavailable');
    }
  }

  async function handleCommand(orgConfig, frame) {
    const data = frame?.payload?.data;
    if (!isComputerRemoteCommand(data) || !['prepare', 'revoke'].includes(data.action)) return;
    const meta = { orgId: orgConfig?.org_id, memberId: orgConfig?.self?.member_id,
      bindingId: data.binding_id, requestId: data.request_id };
    if (!Object.values(meta).every(validId) || data.agent_member_id !== meta.memberId ||
        (data.org_id && data.org_id !== meta.orgId)) return;
    meta.slug = orgConfig.slug;
    const key = `${meta.orgId}:${meta.bindingId}`;
    const previous = running.get(key);
    const command = `${data.action}:${meta.requestId}`;
    if (previous?.command === command) return previous.promise;
    const promise = (previous?.promise || Promise.resolve()).then(async () => {
      try { await (data.action === 'prepare' ? prepare(meta) : revoke(meta)); }
      catch (error) {
        if (!finalPlatformError(error)) warn(`computer-remote command not confirmed binding=${meta.bindingId}`);
      }
    }).finally(() => {
      if (running.get(key)?.promise === promise) running.delete(key);
    });
    running.set(key, { command, promise });
    return promise;
  }

  return { handleCommand, verifyConnected };
}
