#!/usr/bin/env node

/**
 * KnowledgeBase CLI — talks directly to cws-kb
 * (https://git.coco.xyz/coco-workspace/cws-kb).
 *
 * Paths and shapes match the live cws-kb code today (routes under
 * /api/v1/orgs/{org_id}/*). The cws-kb api-usage-guide describes a
 * future surface under /api/v1/kb/* with X-Org-Id header; that's
 * forward-looking — we'll migrate when cws-kb's transport flips.
 *
 * Status legend:
 *   ✅  cws-kb has the route in code today
 *   ⏳  in cws-kb's api-design / usage-guide but not yet wired in code
 *
 * org_id source: config.org_id or COCO_ORG_ID env (set at install time).
 *
 * Usage:
 *   node src/cli/kb.js <command> '<json-params>'
 *   node src/cli/kb.js kb.search '{"query":"周会纪要","limit":10}'
 */

import { kbClient } from '../lib/client.js';
import { uploadMedia } from './as.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

/**
 * Build the org-scoped path prefix once per CLI call. The client also
 * sends X-Org-Id, but cws-kb's current routes consume org_id from the
 * URL — both work.
 */
function orgPath(suffix, orgId) {
  const oid = orgId || process.env.COCO_ORG_ID;
  if (!oid && !(kbClient().headers['X-Org-Id'])) {
    throw new Error('org_id is required (set config.org_id or COCO_ORG_ID)');
  }
  const id = oid || kbClient().headers['X-Org-Id'];
  return `/api/v1/orgs/${id}${suffix}`;
}

const COMMANDS = {
  // ============================================================================
  //  KB collection
  // ============================================================================

  // ✅ Initialize an Org's KB (idempotent — used during onboarding)
  'kb.init': () => kbClient().post('/api/v1/kbs/init', {
    org_id: params.orgId || params.org_id,
  }),

  // ✅ List Org's KBs / configurations
  'kb.list': () => kbClient(params.orgId).get(orgPath('/kbs', params.orgId), {
    status: params.status,    // active|archived|all
  }),

  // ✅ Archive / unarchive
  'kb.archive':   () => kbClient(params.orgId).post(orgPath('/kbs/archive', params.orgId)),
  'kb.unarchive': () => kbClient(params.orgId).post(orgPath('/kbs/unarchive', params.orgId)),

  // ============================================================================
  //  Directory tree
  // ============================================================================

  // ✅ Top-level roots (e.g. /shared, /projects, /templates)
  'kb.tree_roots': () => kbClient(params.orgId).get(orgPath('/tree/roots', params.orgId)),

  // ✅ All folders (flat list)
  'kb.tree_folders': () => kbClient(params.orgId).get(orgPath('/tree/folders', params.orgId)),

  // ✅ Single node metadata
  'kb.node_get': () => kbClient(params.orgId).get(
    orgPath(`/tree/nodes/${params.nodeId}`, params.orgId),
  ),

  // ✅ Ancestor chain (root → node)
  'kb.node_breadcrumb': () => kbClient(params.orgId).get(
    orgPath(`/tree/nodes/${params.nodeId}/breadcrumb`, params.orgId),
  ),

  // ✅ Direct children of a folder (lazy load)
  'kb.node_children': () => kbClient(params.orgId).get(
    orgPath(`/tree/nodes/${params.parentId || params.nodeId}/children`, params.orgId),
    { page_size: params.pageSize ?? params.limit, page_token: params.pageToken ?? params.cursor },
  ),

  // ✅ Move node (change parent)
  'kb.node_move': () => kbClient(params.orgId).post(
    orgPath(`/tree/nodes/${params.nodeId}/move`, params.orgId),
    { parent_id: params.parentId, sort_order: params.sortOrder },
  ),

  // ✅ Rename node
  'kb.node_rename': () => kbClient(params.orgId).post(
    orgPath(`/tree/nodes/${params.nodeId}/rename`, params.orgId),
    { name: params.name || params.title },
  ),

  // ============================================================================
  //  Pages
  // ============================================================================

  // ✅ List pages
  'kb.pages': () => kbClient(params.orgId).get(orgPath('/pages', params.orgId), {
    parent_id:  params.parentId,
    page_size:  params.pageSize ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  // ✅ Single page metadata
  'kb.page_get': () => kbClient(params.orgId).get(
    orgPath(`/pages/${params.pageId}`, params.orgId),
  ),

  // ✅ Page content (body + front_matter)
  'kb.page_content': () => kbClient(params.orgId).get(
    orgPath(`/pages/${params.pageId}/content`, params.orgId),
  ),

  // ✅ Revision list
  'kb.page_revisions': () => kbClient(params.orgId).get(
    orgPath(`/pages/${params.pageId}/revisions`, params.orgId),
    { page_size: params.pageSize ?? params.limit, page_token: params.pageToken ?? params.cursor },
  ),

  // ✅ Single revision
  'kb.page_revision': () => kbClient(params.orgId).get(
    orgPath(`/pages/${params.pageId}/revisions/${params.revisionId}`, params.orgId),
  ),

  // ✅ Diff between revisions (returns line-diff)
  'kb.page_diff': () => kbClient(params.orgId).post(
    orgPath(`/pages/${params.pageId}/diff`, params.orgId),
    { from_revision_id: params.fromRevisionId, to_revision_id: params.toRevisionId },
  ),

  // ✅ Restore a previous revision (creates new revision with old content)
  'kb.page_restore': () => kbClient(params.orgId).post(
    orgPath(`/pages/${params.pageId}/restore-version`, params.orgId),
    { revision_id: params.revisionId, commit_message: params.commitMessage },
  ),

  // ⏳ Page create — described in api-usage-guide §3 but not in cws-kb code yet
  //                  Path follows the doc's target (with X-Org-Id header carrying org)
  'kb.page_create': () => kbClient(params.orgId).post(
    orgPath('/pages', params.orgId),
    {
      title:          params.title,
      parent_id:      params.parentId,
      format:         params.format || 'markdown',
      content:        params.content,             // {body, front_matter?}
      commit_message: params.commitMessage,
    },
  ),

  // ⏳ Page update with optimistic concurrency (base_revision_id check)
  'kb.page_update': () => kbClient(params.orgId).put(
    orgPath(`/pages/${params.pageId}`, params.orgId),
    {
      content:           params.content,         // {body, front_matter?}
      base_revision_id:  params.baseRevisionId,
      commit_message:    params.commitMessage,
    },
  ),

  // ⏳ Page delete (soft-delete)
  'kb.page_delete': () => kbClient(params.orgId).del(
    orgPath(`/pages/${params.pageId}`, params.orgId),
  ),

  // ============================================================================
  //  Search (Meilisearch + NATS event-driven indexing)
  // ============================================================================

  // ✅ Full-text search across pages
  'kb.search': () => kbClient(params.orgId).get(
    orgPath('/search/pages', params.orgId),
    {
      query:       params.query || params.q,
      folder_id:   params.folderId,
      author_id:   params.authorId,
      format:      params.format,
      page_size:   params.pageSize ?? params.limit,
      page_token:  params.pageToken ?? params.cursor,
      sync:        params.sync,                  // true → wait for Meilisearch task (Agent flow)
    },
  ),

  // ============================================================================
  //  Cross-resource relations (KB ↔ Project / Issue / etc.)
  // ============================================================================

  // ✅ List or create a relation
  'kb.relations_list':   () => kbClient(params.orgId).get(orgPath('/relations', params.orgId), {
    resource_type: params.resourceType,
    resource_id:   params.resourceId,
    target_type:   params.targetType,
    target_id:     params.targetId,
  }),
  'kb.relations_create': () => kbClient(params.orgId).post(orgPath('/relations', params.orgId), {
    resource_type: params.resourceType,
    resource_id:   params.resourceId,
    target_type:   params.targetType,
    target_id:     params.targetId,
    role:          params.role,
  }),
  // ✅ Check if a relation exists (returns boolean / decision)
  'kb.relations_check':  () => kbClient(params.orgId).get(orgPath('/relations/check', params.orgId), {
    resource_type: params.resourceType,
    resource_id:   params.resourceId,
    target_type:   params.targetType,
    target_id:     params.targetId,
  }),

  // ============================================================================
  //  File attachment to KB — delegates to as.js (single upload pipeline)
  // ============================================================================

  // ✅ Upload a file via cws-as, then (TODO when wired) attach to a KB node.
  //    Right now this just goes through as.uploadMedia(), and the caller is
  //    responsible for referencing the returned mediaId from a page body.
  'kb.upload': () => {
    if (!params.filePath) throw new Error('filePath is required');
    return uploadMedia(params.filePath, {
      mediaType:   params.mediaType || 'file',
      mimeType:    params.contentType,
      description: params.description,
      metadata:    { ...(params.metadata || {}), kb_attach: params.nodeId || params.pageId },
    });
  },
};

function printUsage() {
  console.log(`KB CLI — cws-kb operations

Usage: node src/cli/kb.js <command> '<json-params>'

KB collection
  ✅ kb.init             {orgId?}
  ✅ kb.list             {orgId?, status?}                    # status: active|archived|all
  ✅ kb.archive          {orgId?}
  ✅ kb.unarchive        {orgId?}

Directory tree
  ✅ kb.tree_roots       {orgId?}
  ✅ kb.tree_folders     {orgId?}
  ✅ kb.node_get         {nodeId, orgId?}
  ✅ kb.node_breadcrumb  {nodeId, orgId?}
  ✅ kb.node_children    {parentId, orgId?, pageSize?, pageToken?}
  ✅ kb.node_move        {nodeId, parentId, sortOrder?, orgId?}
  ✅ kb.node_rename      {nodeId, name, orgId?}

Pages
  ✅ kb.pages            {parentId?, orgId?, pageSize?, pageToken?}
  ✅ kb.page_get         {pageId, orgId?}
  ✅ kb.page_content     {pageId, orgId?}
  ✅ kb.page_revisions   {pageId, orgId?, pageSize?, pageToken?}
  ✅ kb.page_revision    {pageId, revisionId, orgId?}
  ✅ kb.page_diff        {pageId, fromRevisionId, toRevisionId, orgId?}
  ✅ kb.page_restore     {pageId, revisionId, commitMessage?, orgId?}
  ⏳ kb.page_create      {title, parentId, format?, content:{body, front_matter?}, commitMessage?, orgId?}
  ⏳ kb.page_update      {pageId, content, baseRevisionId, commitMessage?, orgId?}
  ⏳ kb.page_delete      {pageId, orgId?}

Search (Meilisearch + NATS)
  ✅ kb.search           {query, folderId?, authorId?, format?, pageSize?, pageToken?, sync?, orgId?}
                         # sync=true → wait for index update (Agent write-then-read)

Relations
  ✅ kb.relations_list   {resourceType?, resourceId?, targetType?, targetId?, orgId?}
  ✅ kb.relations_create {resourceType, resourceId, targetType, targetId, role, orgId?}
  ✅ kb.relations_check  {resourceType, resourceId, targetType, targetId, orgId?}

File attachment (delegates to as.uploadMedia)
  ✅ kb.upload           {filePath, mediaType?, contentType?, description?, nodeId?, pageId?, orgId?}

Environment:
  COCO_KB_URL        cws-kb base URL (default: comm.kb_url in config)
  COCO_AUTH_TOKEN    Bearer token (shared with cws-core / cws-as)
  COCO_ORG_ID        Override config.org_id (X-Org-Id scope header + path)
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
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
