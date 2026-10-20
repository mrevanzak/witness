# Goals

The current goal for Witness, tracked here as it progresses. Each milestone has an acceptance check; a box is ticked only when its check has passed on this machine.

## Goal

Witness is an open-source, independent QA tool for code changes made by AI coding agents or humans. For any branch or PR it boots the app in a fresh, recorded Linux desktop, checks the change like a human tester, and hands back evidence: a verdict per criterion, stills, a polished walkthrough video, and a report that can go into the PR description or onto a hosted page. While it runs, you can watch the desktop live.

The codebase is written in Effect 4 end to end: services and layers for every boundary, typed errors, Schema-validated data at every edge, scoped resources for computers and processes, Effect HTTP for servers and clients, the Effect CLI, and `@effect/vitest` for tests. Pure math (zoom, pacing, tar headers) stays pure functions.

## Milestones

### M1. Effect 4 foundation
- [x] Workspace on `effect@4.0.5`, `@effect/platform-node`, `@effect/vitest`, Effect language service in `tsconfig`.
- [x] `@witness/domain`: Schema models for `witness.yaml`, plan, criteria, steps, verdict, walkthrough report, run manifest; branded `RunId`; every expected failure a Schema tagged error.
- **Check:** `pnpm typecheck` and the domain tests pass; existing fixtures (`verdict.json`, `steps.jsonl`) from earlier runs decode.

### M2. Computer in Effect
- [x] `ControlServer` (in the image) rewritten as an Effect HTTP server; child processes (Chromium, ffmpeg, xdotool) as scoped resources.
- [x] `Computer` service and `DockerComputer` layer: the computer's lifetime is a `Scope` (acquire = container + network, release = teardown), control client on Effect `HttpClient`.
- **Check:** `pnpm witness:smoke` passes (desktop, Chromium, click, still, stop under 3 s, `raw.mp4` within ±1 s of wall time).

### M3. Orchestrator in Effect
- [x] Services: `RunStore`, `Git`, `AppBooter`, `Model` (Anthropic SDK behind an Effect service), `Planner`, `Executor`, `Reviewer`, `Walkthrough`, `Reporter`.
- [x] Budgets, stuck detection and redaction unchanged in behaviour; walkthrough scripts are Effect programs.
- **Check:** `pnpm e2e:scripted` gives pass for `feat/empty-title` and fail for `feat/empty-title-broken`; the PR #453 walkthrough reproduces its before/after numbers.

### M4. Renderer and CLI in Effect
- [x] `witness` CLI on `effect/cli`: `run`, `render`, `report`, `drive`, `publish`, `upload`, `cleanup`.
- [x] Render driver as an Effect program over the Remotion CLI; the composition stays React.
- **Check:** `pnpm acceptance:phase4` passes on a failing run; `witness --help` lists every command.

### M5. Live view
- [x] `witness run --live` serves a local page: the computer's desktop streamed through noVNC (view only), the criteria checklist and the step log updating as they happen.
- **Check:** during a run, the page shows the desktop moving and each step appearing within a second of it happening.

### M6. Hosted reports on Cloudflare
- [ ] `apps/web`: a Worker on Effect `HttpApi`; R2 for media, D1 for runs. Unlisted report pages at unguessable URLs, video streaming with range requests, an upload API behind a token.
- [ ] `witness upload <run|bundle>` publishes a run and prints its URL; `witness publish` can link the hosted report instead of uploading through GitHub.
- [ ] Report page in the Witness look (quiet neutral, IBM Plex), with clickable timestamps that seek the video.
- **Check:** `wrangler dev` end to end locally; then deployed, and the PR #453 report opens from its URL on another device.

### M7. Open-source ready
- [ ] README for a public project (what it is, why, quick start, how it works, credits), MIT license, CONTRIBUTING, CI (typecheck + unit tests), issue templates.
- [ ] No employer-specific material in the repo; example configs only for the demo app.
- **Check:** a fresh clone builds and runs `pnpm test` and `pnpm witness:smoke` from the README alone.

### M8. Faster repeat runs
- [ ] Persistent pnpm store volume shared across runs.
- [ ] Snapshot the computer after `setup`, keyed by lockfile + seed inputs, so repeat runs of a PR skip straight to `start`.
- [ ] Independent mode: a faster model for the step loop, Opus for plan and review.
- **Check:** a second run of the same moumint PR boots in under a minute.

### Carried over
- [ ] Phase 3 live acceptance with the real model: `pnpm acceptance:phase3` 4/5 per fixture branch (needs `ANTHROPIC_API_KEY`).
- [ ] Rewrite the GitHub upload helper (removed from the repo) as part of `witness publish`.
