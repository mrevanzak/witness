# ai-change-verifier

An independent verifier for code changes made by AI coding agents or humans. For each run it boots a fresh Linux desktop in Docker, starts the app at the changed ref, plans checks from the task + diff, uses the app like a QA tester, records the session, and writes a verdict with evidence (video timestamps, screenshots, console errors, app logs).

See `DECISIONS.md` for design choices.

## Quick start

```bash
pnpm install
pnpm image:build     # the computer image (infra/computer)
pnpm verify:smoke    # Phase 1 acceptance: desktop + Chromium + click + recording
```

## Layout

| Path | What |
|---|---|
| `infra/computer` | Dockerfile, `start.sh` (PID 1), control server (`control/control.mjs`) |
| `packages/computer` | `ComputerProvider` interface + `DockerComputerProvider` |
| `packages/orchestrator` | RunManager, AppBooter, agent loop, verdict |
| `packages/renderer` | Remotion composition (polished video) + `report.html` |
| `apps/cli` | `verify run --repo . --ref HEAD --task "..."` |
| `examples/todo-app` | demo app + `verify.yaml` used in tests |
