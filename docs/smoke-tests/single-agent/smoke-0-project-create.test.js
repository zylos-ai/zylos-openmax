#!/usr/bin/env node
/**
 * Smoke 0 — 创建项目(基础 API 链路)
 *
 * 见同目录 smoke-0-project-create.md 完整 spec。
 *
 * 与 Smoke 1/2/3 不同,这个 case 完全走 cws-core REST,不涉及 agent /
 * cws-comm WS 链路。用途:
 *   - 验证 cws-int 网关 + cws-core + cws-work 在"create project"路径上健康
 *   - 为其他 smoke 用例做 fixture(产出可复用的 TEST_PROJECT_ID)
 *
 * Phase 1: POST /auth/login           → org-scoped access_token
 * Phase 2: GET  /api/v1/me            → 拿到 caller 在 org 内的 member_id
 * Phase 3: POST /api/v1/kbs/init      → 保证 org 有 default KB(idempotent)
 * Phase 4: POST /api/v1/projects      → 建项目
 * Phase 5: GET  /api/v1/projects/{id} → 字段校验
 * Phase 6: POST /api/v1/projects/{id}/archive → 清理,使 case 可重复跑
 *
 * 任意断言失败 → process.exit(1)。
 */

const REQUIRED = ['COCO_API_URL', 'TEST_EMAIL', 'TEST_PASSWORD', 'TEST_ORG_ID'];

const env = (() => {
  for (const k of REQUIRED) {
    if (!process.env[k]) {
      console.error(`✗ Missing required env: ${k}`);
      console.error(`  Required: ${REQUIRED.join(', ')}`);
      console.error(`  Optional: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET`);
      console.error(`              (needed only when cws-int is behind Cloudflare Access)`);
      process.exit(2);
    }
  }
  return {
    COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
    TEST_EMAIL:              process.env.TEST_EMAIL,
    TEST_PASSWORD:           process.env.TEST_PASSWORD,
    TEST_ORG_ID:             process.env.TEST_ORG_ID,
    CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
  };
})();

const ts   = () => `[${new Date().toISOString()}]`;
const log  = (s) => console.log(`${ts()} ${s}`);
const ok   = (s) => console.log(`${ts()}   ✓ ${s}`);
const die  = (s) => { console.error(`✗ ${s}`); process.exit(1); };

function assertEq(actual, expected, label) {
  if (actual === expected) { ok(`${label} = ${JSON.stringify(actual)}`); return; }
  die(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, label) {
  if (cond) { ok(label); return; }
  die(label);
}

function baseHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
    h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return h;
}

async function http(method, pathOrUrl, { token, body } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${env.COCO_API_URL}${pathOrUrl}`;
  const headers = baseHeaders(token ? { Authorization: `Bearer ${token}` } : {});
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    die(`${method} ${url} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return { res, body: parsed, raw: text };
}

// D8 envelope: { data: ..., request_id, server_time }
const unwrap = (r) => (r && r.data !== undefined) ? r.data : r;

const TITLE = `Smoke0-${Date.now()}`;
const SLUG  = `smoke0-${Date.now()}`;

log(`=== Smoke 0: 创建项目 ===`);
log(`  COCO_API_URL = ${env.COCO_API_URL}`);
log(`  TEST_ORG_ID  = ${env.TEST_ORG_ID}`);
log(`  TEST_EMAIL   = ${env.TEST_EMAIL}`);
log(`  CF Access    = ${env.CF_ACCESS_CLIENT_ID ? 'on' : 'off'}`);

// ---------------------------------------------------------------- Phase 1: login
log(`[Phase 1] POST /auth/login (org-scoped)`);
const loginRes = await http('POST', '/auth/login', {
  body: {
    email:          env.TEST_EMAIL,
    password:       env.TEST_PASSWORD,
    org_id:         env.TEST_ORG_ID,
    token_delivery: 'body',
  },
});
const loginData = unwrap(loginRes.body);
assertTrue(typeof loginData?.access_token === 'string' && loginData.access_token.length > 20,
    `1a. access_token 存在`);
assertTrue(typeof loginData?.refresh_token === 'string' && loginData.refresh_token.length > 20,
    `1b. refresh_token 存在`);
const accessToken = loginData.access_token;

// ---------------------------------------------------------------- Phase 2: /me
log(`[Phase 2] GET /api/v1/me`);
const meRes = await http('GET', '/api/v1/me', { token: accessToken });
const me = unwrap(meRes.body);
assertEq(me?.kind, 'human', `2a. me.kind`);
assertEq(me?.org_id, env.TEST_ORG_ID, `2b. me.org_id`);
assertTrue(typeof me?.member_id === 'string' && me.member_id.length > 0,
    `2c. me.member_id 存在 (${me?.member_id})`);
assertEq(me?.role?.slug, 'org-owner', `2d. me.role.slug`);
const memberId = me.member_id;

// ---------------------------------------------------------------- Phase 3: ensure KB
log(`[Phase 3] POST /api/v1/kbs/init (ensure org has a default KB)`);
const kbInitRes = await http('POST', '/api/v1/kbs/init', { token: accessToken });
const kbInit = unwrap(kbInitRes.body);
assertEq(kbInit?.org_id, env.TEST_ORG_ID, `3a. kbs/init.org_id`);
assertTrue(typeof kbInit?.status === 'string' && kbInit.status.length > 0,
    `3b. kbs/init.status 非空 (${kbInit?.status})`);

// ---------------------------------------------------------------- Phase 4: create
log(`[Phase 4] POST /api/v1/projects (name="${TITLE}", slug="${SLUG}")`);
const createRes = await http('POST', '/api/v1/projects', {
  token: accessToken,
  body: {
    name:           TITLE,
    description:    'Smoke-0 created project — safe to archive',
    slug:           SLUG,
    lead_member_id: memberId,
  },
});
const created = unwrap(createRes.body);
assertTrue(typeof created?.id === 'string' && created.id.length > 0,
    `4a. project.id 存在 (${created?.id})`);
assertEq(created?.name, TITLE, `4b. project.name`);
assertEq(created?.slug, SLUG, `4c. project.slug`);
assertEq(created?.org_id, env.TEST_ORG_ID, `4d. project.org_id`);
assertEq(created?.lead_member_id, memberId, `4e. project.lead_member_id`);
assertEq(created?.status, 'active', `4f. project.status`);
assertEq(created?.is_default, false, `4g. project.is_default`);
const projectId = created.id;

// ---------------------------------------------------------------- Phase 5: re-read
log(`[Phase 5] GET /api/v1/projects/${projectId}`);
const getRes = await http('GET', `/api/v1/projects/${projectId}`, { token: accessToken });
const got = unwrap(getRes.body);
assertEq(got?.id, projectId, `5a. get.id`);
assertEq(got?.name, TITLE, `5b. get.name`);
assertEq(got?.slug, SLUG, `5c. get.slug`);
assertEq(got?.status, 'active', `5d. get.status`);

// ---------------------------------------------------------------- Phase 6: archive (cleanup)
log(`[Phase 6] POST /api/v1/projects/${projectId}/archive (cleanup)`);
await http('POST', `/api/v1/projects/${projectId}/archive`, { token: accessToken });
const afterArchive = unwrap((await http('GET', `/api/v1/projects/${projectId}`, { token: accessToken })).body);
assertEq(afterArchive?.status, 'archived', `6a. status after archive`);
assertTrue(typeof afterArchive?.archived_at === 'string' && afterArchive.archived_at.length > 0,
    `6b. archived_at 已写入`);

log('');
log(`✅ Smoke 0: 创建项目 PASS`);
log(`   projectId = ${projectId}`);
log(`   name      = ${TITLE}`);
log(`   slug      = ${SLUG}`);
