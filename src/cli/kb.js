#!/usr/bin/env node

/**
 * KnowledgeBase CLI.
 *
 * Wraps the cws-core Gateway KB endpoints (/api/gateway/v1/knowledge-bases/*).
 * Each command maps to a single HTTP call; no business logic here.
 *
 * Usage:
 *   node src/cli/kb.js <command> '<json-params>'
 *   node src/cli/kb.js kb.list  '{"q":"growth","limit":20}'
 *   node src/cli/kb.js kb.read  '{"kbId":"kb-1","pageId":"pg-abc"}'
 *
 * Output: success → JSON to stdout, exit 0; failure → JSON error to stderr, exit 1.
 *
 * NOTE: semantic search (`kb.search`) is not yet exposed by the gateway
 * (#待确认问题). For now, locate content by KB → tree → node → page.
 */

import { get, post, patch, put, del, apiPath, upload } from '../lib/client.js';
import fs from 'fs';

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

  // File attachment (binary)
  'kb.upload': () => {
    if (!params.filePath) throw new Error('filePath is required');
    const buf  = fs.readFileSync(params.filePath);
    const name = params.filename || params.filePath.split('/').pop();
    return upload(apiPath(`/knowledge-bases/${params.kbId}/files`), {
      file: buf,
      name,
      mime: params.contentType,
      fields: {
        parent_id: params.parentId,
        title:     params.title,
      },
    });
  },
};

function printUsage() {
  console.log(`KB CLI — KnowledgeBase for COCO agents

Usage: node src/cli/kb.js <command> '<json-params>'

KB collection
  kb.list          {tab?, q?, cursor?, limit?}
  kb.get           {kbId}
  kb.create        {name, description?, teamId?, icon?}
  kb.archive       {kbId}
  kb.restore       {kbId}

Nodes (folders + pages share the node model)
  kb.tree          {kbId}
  kb.nodes         {kbId, parentId?, cursor?, limit?}
  kb.node_create   {kbId, parentId?, kind, title, icon?}     # kind: folder|page
  kb.node_get      {kbId, nodeId}
  kb.node_update   {kbId, nodeId, title?, parentId?, icon?}
  kb.node_delete   {kbId, nodeId}

Page content
  kb.read          {kbId, pageId}
  kb.write         {kbId, pageId, title?, content, contentFormat?, commitMessage?, baseVersion?}

File attachment (binary)
  kb.upload        {kbId, filePath, filename?, contentType?, parentId?, title?}

Environment:
  COCO_API_URL       Gateway base URL (default: http://127.0.0.1:8080).
  COCO_AUTH_TOKEN    Bearer token for authenticated endpoints.
  COCO_API_PREFIX    Path prefix override (default: /api/gateway/v1).
                     Set to "/api" when talking to cws-core/cws-work directly.

Not yet supported by the gateway (kept here as design intent):
  kb.search          # semantic search — pending #待确认问题
  kb.history         # page revision history — pending
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
