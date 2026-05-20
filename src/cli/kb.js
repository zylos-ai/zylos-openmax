#!/usr/bin/env node

/**
 * KnowledgeBase CLI.
 *
 * Wraps /api/v1/knowledge-bases/* on cws-core. **Every endpoint here is
 * currently ⏳** — cws-core's OpenAPI does not yet expose any KB routes.
 * Commands are kept so the agent surface is ready when core adds them;
 * calls 404 today.
 *
 * Usage:
 *   node src/cli/kb.js <command> '<json-params>'
 *
 * Status legend:
 *   ⏳  not exposed by cws-core yet (call will 404)
 *
 * File upload delegates to as.js (uploadMedia) so there is one canonical
 * upload path in the codebase.
 */

import { get, post, patch, put, del, apiPath } from '../lib/client.js';
import { uploadMedia } from './as.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // KB collection
  'kb.list':    () => get(apiPath('/knowledge-bases'), {
    tab:    params.tab,
    q:      params.q,
    cursor: params.cursor,
    limit:  params.limit,
  }),
  'kb.get':     () => get(apiPath(`/knowledge-bases/${params.kbId}`)),
  'kb.create':  () => post(apiPath('/knowledge-bases'), {
    name:        params.name,
    description: params.description,
    team_id:     params.teamId,
    icon:        params.icon,
  }),
  'kb.archive': () => post(apiPath(`/knowledge-bases/${params.kbId}/archive`)),
  'kb.restore': () => post(apiPath(`/knowledge-bases/${params.kbId}/restore`)),

  // Nodes (folders + pages share the node model)
  'kb.tree':    () => get(apiPath(`/knowledge-bases/${params.kbId}/tree`)),
  'kb.nodes':   () => get(apiPath(`/knowledge-bases/${params.kbId}/nodes`), {
    parent_id: params.parentId,
    cursor:    params.cursor,
    limit:     params.limit,
  }),
  'kb.node_create': () => post(apiPath(`/knowledge-bases/${params.kbId}/nodes`), {
    parent_id: params.parentId,
    kind:      params.kind,                  // 'folder' | 'page'
    title:     params.title,
    icon:      params.icon,
  }),
  'kb.node_get':    () => get(apiPath(`/knowledge-bases/${params.kbId}/nodes/${params.nodeId}`)),
  'kb.node_update': () => patch(apiPath(`/knowledge-bases/${params.kbId}/nodes/${params.nodeId}`), {
    title:     params.title,
    parent_id: params.parentId,
    icon:      params.icon,
  }),
  'kb.node_delete': () => del(apiPath(`/knowledge-bases/${params.kbId}/nodes/${params.nodeId}`)),

  // Page content
  'kb.read':  () => get(apiPath(`/knowledge-bases/${params.kbId}/pages/${params.pageId}`)),
  'kb.write': () => put(apiPath(`/knowledge-bases/${params.kbId}/pages/${params.pageId}`), {
    title:           params.title,
    content:         params.content,
    content_format:  params.contentFormat,    // 'markdown' | 'html' | ...
    commit_message:  params.commitMessage,
    base_version:    params.baseVersion,      // for optimistic-concurrency on PUT
  }),

  // File attachment — delegates to as.js's canonical uploadMedia().
  // The kbId acts as the access-scoping key (instead of a conversation_id).
  // ⏳ until core exposes either /knowledge-bases/{id}/files or
  //   /media/upload — uploadMedia hits the latter.
  'kb.upload': () => {
    if (!params.filePath) throw new Error('filePath is required');
    if (!params.kbId)     throw new Error('kbId is required');
    return uploadMedia(params.filePath, {
      conversationId: params.kbId,        // re-use the scoping field name
      mediaType:      params.mediaType || 'file',
      mimeType:       params.contentType,
    });
  },
};

function printUsage() {
  console.log(`KB CLI — KnowledgeBase for COCO agents

Usage: node src/cli/kb.js <command> '<json-params>'

⚠ Every kb.* command below is ⏳ — cws-core's OpenAPI has no
   /knowledge-bases endpoints yet. Calls will 404 today. The surface
   is kept so the agent code is ready when core adds the KB domain.

KB collection
  ⏳ kb.list          {tab?, q?, cursor?, limit?}
  ⏳ kb.get           {kbId}
  ⏳ kb.create        {name, description?, teamId?, icon?}
  ⏳ kb.archive       {kbId}
  ⏳ kb.restore       {kbId}

Nodes (folders + pages share the node model)
  ⏳ kb.tree          {kbId}
  ⏳ kb.nodes         {kbId, parentId?, cursor?, limit?}
  ⏳ kb.node_create   {kbId, parentId?, kind, title, icon?}     # kind: folder|page
  ⏳ kb.node_get      {kbId, nodeId}
  ⏳ kb.node_update   {kbId, nodeId, title?, parentId?, icon?}
  ⏳ kb.node_delete   {kbId, nodeId}

Page content
  ⏳ kb.read          {kbId, pageId}
  ⏳ kb.write         {kbId, pageId, title?, content, contentFormat?, commitMessage?, baseVersion?}

File attachment (delegates to as.js → uploadMedia)
  ⏳ kb.upload        {kbId, filePath, mediaType?, contentType?}

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_AUTH_TOKEN    Bearer token
  COCO_API_PREFIX    Path prefix override (default: /api/v1)

Not yet planned in any core spec (design intent only):
  kb.search          # semantic search
  kb.history         # page revision history
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
