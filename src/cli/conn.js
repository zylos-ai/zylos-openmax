#!/usr/bin/env node

/**
 * Connection CLI — cws-connect operations via cws-core BFF.
 *
 * Usage:
 *   node src/cli/conn.js <command> '<json-params>'
 *   node src/cli/conn.js conn.list     '{}'
 *   node src/cli/conn.js conn.acquire  '{"connectionId":"..."}'
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { apiPath, getForOrg, postForOrg } from '../lib/client.js';
import { loadConfig, enabledOrgs, resolveDefaultOrgId } from '../lib/config.js';
import { listCachedCredentials, clearCachedCredentials, readCredentialCache, saveCredentialCache } from '../lib/credential-cache.js';
import {
  readIndex, replaceIndexFromList, findConnectionByApp, findActiveConnectionsByApp, indexPathForOrg,
  readCatalog, writeCatalog, invalidateCatalog, CATALOG_TTL_MS,
} from '../lib/connect-store.js';
import { acquireCredential } from '../lib/connection-events.js';
import { invokeDirect, resolveCredential } from '../lib/direct-exec.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Operating org for the capability-cache verbs: explicit {org} wins, else the
// default/single enabled org. The index is org-scoped, so every lookup + the
// execute call must run against the same org's file, token, and member.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}

// Resolve the operating org and FAIL FAST when it can't be determined. Every
// cws-connect route below is org-scoped: cws-core requires an org-scoped JWT
// and 403s ("org membership required") on an identity-only token. A bare
// get()/post() would silently fall through to resolveDefaultOrgId(), which
// returns '' when >1 org is enabled and neither {org} nor COCO_ORG_ID is set —
// producing exactly that opaque 403. Throwing here turns "no org resolved" into
// an actionable 400 instead. Single-org / COCO_ORG_ID deployments resolve as
// before and never hit this.
function requireOrgId() {
  const orgId = resolveOrgId();
  if (!orgId) {
    throw Object.assign(
      new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'),
      { status: 400 },
    );
  }
  return orgId;
}

// Security note: this agent's own member_id for an org — the ONLY identity
// the conn.* commands below use for the cws-connect agent_member_id calls.
// There is deliberately no client-supplied override (e.g. params.agentMemberId)
// here: accepting one would let a caller impersonate a different agent's
// identity against cws-connect (a confused-deputy/IDOR risk). cws-core is
// moving to derive this server-side from the authenticated principal too, so
// even if a caller sent an override it would be ignored there as well.
function resolveSelfMemberId(orgId = resolveDefaultOrgId()) {
  const cfg = loadConfig();
  for (const [, org] of Object.entries(cfg.orgs || {})) {
    if (org.org_id === orgId && org.self?.member_id) return org.self.member_id;
  }
  const first = Object.values(cfg.orgs || {})[0];
  return first?.self?.member_id || '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// The app_actions / actions endpoints return the catalog either as a bare array
// or wrapped as { actions: [...] } depending on the BFF envelope — normalize.
function actionsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.actions)) return result.actions;
  return [];
}

// Fetch this agent's connections for an org from cws-core and rewrite that org's
// index file (org-scoped: uses the org's JWT and its own index path). The
// endpoint is always "your own" connections now (cws-core derives the caller
// from the authenticated principal, no id in the path) — agentId is accepted
// for call-site compatibility but no longer used to build the URL.
async function refreshIndex(orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  const list = await getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []), idxPath);
  return readIndex(idxPath);
}

// Resolve an application (slug or applicationId) → its connection entry within an
// org, reading that org's index first. Refreshes from conn.list once when the
// app is missing OR the cached entry lacks an applicationId — the latter happens
// in the window after a connection.authorized event (which may carry only a slug)
// before any conn.list has filled the applicationId. Without that refresh,
// conn.catalog {app} would 400 on a slug-only entry.
async function resolveConnectionForApp(app, orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  let entry = findConnectionByApp(app, idxPath);
  if (!entry || !entry.applicationId) {
    await refreshIndex(orgId, agentId);
    entry = findConnectionByApp(app, idxPath);
  }
  return entry;
}

// Format a connection createdAt (ISO string or epoch ms) as YYYY-MM-DD, or with
// second precision when `time` is set. Returns null when missing/unparseable.
function fmtCreated(ts, { time = false } = {}) {
  if (ts == null || ts === '') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return time ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

// Build a guaranteed-NON-EMPTY and guaranteed-UNIQUE human LABEL per candidate,
// so the agent can refer to same-app connections unambiguously WITHOUT ever
// exposing the raw connection_id (design §3/§5 empty-name fallback). Precedence:
//   1. display_name when non-empty;
//   2. else "<app name> · <created date>" (app name + creation time);
// then collisions (duplicate/empty display_name, same-day creations) are broken
// with finer created-time precision and, as a LAST resort, a positional ordinal
// "(1)/(2)". A raw connection_id is NEVER used as a label.
export function buildCandidateLabels(entries) {
  const list = entries || [];
  const base = list.map((e) => {
    const dn = (e.displayName || '').trim();
    if (dn) return dn;
    const appName = (`${e.name || e.slug || 'connection'}`).trim() || 'connection';
    const d = fmtCreated(e.createdAt);
    return d ? `${appName} · ${d}` : appName;
  });
  // Disambiguate each group of colliding base labels.
  const groups = new Map();
  base.forEach((l, i) => {
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  });
  const labels = base.slice();
  for (const [l, idxs] of groups) {
    if (idxs.length < 2) continue;
    const times = idxs.map((i) => fmtCreated(list[i].createdAt, { time: true }));
    const distinctTimes = times.every(Boolean) && new Set(times).size === idxs.length;
    idxs.forEach((i, n) => {
      labels[i] = distinctTimes
        ? `${l} · ${fmtCreated(list[i].createdAt, { time: true })}`
        : `${l} (${n + 1})`;
    });
  }
  // Belt-and-suspenders: enforce non-emptiness + global uniqueness.
  const used = new Set();
  return labels.map((l, i) => {
    let label = (l && l.trim()) ? l : `connection (${i + 1})`;
    if (used.has(label)) {
      let k = 2;
      while (used.has(`${label} (${k})`)) k += 1;
      label = `${label} (${k})`;
    }
    used.add(label);
    return label;
  });
}

// Build the `needs_selection` result for the >1-active-connections case. This is
// a NORMAL return value (printed to stdout, exit 0) — NOT an error — so the
// agent can act on it. i18n contract: `agent_instruction` is LANGUAGE-NEUTRAL
// English guidance telling the agent to localize its question into the USER'S
// language; it deliberately contains NO ready-made zh/en user-facing sentence.
// Each candidate carries a guaranteed-non-empty, unique `label` (built from
// display_name with a created-time fallback) — the agent refers to connections
// by label; the raw connection_id is never shown to the user, only echoed back
// on retry via `connectionId`. `display_name` still passes through as-is.
export function buildNeedsSelection(app, action, candidates) {
  const list = candidates || [];
  const labels = buildCandidateLabels(list);
  return {
    needs_selection: true,
    reason: 'multiple_connections',
    app,
    agent_instruction:
      "Multiple connections match this app. Ask the user which one to use, phrasing your "
      + "question in the USER'S language (they may write Chinese or English). Refer to each "
      + "connection by its label, never the connection_id. Then retry with the chosen connectionId.",
    candidates: list.map((e, i) => ({
      connection_id: e.id,
      label: labels[i],
      display_name: e.displayName ?? null,
      status: e.status,
    })),
    retry_hint: `conn.invoke {"connectionId":"<chosen>","action":"${action}","params":{...}}`,
  };
}

// Count-aware resolution of a conn.invoke target. Returns either { entry } (use
// it directly; entry may be null → caller 404s) or { needsSelection } (return
// it verbatim). Pure/injectable (deps: findActives, findAny, readEntryById,
// refresh) so the 0/1/>1 branching and the connectionId bypass are unit-testable
// without network or config. Branching:
//   - connectionId given → SKIP app-resolution, use that connection (refresh
//     once if it is unknown or lacks an applicationId).
//   - 0 active → refresh once (already done if the sole candidate lacked an
//     applicationId); still 0 → fall back to any (non-active, e.g. needs_reauth)
//     entry so its actionable hint surfaces, else null → 404.
//   - exactly 1 active → use it.
//   - >1 active → needs_selection (never silently pick the first).
export async function resolveInvokeEntry(
  { app, connectionId, action },
  { findActives, findAny, readEntryById, refresh },
) {
  if (connectionId) {
    let entry = readEntryById(connectionId);
    if (!entry || !entry.applicationId) {
      await refresh();
      entry = readEntryById(connectionId);
    }
    // Even if still unknown locally, honor the explicit id — cws-core re-checks
    // the connection-agent boundary server-side. applicationId stays null (the
    // direct path guards on it and errors with an actionable hint).
    return { entry: entry || { id: connectionId, status: 'active', applicationId: null, slug: null, name: null, displayName: null } };
  }

  let actives = findActives(app);
  // Refresh once when nothing matches, OR the sole candidate lacks an
  // applicationId (slug-only event before any conn.list) — mirrors the old
  // resolveConnectionForApp trigger, now count-aware (a refresh may also reveal
  // a second active, correctly routing to needs_selection).
  if (actives.length === 0 || (actives.length === 1 && !actives[0].applicationId)) {
    await refresh();
    actives = findActives(app);
  }
  if (actives.length > 1) return { needsSelection: buildNeedsSelection(app, action, actives) };
  if (actives.length === 1) return { entry: actives[0] };
  return { entry: findAny(app) || null };
}

// Return an application's action catalog, reading the cache first and filling it
// via conn.app_actions (org-scoped token) on a miss / TTL-expiry / explicit
// refresh. The catalog file is global (keyed by applicationId) since an app's
// capabilities are the same across orgs.
async function getCatalog(orgId, applicationId, { refresh = false, ttlMs = CATALOG_TTL_MS } = {}) {
  if (!refresh) {
    const cached = readCatalog(applicationId, { ttlMs });
    if (cached) return { ...cached, source: 'cache' };
  }
  const actions = actionsOf(await getForOrg(orgId, apiPath(`/connect/applications/${applicationId}/actions`)));
  const rec = writeCatalog(applicationId, actions);
  return { ...rec, source: 'fetch' };
}

// Heuristic: does an execute error look like a stale/unknown-action or
// input-schema mismatch (vs. an auth/network failure)? Used to decide whether a
// one-shot catalog refresh could help.
function looksLikeActionOrSchemaError(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  if (err.status === 400) {
    return /action|schema|param|unknown|not found|invalid|required/i.test(err.message || '');
  }
  return false;
}

const COMMANDS = {
  // List connections available to this agent.
  // Always uses the agent's own member_id (resolveSelfMemberId) — no
  // client-supplied override; see the security note above resolveSelfMemberId.
  'conn.list': () => {
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  },

  // Acquire credential for a connection.
  // Returns credential_mode + access_token (direct) or proxy_ref (proxy).
  'conn.acquire': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return postForOrg(orgId, apiPath(`/connect/connections/${connId}/credential`));
  },

  // Proxy a request through a connection.
  // NOTE: proxy-mode only; hidden from the agent surface (help text + reference
  // doc), retained here for proxy connections and future use. Not reachable via
  // conn.invoke (which does direct locally / proxy via conn.execute).
  'conn.proxy': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    return postForOrg(orgId, apiPath(`/connect/connections/${connId}/proxy`), {
      method: params.method || 'GET',
      url: params.url,
      headers: params.headers,
      body: params.body,
    });
  },

  // Discover the named actions available for a connection (action discovery).
  // Returns [{toolkit, action, method, description, params, input_schema}];
  // pair with conn.execute to invoke one by "toolkit-slug/action-name". cws-core
  // scopes discovery to the caller's own connection-agent authorization
  // boundary (derived server-side), same as conn.execute/conn.proxy.
  'conn.actions': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return getForOrg(orgId, apiPath(`/connect/connections/${connId}/actions`));
  },

  // Execute a registered named action through a connection (proxy mode:
  // cws-connect resolves the action, injects the token server-side, and calls
  // the provider — the agent needs neither the token nor the provider URL).
  // action format: "toolkit-slug/action-name" (e.g. "github-repos/list").
  // NOTE: proxy-mode only; hidden from the agent surface (help text + reference
  // doc), retained here. conn.invoke routes proxy connections through this same
  // server-side execute endpoint internally.
  'conn.execute': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    return postForOrg(orgId, apiPath(`/connect/connections/${connId}/actions/execute`), {
      action: params.action,
      params: params.params || {},
    });
  },

  // Get connection details (status, owner, scopes, etc.).
  'conn.status': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    return getForOrg(orgId, apiPath(`/connect/connections/${connId}`));
  },

  // Discover the app-keyed action catalog for an application — the full set of
  // actions the app exposes, each with its input_schema, WITHOUT needing an
  // existing connection. Returns [{toolkit, action, method, description,
  // params, input_schema}]. Unlike conn.actions (connection-scoped and gated
  // on the connection-agent authorization boundary), this is capability
  // metadata readable by any org member — use it to see what an app can do
  // before a connection exists, or to build a per-application capability cache.
  // Resolved strictly by applicationId (the BFF route keys on the path id; it
  // does not accept a slug override, so URL identity always matches the result).
  'conn.app_actions': () => {
    const appId = params.applicationId || params.application_id;
    if (!appId) throw Object.assign(new Error('applicationId is required'), { status: 400 });
    const orgId = requireOrgId();
    return getForOrg(orgId, apiPath(`/connect/applications/${appId}/actions`));
  },

  // Cache-aware, app-keyed action catalog. Reads runtime/connect/action-catalog/
  // first and fills it from conn.app_actions on a miss / TTL-expiry / {refresh}.
  // Accepts either {applicationId} directly, or {app} (slug or id) resolved via
  // the local connections index. Returns { applicationId, actions, fetchedAt,
  // source }.
  'conn.catalog': async () => {
    const orgId = requireOrgId();
    let appId = params.applicationId || params.application_id;
    if (!appId && params.app) {
      const agentId = resolveSelfMemberId(orgId);
      const entry = await resolveConnectionForApp(params.app, orgId, agentId);
      appId = entry?.applicationId || (isUuid(params.app) ? params.app : null);
    }
    if (!appId) throw Object.assign(new Error('applicationId (or a resolvable app) is required'), { status: 400 });
    return getCatalog(orgId, appId, { refresh: !!params.refresh });
  },

  // One-call app-keyed execute: resolve the connection for an application from
  // the local index (refreshing from conn.list on a miss), then run the named
  // action. This is the cache-aware entry meant for agents — it removes the
  // per-call discovery round-trip. Internally it splits on credential_mode
  // (transparent to the caller — same command, same result shape):
  //   - direct → LOCAL EGRESS: assemble the request from the local catalog's
  //     url_template + params, inject the locally-cached token (refreshing it on
  //     near-expiry / a provider 401), and call the provider from THIS host.
  //   - proxy  → server-side execute (cws-connect resolves the action, injects
  //     the token, and calls the provider; connection_agents re-checked there).
  // On an action/schema-shaped failure it invalidates the cached catalog once so
  // the next conn.catalog is fresh, then resurfaces the error.
  'conn.invoke': async () => {
    // An explicit connectionId (alias connection_id) SKIPS app-resolution and
    // targets that connection directly — the one-command retry after a
    // needs_selection prompt (the user picked, we re-invoke by id). When absent,
    // resolution is app-driven and count-aware (0/1/>1).
    const explicitConnId = params.connectionId || params.connection_id;
    const app = params.app || params.applicationId || params.application_id || params.slug;
    if (!explicitConnId && !app) throw Object.assign(new Error('app (slug or applicationId) is required unless connectionId is given'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });

    const idxPath = indexPathForOrg(orgId);
    const { entry, needsSelection } = await resolveInvokeEntry(
      { app, connectionId: explicitConnId, action: params.action },
      {
        findActives: (a) => findActiveConnectionsByApp(a, idxPath),
        findAny: (a) => findConnectionByApp(a, idxPath),
        readEntryById: (id) => readIndex(idxPath).connections[id] || null,
        refresh: () => refreshIndex(orgId, agentId),
      },
    );
    // >1 active for the app: return the candidate list (normal result, exit 0)
    // so the agent asks the user which one — never silently pick the first.
    if (needsSelection) return needsSelection;
    if (!entry) throw Object.assign(new Error(`no connection found for app "${app}" (org ${orgId}, agent ${agentId})`), { status: 404 });

    // Prefer the caller's app for messages; when they invoked by connectionId
    // (no app), fall back to the resolved slug/id so hints stay meaningful.
    const appLabel = app || entry.slug || entry.id;

    // Reject ANY non-active connection BEFORE credential resolution — for BOTH
    // the app-resolved path (a 0-active fallback may surface a blocked entry) and
    // the explicit connectionId path (app-resolution bypassed). cws-connect list
    // responses can mark a connection needs_reauth / error / expired / revoked;
    // proceeding to acquire a credential for one of these fails opaquely, or worse
    // calls the provider with a dead token. needs_reauth (incl. the normalized
    // status:"error"+needs_reauth from toEntry) gets the specific re-authorize
    // hint; any other blocked status gets a generic actionable error. A reauth_needed
    // event also clears the cached credential (see connection-events.js), so an
    // acquire could not help until a human re-authorizes anyway.
    if (entry.status && entry.status !== 'active') {
      if (entry.status === 'needs_reauth') {
        throw Object.assign(
          new Error(`connection for app "${appLabel}" needs re-authorization — its credential expired or was revoked. 请到连接页点「重新授权」，完成后重试。`),
          { status: 409 },
        );
      }
      throw Object.assign(
        new Error(`connection for app "${appLabel}" is not usable (status: ${entry.status}) — it may be expired, revoked, or in an error state. Re-authorize it on the connection page, then retry.`),
        { status: 409 },
      );
    }

    // Decide the path from the local credential cache, re-acquiring on a miss so
    // a direct connection with no cache file (authorized offline / runtime wiped
    // / conn.clear_cache) is not wrongly downgraded to proxy (which cws-connect
    // now rejects with ErrDirectNotProxyable/422). See resolveCredential.
    const { credential, mode } = await resolveCredential(
      { orgId, connectionId: entry.id, cached: readCredentialCache(entry.id) },
      {
        acquire: (oid, connId) => acquireCredential(oid, connId),
        saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
      },
    );

    if (mode === 'direct') {
      if (!entry.applicationId) {
        throw Object.assign(new Error(`cannot run direct action for app "${appLabel}": applicationId unresolved (run conn.index {refresh:true})`), { status: 400 });
      }
      try {
        // The local catalog now carries per-action url_template/headers_template;
        // direct execution assembles the request from it (never a free-form URL).
        const catalogRec = await getCatalog(orgId, entry.applicationId, {});
        return await invokeDirect(
          { orgId, connection: entry, actionSlug: params.action, params: params.params || {}, catalog: catalogRec.actions, credential },
          {
            acquire: (oid, connId) => acquireCredential(oid, connId),
            saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
          },
        );
      } catch (err) {
        // Drop the cached catalog on an action/schema mismatch OR a 422 (a catalog
        // predating url_template — direct assembly can't proceed) so the agent's
        // next conn.catalog refetches. Re-thrown as-is (no auto-retry).
        if ((looksLikeActionOrSchemaError(err) || err.status === 422) && entry.applicationId) invalidateCatalog(entry.applicationId);
        throw err;
      }
    }

    // proxy mode — server-side execute (existing behavior, unchanged).
    try {
      // Execute against the resolved connection using the SAME org's JWT — a
      // multi-org agent must not run one org's connection with another's token.
      return await postForOrg(orgId, apiPath(`/connect/connections/${entry.id}/actions/execute`), {
        action: params.action,
        params: params.params || {},
      });
    } catch (err) {
      // Stale catalog is a plausible cause of an unknown-action/schema error —
      // drop it so the agent's next conn.catalog refetches. Does not auto-retry
      // (a wrong action name won't fix itself); the error is re-thrown as-is.
      if (looksLikeActionOrSchemaError(err) && entry.applicationId) invalidateCatalog(entry.applicationId);
      throw err;
    }
  },

  // Show the local connections index for an org (observability). {refresh}
  // rebuilds it from conn.list first; {org} selects the org (default otherwise).
  'conn.index': async () => {
    const orgId = requireOrgId();
    if (params.refresh) {
      const agentId = resolveSelfMemberId(orgId);
      if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
      await refreshIndex(orgId, agentId);
    }
    const index = readIndex(indexPathForOrg(orgId));
    const connections = Object.values(index.connections);
    return { org_id: orgId, count: connections.length, connections };
  },

  // List locally cached credentials (metadata only; shared cache module).
  'conn.cached': () => {
    const entries = listCachedCredentials();
    return { count: entries.length, credentials: entries };
  },

  // Clear cached credentials (all or specific connection).
  'conn.clear_cache': () => {
    const connId = params.connectionId || params.connection_id;
    return { cleared: clearCachedCredentials(connId) };
  },
};

function printUsage() {
  console.log(`Connection CLI — cws-connect operations via cws-core BFF

Usage: node src/cli/conn.js <command> '<json-params>'

Connections
  conn.list           {}                                        # list connections available to this agent (self only)
  conn.acquire        {connectionId}                            # acquire credential (returns access_token or proxy_ref)
  conn.actions        {connectionId}                            # discover named actions for a connection
  conn.status         {connectionId}                            # get connection details (status, owner, scopes)

Applications
  conn.app_actions    {applicationId}                           # app-keyed action catalog (incl. input_schema; no connection needed)

Capability cache (runtime/connect/)
  conn.invoke         {app, action, params?}                    # app-keyed execute: resolve connection via local index → execute
                      {connectionId, action, params?}           #   or target a specific connection (skips app-resolution)
                                                                 #   >1 connections for an app → returns needs_selection (ask
                                                                 #   the user by display_name, retry with connectionId)
  conn.catalog        {app|applicationId, refresh?}             # cached action catalog (fills from conn.app_actions on miss/TTL)
  conn.index          {refresh?}                                # show the local connections index (connection → application)

Local cache
  conn.cached         {}                                        # list locally cached credentials (direct-mode tokens)
  conn.clear_cache    {connectionId?}                           # clear cached credentials (all if no connectionId)

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX  Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (node src/cli/conn.js …). Guarding this
// lets the module be imported by tests to exercise the pure helpers
// (buildNeedsSelection / resolveInvokeEntry) without executing a command.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
