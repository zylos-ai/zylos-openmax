# CLAUDE.md

Development guidelines for zylos-workspace.

## Project Conventions

- **ESM only** — Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** — Minimum runtime version, use native `fetch` for HTTP requests
- **Zero unnecessary dependencies** — HTTP via native fetch, only `ws` for WebSocket and `dotenv` for env loading
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`

## Architecture

This is a **workspace integration plugin** for the Zylos agent ecosystem.

### Communication Module (PM2 service)

- `src/comm-bridge.js` — Entry point, WebSocket connection to cws-comm, bridges messages to C4
- `src/lib/ws.js` — WebSocket connection management (reconnect, heartbeat, message dispatch)
- `src/lib/message.js` — Message parsing and formatting (COCO Message → C4 format)
- `src/lib/media.js` — Media file download and upload
- `src/lib/config.js` — Configuration loader with hot-reload
- `src/lib/client.js` — Shared HTTP client (native fetch + auth)
- `scripts/send.js` — C4 standard outbound interface

### Service CLIs (stateless, JSON in/out)

- `src/cli/tm.js` — Task Management operations
- `src/cli/kb.js` — KnowledgeBase operations
- `src/cli/as.js` — ArtifactStore operations
- `src/cli/comm.js` — Communication operations (proactive messaging)
- `src/cli/core.js` — Organization/team/agent queries

All CLIs follow the same pattern: `node <cli>.js <command> '<json>'`, output JSON to stdout, errors to stderr with exit code 1.

### Skill Layer (progressive loading)

- `SKILL.md` — Layer 1+2: role detection + Lead/Worker lifecycle (always loaded)
- `skills/*-operations.md` — Layer 3: per-service operation guides (loaded on demand)

### Team Ownership

Each service team contributes a pair of files: `src/cli/xx.js` + `skills/xx-operations.md`.

## Release Process

Update version in both `package.json` and `SKILL.md` frontmatter in the same commit.

## References

- [DESIGN.md](./DESIGN.md) — Full architecture documentation
- [zylos-lark](../zylos-lark/) — Reference implementation for communication plugin pattern
- [Agent Skill Spec](../cws-work/docs/skill-design/agent-skill-spec.md) — Behavioral specification
- [KB/AS Operations Reference](../cws-work/docs/skill-design/kb-as-operations-reference.md) — KB/AS operation patterns
