# Decisions

Choices that shaped Witness and why. When you change one, update it here.

## Scope

- **Web apps on a Linux desktop only.** Mobile apps and Windows/macOS guests are out of scope for now.
- **Independent by design.** The verifier never edits the code under test, never runs git or a shell for the model, and never trusts claims in commit messages, PR bodies or docs. It reports what it observed.
- **One run, one computer.** A fresh container per run, destroyed at the end. Nothing carries over between runs; clean state is what makes the evidence trustworthy.

## Stack

- **Effect 4 end to end.** Every boundary is a `Context.Service` with a `Layer`: the computer, the control server inside it, git, the model, the planner, the executor, the reviewer, walkthroughs, the CLI and the Worker. Expected failures are `Schema.TaggedError`s with specific tags (`AppBootFailed`, `ControlError`, `ModelBudgetExceeded`, `ReportNotFound`). Data crossing a boundary goes through `Schema`: `witness.yaml`, run artifacts, the control protocol, model output, page snapshots, the report API. Pure math (zoom, pacing, tar headers, range parsing, diff fitting) stays plain functions.
- **A computer's lifetime is a `Scope`.** `ComputerProvider.create` acquires the network and container and releases them when the scope closes, so a run can't leak a container on any exit path. `--keep` swaps the release for a log line.
- **Kebab-case file names.** `docker-provider.ts` holds `DockerComputerProvider`; names inside files stay PascalCase for services and classes.
- **Remotion for the video.** The composition is React; the driver that renders it is Effect. Remotion's license (free up to three people per company) is called out in the README.

## The computer

- **Plain container, no special service.** Xvfb, fluxbox and Chromium, recorded with ffmpeg `x11grab`, driven by a control server on port 7070 with a per-run bearer token. Hardened: uid 1000, `CapDrop ALL`, `no-new-privileges`, memory and swap capped together, CPU and PID limits, 512 MB `/dev/shm`, its own bridge network.
- **Chromium runs with `--no-sandbox --test-type`.** With every capability dropped it can't build its own sandbox; the container is the sandbox. `--test-type` hides the infobar that would otherwise appear in every video.
- **The control port is published on host loopback** with an ephemeral port, because macOS can't reach Docker bridge IPs. The token is stripped from the environment of the app and Chromium. The app runs as the same uid, so a hostile app could still read it from `/proc`; the token guards the port and the run network, not the computer from itself.
- **`t0` comes from `-copyts`.** x11grab stamps frames with wall-clock time, so the first packet's timestamp is the exact capture time of the first frame. Steps store wall-clock `at` (computer clock) and get `t = (at - t0) / 1000` when the recording stops. The `.mp4` remux starts at zero.
- **Shutdown finalises the recording.** `docker stop` reaches the control server, whose recorder finalizer stops ffmpeg with SIGINT and remuxes. Measured under one second.
- **The app comes from `git archive` of the exact commit**, never the working tree, with tar headers rewritten to uid 1000 so `pnpm install` works as the non-root user.
- **`runs/<id>/` is the orchestrator's; only `runs/<id>/computer/` is mounted.** The app under test can't write `verdict.json`.

## Verifying

- **Model:** `claude-opus-5-5` by default (`WITNESS_MODEL`), adaptive thinking, effort `high` for planning and review and `medium` for the tester loop, server-side refusal fallback on, and a per-run cost cap (`WITNESS_MAX_USD`, default $5).
- **Custom strict tools, not the computer-use toolset.** Witness owns the screen, the coordinate mapping and the step log, and needs tools the toolset doesn't have: `page_snapshot` + `click_element`, `begin/end_criterion`, `type_secret` and read-only logs.
- **The model sees 1280x720 JPEGs** of the 1920x1080 screen; coordinates scale by 1.5 each way. Evidence stills are full-resolution PNGs.
- **Append-only conversation** with server-side context editing to drop old screenshots, and prompt caching on the prefix.
- **Structured outputs come from Effect Schema.** The planner and reviewer send `Schema.toJsonSchemaDocument` as the output format and decode the reply with the same schema.
- **The overall verdict is code, not the model.** Any failed criterion fails the run; anything unverified blocks it; a criterion the orchestrator force-ended (budget, wall time) stays blocked whatever the reviewer says.
- **Secrets:** the test password never reaches the model (`type_secret` types it). Labels or typed text containing it are rejected, and every log, step, transcript, report and live event is redacted.
- **Everything from the repo and the page is untrusted** and is wrapped in `<untrusted>` tags in prompts. Navigation is limited to the app's host, `localhost` and service names.
- **Session mode** lets the coding agent the user already has (Claude Code through the skill) be the tester, with no API key. `run --session` detaches the run into a background process and returns once the app is up; the run serves a token-guarded endpoint on host loopback and writes its address to `driver.json`. `witness act` sends one action at a time. Under the hood a session is a walkthrough program fed by those commands, so it records the same steps, stills and verdict, and the overall verdict is still code. Coordinates are in 1280x720 screenshot pixels, like the model's. The password goes in with `type-secret` and is never shown. An idle session closes itself (15 minutes by default) so a forgotten one cannot leak a computer. A session is less independent than the other modes when the same agent wrote the change; the skill tells it to judge only what the recording shows.
- **Walkthrough mode runs Playwright specs**, not a Witness-only script format, so the specs an app already has work, and anyone who knows Playwright can write one. A spec inside the repo runs from the archived source at the exact commit with the app's own `@playwright/test`. A spec from outside the repo is staged next to the app's `playwright.config`, and falls back to the runner baked into the image. A generated wrapper config imports the app's config, keeps its projects and setup dependencies, runs the first Chromium project headed and maximized on the recorded display with `slowMo` so the video can be followed, drops `webServer`, and points `baseURL` at the app. Witness's reporter turns each `test()` into a criterion, `test.step()` titles into captions and attached images into stills. Click points come from the Playwright trace, shifted by the browser toolbar's height (measured once per run), because Playwright's input never moves the real cursor. The verdict is Playwright's result, so a spec is only as independent as its author: the app's own specs come from the change under test. Console and network errors are not collected in this mode.

- **Before and after by default** (`states: before-after`, `--states` per run). The base commit is verified first, the same way and against the same criteria, so a reviewer sees what the change changed rather than only the end state. It runs in its own computer and its own run folder, `<run>/before/` (a full run: run.json, recording, steps, verdict), so `render`, `report` and `upload` treat it like any run and find it by that path. It uses the change's `witness.yaml`, since the base may predate it. Agent mode plans once from the change and executes the plan on both; a session's criteria carry over from the base commit's session; a spec runs on both. Only the change's verdict counts: the base commit is expected to fail the feature criteria, and a base that can't boot leaves a blocked verdict and a note instead of failing the run. It doubles the boot time, which is why `after` exists. The sides run in order by default, so a run needs one computer's worth of memory and the live view follows one desktop; `--parallel` (opt-in, agent and spec modes) runs both at once and keeps the base commit out of the live view. Sessions can't: the change's session starts from the criteria declared on the base commit.

## Outputs

- **Video look:** dark neutral canvas, IBM Plex, the app in a hairline frame, a criteria rail that fills in, captions under the frame instead of over the app, source timecode, and an evidence tape with one segment per criterion.
- **Live view, on by default:** every run opens it (`--no-live` turns it off, CI never opens a browser), because watching the run is how you trust it. Run log and step events go through `CurrentRun.publish` into a `PubSub` and out as Server-Sent Events with a replay buffer. The desktop is noVNC lite, view-only, with its status bar cropped off; websockify listens on all interfaces inside the container while the published port stays on host loopback.
- **PR publishing:** your own PR gets the report in its description between `<!-- witness:start -->` and `<!-- witness:end -->` (replaced on re-runs, inserted above bot footers); someone else's PR gets a comment. Media upload goes through the PR's comment box in a browser signed in to GitHub, so images and video are hosted by GitHub.
- **Hosted reports:** a Cloudflare Worker with media in R2 and rows in D1. Report ids are 22 random base62 characters (about 131 bits) and the only thing granting access; pages send `noindex` and `no-referrer`. Uploads need a bearer token compared in constant time. Media supports HTTP ranges so the video seeks. Each criterion's recording time is mapped onto the polished video at upload, so the page's time buttons jump to where the check is shown.
- **Infrastructure as code with Alchemy 2.** `apps/web/alchemy.run.ts` declares the R2 bucket, the D1 database with its migrations, and the Worker with its bindings; deploy, plan and destroy work from it, and `alchemy dev` runs the stack locally with no account. Alchemy 2 is itself built on Effect, which keeps the infra in the same language as the rest. The Worker stays a plain module whose `Env` type comes from the stack (`InferEnv`), so a binding can't drift from the code that reads it. Alchemy 2 is a beta, pinned to an exact version. Its state lives in the Cloudflare account, so CI and a laptop deploy the same stack.

## Configuration

- **`witness init` drafts, `--boot-only` proves.** The draft comes from what the repo already declares (lockfile, scripts, Playwright `webServer`, compose, `.env.example`), with every guess listed. It never guesses secrets.
- **`witness.yaml`** is snake_case on disk and decodes to a camelCase config with defaults applied. Unknown keys are errors.
- **Verifier-side configs** (`--config`) may stage host files and a secret env file. A config inside the repo under test may not, so a PR can't make Witness read files from your machine.
- **Private configs for your own apps live in `local/`**, which is gitignored.
