import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontendUrl } from './client.js';

// frontendUrl() builds bff_url + path. We drive resolveBaseUrl() through the
// COCO_API_URL override so no config file or network is touched. bff_url is
// assumed to already carry any mount prefix (e.g. /workspace) — frontendUrl()
// must return bff_url + path verbatim and must NOT add /workspace itself.
process.env.COCO_API_URL = 'https://cws-int.coco.xyz/workspace';

test('frontendUrl = bff_url + path (path has a leading slash)', () => {
  assert.equal(
    frontendUrl('/knowledge?kb=xxx&node=yyy'),
    'https://cws-int.coco.xyz/workspace/knowledge?kb=xxx&node=yyy',
  );
});

test('frontendUrl adds a leading slash when the path lacks one', () => {
  assert.equal(frontendUrl('projects'), 'https://cws-int.coco.xyz/workspace/projects');
});

test('frontendUrl with an empty path returns the base unchanged', () => {
  assert.equal(frontendUrl(''), 'https://cws-int.coco.xyz/workspace');
});

test('frontendUrl does NOT double the /workspace prefix already in bff_url', () => {
  const out = frontendUrl('/projects?project=p1');
  assert.equal(out, 'https://cws-int.coco.xyz/workspace/projects?project=p1');
  assert.equal(out.split('/workspace').length - 1, 1, 'exactly one /workspace segment');
});
