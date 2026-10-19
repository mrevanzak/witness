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

## Phase 3

- **Model:** `claude-opus-5-5` (override with `ACV_MODEL`), adaptive thinking (always on for this model), effort `high` for plan and review, `medium` for the execution loop. Server-side refusal fallback on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`; `ACV_FALLBACKS=0` turns it off). Cost cap per run `ACV_MAX_USD` (default $5), tracked from `usage` at list prices; `usage.json` per run.
- **Custom tools, not Anthropic's computer toolset.** We already own the screen, the coordinate mapping and the step log; custom strict tools let us add `page_snapshot`/`click_element`, `begin/end_criterion`, `type_secret` and read-only log tools, and nothing that edits code or runs a shell.
- **The model sees 1280×720 JPEGs** of the 1920×1080 screen; coordinates are scaled ×1.5 on the way in and out. Evidence stills are full-res PNGs. Only the last visible action in a turn returns an image.
- **Append-only history** (required by preserved thinking on this model), with server-side context editing (`clear_tool_uses_20250919`, trigger 60k input tokens, keep 8 tool uses, never clearing `begin/end_criterion`) instead of trimming old screenshots ourselves, plus top-level prompt caching.
- **Secrets:** the login password is never shown to the model; `type_secret` types it. Labels and `type` text containing it are rejected; every log, step, transcript and verdict is redacted.
- **Navigation is limited** to the app's host, `localhost`/`127.0.0.1` and service names.
- **Untrusted content** (diff, README, PR body, page text, console, app log) is wrapped in `<untrusted kind=…>` and the system prompts say it is data.
- **Budgets:** 90 visible actions per run, 25 per criterion (warning in the tool result; force-ended as `blocked` at +5), 10 min wall time, cost cap; stuck detector warns after 3 identical actions with an unchanged screenshot. Criteria left open when the loop stops are `blocked` with the reason (`forced`), and the reviewer cannot override a forced block.
- **Verdict:** a separate reviewer call (structured output) checks each claimed status against the final screenshot, step captions, console/network errors and the app log, and writes the explanation. `overall` is computed by code: fail if any criterion fails, else blocked if any is blocked (an unverified criterion never yields pass), else pass.
- **Acceptance status:** `pnpm e2e:scripted` (a scripted `Model` driving the real computer on both fixture branches) passes: `pass` for `feat/empty-title`, `fail` for `feat/empty-title-broken`, with video timestamps and evidence. **The live acceptance (`pnpm acceptance:phase3`, 4/5 per branch with the real model) has not run yet: no API key on this machine.** Phases 4-5 were built on the scripted runs' artifacts, which have the same shape; this deviates from "do not start a phase before the previous one's acceptance passes" and must be closed before relying on verdicts.
