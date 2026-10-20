# Witness

Witness checks a code change the way a QA tester would, then hands you the evidence. Point it at a branch or a pull request. It boots the app in a fresh Linux desktop, works out what the change should do, uses the app with a mouse and keyboard, and records everything. You get a verdict per criterion, stills, a short edited video, and a report you can drop into the PR or share as a link.

It never edits code and it doesn't take the coding agent's word for anything. It only reports what it saw.

## Why I built this

Cursor's cloud agents were the inspiration. They test their own work and attach a video, and lately I was using them mostly for that part: QA. Witness is that part on its own, with two differences I care about.

- It is independent. The thing being checked is never the thing doing the checking.
- It works on any branch or PR, whether Claude Code, Cursor, Codex, Devin or a person wrote it.

## What a run gives you

| Output | What it is |
|---|---|
| `verdict.json` | pass, fail or blocked for each criterion, with timestamps into the recording and an explanation |
| `polished.mp4` | a 30 to 60 second video: zooms on each click, captions, a checklist that fills in, a freeze on every failure |
| `report.md` | a "Manual verification" section with captioned stills, ready for a PR description |
| a hosted report | an unlisted page with the video, criteria you can click to jump to, stills and logs |
| a live view | while it runs, a local page that streams the desktop next to the checklist |

## Quick start

You need Docker (OrbStack works well on macOS), Node 22.18 or newer, pnpm 10, and ffmpeg.

```bash
git clone https://github.com/mrevanzak/witness && cd witness
pnpm install
pnpm image:build          # the computer image: Xvfb, Chromium, ffmpeg, control server
pnpm witness:smoke        # boots a computer, clicks a button, records, tears down
```

Try it on the demo app. `make-fixture.sh` creates a small repo with a correct and a broken implementation of the same change.

```bash
bash examples/todo-app/make-fixture.sh
pnpm witness run --repo runs/fixtures/todo-app --ref feat/empty-title-broken --base main \
  --task "Empty todo titles show 'Title is required' and are not added" \
  --walkthrough examples/todo-app/walkthrough.spec.ts
pnpm witness render .witness/runs/<run-id>
pnpm witness report .witness/runs/<run-id>
```

Runs are recorded under `.witness/runs/` at the root of the git repo you run `witness` from (`--runs-dir` overrides it). `witness init` adds `.witness/` to that repo's `.gitignore`.

Each run opens a live view in your browser: the desktop as it happens, next to the checklist and the step log. Pass `--no-live` to skip it; CI never opens one. The run exits with 0 for pass, 1 for fail, 2 for blocked and 3 for usage errors, so it slots into scripts and CI.

## Three ways to drive a run

**Session mode** (`--session`) lets the coding agent you already use do the testing. `witness run --session` boots the app, starts recording and returns once the app is up. The agent then sends one action at a time with `witness act`, reads the screenshot each one returns, and records its verdicts. Every action goes through the same recorded tools as the other modes, so the video, captions, stills and verdict come out the same. No API key is needed; this is what the Claude Code skill uses.

```bash
pnpm witness run --repo runs/fixtures/todo-app --ref feat/empty-title-broken --base main \
  --task "Empty todo titles show 'Title is required' and are not added" --session
pnpm witness act criterion C1 feature "An empty title shows 'Title is required' and adds nothing"
pnpm witness act begin C1
pnpm witness act snapshot                                  # elements with refs and coordinates
pnpm witness act click-ref e1 --label "Submit with an empty title"   # prints a screenshot path
pnpm witness act still empty-title "The error shows, but a blank todo was added."
pnpm witness act end C1 fail "Saw the error, but the counter went from 2 to 3."
pnpm witness act finish                                    # prints the verdict, exits 0/1/2
```

A session with no command for 15 minutes closes itself and leaves its open criteria blocked.

**Independent mode** is the default and needs `ANTHROPIC_API_KEY`. Witness asks Claude to plan two to six criteria from the task and the diff, including at least one regression check. A separate tester loop then works through them using screenshots, and a reviewer call checks each claimed result against the final screenshot, the console and the app log. The overall verdict is computed by code: any failure fails the run, anything unchecked blocks it.

**Walkthrough mode** (`--walkthrough file.spec.ts`) runs a plain Playwright spec in the recorded desktop, for paths someone already knows. Each `test()` is a criterion and its Playwright result is the verdict; `test.step()` titles become the video's captions and attached screenshots become stills.

```ts
import { expect, test } from "@playwright/test"

test("Submitting an empty title shows 'Title is required' and adds nothing", async ({ page }) => {
	await page.goto("/")
	await test.step("Submit with an empty title", async () => {
		await page.getByRole("button", { name: "Add todo" }).click()
	})
	await test.info().attach("The form right after submitting an empty title.", {
		body: await page.screenshot(),
		contentType: "image/png",
	})
	await expect(page.locator("#title-error")).toHaveText("Title is required")
})
```

The spec can be one of the app's own e2e specs. It then runs from the source at the exact commit, with the app's own `playwright.config` and `@playwright/test`. Or it can be a file outside the repo, written for Witness. Witness keeps the config's projects and setup, runs one Chromium project headed on the recorded display, and ignores `webServer`, since the app is already running.

Walkthroughs are also how you get before and after comparisons. Run the same spec against the base commit and the change, then `witness compare <before-run> <after-run> --out report/`.

## Using it from Claude Code

`skills/witness` is a Claude Code skill. Link it into `~/.claude/skills/witness` and ask Claude to "verify PR 123" or run `/witness`. Claude boots the app in a session, plans the criteria from the diff, tests them itself while you watch in the live view, renders the video and returns the report. For before/after comparisons it writes the path as a Playwright spec and runs it on both refs. It only touches the PR when you ask it to publish.

## Telling Witness how to boot your app

The first time you point Witness at an app, draft its config:

```bash
pnpm witness init --repo ../my-app
pnpm witness run --repo ../my-app --config ../my-app/witness.yaml --boot-only
```

`init` reads the lockfile, package scripts, Playwright's `webServer`, docker compose and `.env.example`, writes `witness.yaml`, and lists what it guessed. It also asks where evidence gets published (`evidence`, see [Publishing evidence](#publishing-evidence)); pass `--evidence pr|hosted` when you're not at a terminal. `--boot-only` proves the app boots before you spend a real run on it. Commit the file to the repo, or keep it outside and pass `--config`. A full config looks like this:

```yaml
setup:
  - pnpm install --frozen-lockfile
  - pnpm db:migrate && pnpm db:seed
start: pnpm start --port 3000
url: http://localhost:3000
health: http://localhost:3000/api/health   # defaults to url
services:                                  # sibling containers on the run's network
  postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: test }, port: 5432 }
env:
  DATABASE_URL: postgres://postgres:test@postgres:5432/postgres
login:                                     # optional test account
  email: qa@example.com
  password: qa-password                    # never shown to the model, never logged
timeouts: { setup: 900, boot: 180 }
evidence: hosted                           # or pr: where `publish` puts screenshots and video
```

A config passed with `--config` can also stage files from your machine into the app (`files`) and load secret env from a file (`secret_env`). Witness redacts those values from every log, step, transcript and report. A `witness.yaml` inside the repo under test cannot do either.

## Commands

| Command | What it does |
|---|---|
| `witness init` | draft a `witness.yaml` for an app Witness hasn't run before, and choose where evidence is published |
| `witness run` | verify a ref: boot, check, record, write the verdict (`--session`, `--walkthrough`, `--boot-only`, `--keep`, `--no-live`) |
| `witness act <action>` | send one recorded action to a `--session` run (`click-ref`, `type`, `begin`, `end`, `still`, `finish`, …) |
| `witness render <run>` | render `polished.mp4` and `preview.gif`. With `evidence: hosted` (or `--layout hosted`) the app fills the frame and captions go to `captions.vtt`, since the report page shows the criteria |
| `witness report <run>` | write `report.md` |
| `witness compare <before> <after> --out <dir>` | a before/after report folder |
| `witness upload <run> [<after-run>]` | publish a hosted report, print its URL and write `hosted-section.md` for the PR |
| `witness publish --pr <n> --report <file>` | put a report in your PR's description, or comment on someone else's PR |
| `witness drive <run> <action>` | poke at a computer kept with `--keep` while you explore |
| `witness cleanup` | remove computers and networks left behind by crashed runs |

## Publishing evidence

Stills and the video reach a PR in one of two ways. `witness init` asks which one, and the answer is stored as `evidence` in `witness.yaml`.

| `evidence` | Where it lands | Commands | Needs |
|---|---|---|---|
| `pr` | stills and the video uploaded into the PR | `witness publish --pr <n> --report report.md --ego-space <id>` | an Ego browser signed in to GitHub |
| `hosted` | an unlisted report page; the PR gets the verdict, the criteria table and a link | `witness upload <run> --pr <n>`, then `witness publish --pr <n> --report <run>/hosted-section.md` | the Worker below, `WITNESS_REPORTS_URL`, `WITNESS_UPLOAD_TOKEN` |

`publish` writes into your own PR's description (between `<!-- witness:start/end -->`, replaced on re-runs) and comments on anyone else's. `--dry-run` shows what it would do.

## Hosted reports on Cloudflare

`apps/web` is a Cloudflare Worker. Media lives in R2, report rows in D1. Report links use 22-character random ids and are unlisted: anyone with the link can view, nothing is indexed.

The infrastructure is code. [`apps/web/alchemy.run.ts`](apps/web/alchemy.run.ts) declares the bucket, the database (with its migrations) and the Worker with its bindings, and [Alchemy](https://alchemy.run) creates or updates them to match.

```bash
cp apps/web/.env.example apps/web/.env     # set WITNESS_UPLOAD_TOKEN (openssl rand -hex 32)
pnpm --filter @witness/web exec alchemy profile edit --add Cloudflare  # once: sign in with OAuth or paste an API token
pnpm web:deploy                            # plan, confirm, create; prints the URL
```

Then set `WITNESS_REPORTS_URL` (the printed URL) and `WITNESS_UPLOAD_TOKEN` where you run the CLI. `pnpm web:plan` shows what a deploy would change, `pnpm web:destroy` removes everything, and `WITNESS_DOMAIN` in `apps/web/.env` serves reports from your own domain. `pnpm web:dev` runs the whole stack locally (the Worker in workerd, R2 and D1 emulated) without a Cloudflare account. Alchemy keeps its state in your Cloudflare account, so CI can deploy too: set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `WITNESS_UPLOAD_TOKEN`.

## How it works

Each run gets its own computer: a Docker container with Xvfb, a window manager and Chromium, on its own network, as a non-root user with every capability dropped and fixed memory, CPU and process limits. A small control server inside takes screenshots, sends input through xdotool, records the screen with ffmpeg and reads the page over the Chrome DevTools Protocol. The app runs inside the same container from a `git archive` of the exact commit, never your working tree. When the run ends, the computer, its services and its network are removed.

The codebase is TypeScript on [Effect](https://effect.website) 4. The computer, the orchestrator, the CLI, the control server and the Worker are services and layers with typed errors and schema-checked data at every boundary. The video is a [Remotion](https://www.remotion.dev) composition over the raw recording.

```
apps/cli              witness command
apps/web              Cloudflare Worker for hosted reports
packages/domain       schemas shared by everything: config, plan, steps, verdict, report API
packages/computer     the computer: Docker provider, control client, in-image control server
packages/orchestrator boot, plan, test, review, walkthroughs, reports
packages/renderer     timeline math and the Remotion composition
infra/computer        the computer image
examples/todo-app     demo app with a correct and a broken branch
skills/witness        the Claude Code skill
```

Design decisions and their reasons are in [DECISIONS.md](DECISIONS.md). What's done and what's next is in [GOALS.md](GOALS.md).

## Status

Early. The pipeline is tested end to end with a scripted model and with walkthroughs, on the demo app and on a real Next.js + Strapi + Supabase monorepo. The live acceptance run with the real model (4 of 5 correct verdicts per fixture branch) hasn't been run yet. Treat independent-mode verdicts as a second opinion until it has.

Only web apps for now. Mobile apps and non-Linux guests are out of scope.

## Licenses

Witness is MIT licensed. One dependency needs a look before you adopt it: Remotion, which renders the polished video, is source-available under the [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md). It is free for individuals and for companies of up to three people; larger companies need a Remotion company license to render videos. Everything else Witness does (the verdict, stills, reports, live view) works without rendering.

## Credits

- [Cursor's cloud agents](https://cursor.com) for the idea of attaching proof to a change.
- [Rakazo](https://github.com/elie222/rakazo) for the one-computer-per-agent design: a plain container with Xvfb, a window manager and Chromium, behind a small control API.
- [tonkotsuboy/github-upload-image-to-pr](https://github.com/tonkotsuboy/github-upload-image-to-pr) for the trick of uploading PR media through the comment box.
- [noVNC](https://novnc.com) for the live view.
