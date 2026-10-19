# Decisions

Choices made where the handover left room. Newest last.

## Answers to the open questions (2026-10-19)

1. **Host:** macOS with OrbStack (arm64). Bridge IPs are not reachable from macOS, so the control server's port 7070 is published on host loopback with an ephemeral port (`127.0.0.1:<random>`) and protected by a per-run bearer token. Inside the run network it is still `computer:7070`.
2. **First stack:** moumint (Next.js + Strapi + Supabase), using the knowledge in `moumint-monorepo/.agents/verification-e2e-pr/` (the Claude-Code-driven prototype). The demo `examples/todo-app` comes first.
3. **API key:** not set yet; needed from Phase 3.
4. **Trigger:** a Claude Code skill (`skills/verify-change`) plus the CLI. The skill has two modes: `independent` (default; runs this verifier's own agent loop in Docker) and `in-session` (the Claude Code session drives the browser itself, like the prototype) for when Docker or an API key is unavailable. Both publish to the PR **description** between `<!-- ai-change-verifier:start/end -->` markers when the PR is the current user's, otherwise as a comment.
5. **Media hosting:** GitHub `user-attachments` through the PR comment box in Ego (the prototype's `github-upload.mjs`) when run from the skill on a dev machine; in a GitHub Action, the GIF/video go up as a workflow artifact linked from the description.
6. **Video frame:** the real Chromium window chrome (tabs + address bar) is recorded and kept in the polished video.

## Phase 1

- **Control server in Node, not Python.** Node 22 is in the image anyway; it shares the CDP code (`playwright-core` `connectOverCDP`) with the browser endpoints. No build step: plain `.mjs`.
- **The control server owns Chromium and ffmpeg.** `start.sh` (PID 1) owns Xvfb, dbus, portals, fluxbox, VNC. On SIGTERM it forwards to the control server, which stops ffmpeg with SIGINT, remuxes to `.mp4`, and exits; measured `docker stop` ≈ 0.6–0.7 s while recording.
- **Chromium runs with `--no-sandbox --test-type`.** With `CapDrop ALL` + `no-new-privileges` Chromium cannot build its own sandbox; the container is the sandbox. `--test-type` hides the "unsupported flag" infobar so it does not show in videos.
- **`t0` from `-copyts`.** x11grab stamps frames with wall-clock time; `-copyts` keeps it in `raw.mkv`, and the first packet's pts is the exact capture time of the first frame (typically 200–700 ms after ffmpeg spawns). The `.mp4` remux drops the offset (starts at 0). Steps store absolute `at` (computer clock) and `t = (at - t0) / 1000` is computed when the recording stops. Side effect: `raw.mkv` reports an epoch-sized start time in players; `raw.mp4` is the artifact to watch.
- **Screen coordinates for DOM elements** come from `window.screenX + (outerWidth - innerWidth)/2` and `screenY + (outerHeight - innerHeight)` (Chromium's tab strip + toolbar height, 87 px at 1080p). Assumes devicePixelRatio 1, which Xvfb gives.
- **Page snapshot refs** index `window.__acvRefs` in the page (no DOM attributes added), valid until the next snapshot.
- **`/screenshot` and `/act` return `image/png`** with metadata in headers (`x-cursor-x/y`, `x-at`, `x-action-at`), not base64 JSON.
- **`host.docker.internal:host-gateway`** is added to the computer so a host-only dev stack (local Supabase) can be reached, as the prototype needed.
- **No CJK fonts** in the image (`fonts-noto-cjk` adds ~100 MB). Add it if a target app needs it.

## Phase 2

- **Source upload = `git archive <sha>:<prefix>`** (never the working tree), with tar headers rewritten to uid/gid 1000 (`chownTar`) before `putArchive`, because Docker extracts with the tar's ownership and `git archive` is all root. The app directory may be a subdirectory of its repo (`examples/todo-app`); the diff and file list are limited to that prefix.
- **Diff base:** `--base` if given, else the merge-base with the first of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`; when the ref *is* on that branch, its parent.
- **Run directory split:** `runs/<id>/` is orchestrator-owned (plan, steps, verdict, report); only `runs/<id>/computer/` is mounted at `/artifacts`. The app under test runs in the computer and must not be able to write `verdict.json`.
- **The app runs inside the computer container** as `qa` (same 4 GB / 2 CPU budget as Chromium). Services are sibling containers on the run network with their name as DNS alias.
- **Setup output goes to `/artifacts/setup.log`**, app output to `/artifacts/app.log`. Boot failures (`upload`, `services`, `setup`, `start`, `health`) are a `blocked` verdict with reason `app_failed_to_boot` and the log tail; the CLI exits 2.
- **`--task noop` (or `--boot-only`)** boots, screenshots `booted.png`, and tears down without a verdict.
- **The control token is stripped from the env of the app and Chromium.** The app runs as the same uid as the control server, so a hostile app could still read it from `/proc`; the token guards the published port and the run network, not the computer from itself.
- **CLI runs TypeScript through tsx** (`apps/cli/bin/verify.mjs`); no build step.
