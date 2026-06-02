# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-06-02

### Added
- **Reconnect catch-up**: `comm-bridge.js` now invokes `POST /api/v1/sync`
  after every successful WS open, pulling any conversation events
  (`{conversation_id, message_id, seq}`) with `seq > sessionRef.last_seq`
  and dispatching them through the normal message handler. Each event
  passes through the existing message dedupe, so a message that arrives
  via both WS and sync is processed once. First-ever connect with
  `last_seq=0` is a no-op. The sync sweep is bounded to 2000 events per
  open and paged at 100; further backlog is pulled on the next reconnect
  (or via the `comm.sync` CLI). Per-org `_syncInFlight` guard prevents
  overlapping sweeps from a rapid reconnect storm.

### Changed
- On WS close code `4003` (session expired), `last_seq` is now **preserved**
  (only the token cache is invalidated). Previous behavior wiped the
  org session entirely, defeating sync catch-up after a session expiry.

## [0.1.0] - 2026-05-19

### Added

- Project structure and directory layout
- Communication module: `comm-bridge.js` (WebSocket to C4 bridge) skeleton
- Service CLIs: `cli/{tm,kb,as,comm,core}.js` skeletons (stateless, JSON in/out)
- Skill layer: `SKILL.md` (L1+L2) + `references/*-operations.md` (L3 on demand)
- Shared infrastructure: `lib/{client,config,ws,message,media}.js`
- Design document `DESIGN.md` v0.2
