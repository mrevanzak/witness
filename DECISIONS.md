# Decisions

Choices that shaped Witness and why. When you change one, update it here.

## Scope

- **Web apps on a Linux desktop only.** Mobile apps and Windows/macOS guests are out of scope for now.
- **Independent by design.** The verifier never edits the code under test, never runs git or a shell for the model, and never trusts claims in commit messages, PR bodies or docs. It reports what it observed.
- **One run, one computer.** A fresh container per run, destroyed at the end. Nothing carries over between runs; clean state is what makes the evidence trustworthy.

## Stack

- **Effect 4 end to end.** Every boundary is a `Context.Service` with a `Layer`: the computer, the control server inside it, git, the model, the planner, the executor, the reviewer, walkthroughs, the CLI and the Worker. Expected failures are `Schema.TaggedError`s with specific tags (`AppBootFailed`, `ControlError`, `ModelBudgetExceeded`, `ReportNotFound`). Data crossing a boundary goes through `Schema`: `witness.yaml`, run artifacts, the control protocol, model output, page snapshots, the report API. Pure math (zoom, pacing, tar headers, range parsing, diff fitting) stays plain functions.
- **A computer's lifetime is a `Scope`.** `ComputerProvider.create` acquires the network and container and releases them when the scope closes, so a run can't leak a container on any exit path. `--keep` swaps the release for a log line.
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
- **Walkthrough mode** exists for paths a person or a coding session already knows, and for before/after measurements the model can't take. A walkthrough file default-exports an Effect program; a module resolution hook lets it import `effect` and `@witness/*` from anywhere.

## Outputs

- **Video look:** dark neutral canvas, IBM Plex, the app in a hairline frame, a criteria rail that fills in, captions under the frame instead of over the app, source timecode, and an evidence tape with one segment per criterion.
- **Live view:** run log and step events go through `CurrentRun.publish` into a `PubSub` and out as Server-Sent Events with a replay buffer. The desktop is noVNC lite, view-only, with its status bar cropped off; websockify listens on all interfaces inside the container while the published port stays on host loopback.
- **PR publishing:** your own PR gets the report in its description between `<!-- witness:start -->` and `<!-- witness:end -->` (replaced on re-runs, inserted above bot footers); someone else's PR gets a comment. Media upload goes through the PR's comment box in a browser signed in to GitHub, so images and video are hosted by GitHub.
- **Hosted reports:** a Cloudflare Worker with media in R2 and rows in D1. Report ids are 22 random base62 characters (about 131 bits) and the only thing granting access; pages send `noindex` and `no-referrer`. Uploads need a bearer token compared in constant time. Media supports HTTP ranges so the video seeks. Each criterion's recording time is mapped onto the polished video at upload, so the page's time buttons jump to where the check is shown.

## Configuration

- **`witness.yaml`** is snake_case on disk and decodes to a camelCase config with defaults applied. Unknown keys are errors.
- **Verifier-side configs** (`--config`) may stage host files and a secret env file. A config inside the repo under test may not, so a PR can't make Witness read files from your machine.
- **Private configs for your own apps live in `local/`**, which is gitignored.
