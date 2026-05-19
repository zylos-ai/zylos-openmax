# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-19

### Added

- Project structure and directory layout
- Communication module: `comm-bridge.js` (WebSocket to C4 bridge) skeleton
- Service CLIs: `cli/{tm,kb,as,comm,core}.js` skeletons (stateless, JSON in/out)
- Skill layer: `SKILL.md` (L1+L2) + `references/*-operations.md` (L3 on demand)
- Shared infrastructure: `lib/{client,config,ws,message,media}.js`
- Design document `DESIGN.md` v0.2
