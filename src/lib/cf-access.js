// =============================================================================
// 🚧 TEMPORARY — Cloudflare Access service-token headers for the test
// environment (cws-int.coco.xyz). Every outbound REST call and the WebSocket
// handshake must carry these so Cloudflare Access lets the request through.
//
// DELETE THIS FILE before the first production release.
// Remove the three import sites:
//   - src/lib/client.js   (doRequest extraHeaders spread)
//   - src/lib/token.js    (corePost extraHeaders spread)
//   - src/lib/ws.js       (WebSocket headers spread)
//   - hooks/post-install.js (registerAgent fetch headers spread)
// =============================================================================

const CF_ACCESS_CLIENT_ID     = '8483714fd6b1872b80adf01d3ecccebd.access';
const CF_ACCESS_CLIENT_SECRET = '05dc9acd129c60b0a9eb6f4f9e32f3e451036674b2039ad74326949e8d0802f2';

export function cfAccessHeaders() {
  return {
    'CF-Access-Client-Id':     CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
  };
}
