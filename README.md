# Witness

Independent, recorded QA for code changes, driven by your coding agent.

<p>
  <a href="https://www.npmjs.com/package/@mrevanzak/witness"><img alt="npm version" src="https://img.shields.io/npm/v/@mrevanzak/witness.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://skills.sh/mrevanzak/witness"><img alt="skills.sh" src="https://skills.sh/b/mrevanzak/witness?style=for-the-badge" height="28"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-000000.svg?style=for-the-badge" height="28"></a>
</p>

Witness checks a code change the way a QA tester would, then hands you the evidence. Run `/witness` on a branch or a pull request. It boots the app in a fresh Linux desktop, works out what the change should do, uses the app with a mouse and keyboard, and records everything. You get a verdict per criterion, stills, a short edited video, and a report you can drop into the PR or share as a link.

It never edits code and it doesn't take the coding agent's word for anything. It only reports what it saw.

## Install

You need Docker (OrbStack works well on macOS), Node 22.18 or newer, and ffmpeg.

```bash
npx skills add mrevanzak/witness
```

That's all you need to do. The first time the skill runs, it installs the CLI (`npm install -g @mrevanzak/witness`) and builds the computer image (`witness image`: Xvfb, Chromium, ffmpeg and the control server) if they're missing. You can also do both yourself up front.

The skill works with Claude Code, Codex, Cursor, Gemini CLI, OpenCode and the other agents [skills](https://skills.sh) supports. If you can't run `npx skills`, copy [`skills/witness`](skills/witness) into your agent's skills folder (`~/.claude/skills/witness` for Claude Code).

## Run it with `/witness`

Witness never starts on its own. A run boots containers and records for minutes, so you start it yourself. On a feature branch, that's all it takes:

```
/witness
```

It checks the current branch against the default branch. If the branch has an open PR, the PR's description says what the change should do. Otherwise the branch's commit messages do. Only committed code is checked.

To point it somewhere else or ask for more, add words after it:

```
/witness PR 123
/witness against release/2.0, and attach the evidence to the PR
```

In agents without slash commands, name the skill: "use the witness skill". The agent then:

1. pins the PR's head commit and its base,
2. finds or drafts a `witness.yaml` for the app and checks that it boots (the first time only; it asks you where evidence should be published),
3. boots the base commit in a recorded computer, plans two to six criteria from the diff (at least one checks for regressions), and tests each one with the mouse and keyboard while you watch in the live view,
4. does the same on the change,
5. renders the video and writes the report.

It gives you the verdict and the report. It only touches the PR when you ask it to publish. No API key is needed: your agent does the testing, and Witness records every action it takes.

Runs are recorded under `.witness/runs/` at the root of the repo under test. `.witness/` has its own `.gitignore`, so runs stay out of `git status`.

## What a run gives you

| Output | What it is |
|---|---|
| `verdict.json` | pass, fail or blocked for each criterion, with timestamps into the recording and an explanation |
| `polished.mp4` | a 30 to 60 second video: zooms on each click (unless `animation: false`), captions, a checklist that fills in, a freeze on every failure |
| `report.md` | a "Manual verification" section with captioned stills, ready for a PR description |
| a hosted report | an unlisted page with the video, criteria you can click to jump to, stills and logs |
| a live view | while it runs, a local page that streams the desktop next to the checklist |

## Why I built this

Cursor's cloud agents were the inspiration. They test their own work and attach a video, and lately I was using them mostly for that part: QA. Witness is that part on its own, with two differences I care about.

- It is independent. The thing being checked is never the thing doing the checking.
- It works on any branch or PR, whether Claude Code, Cursor, Codex, Devin or a person wrote it.

## Before and after

By default every run checks the app twice: first at the base commit, then with the change, in two fresh computers and against the same criteria. Reviewers see what the app did before the change next to what it does now, and a fix shows the bug it fixes. The report pairs each still with its before, shows both verdicts per criterion and includes both videos. Only the change's verdict decides the result. If the base commit can't boot, the report says so and shows the change alone.

To record only the change (one boot instead of two), tell the agent, or set `states: after` in `witness.yaml`.

## Three ways to drive a run

**Session mode** is what the skill uses, and your agent is the tester. Witness boots the app and starts recording. The agent sends one action at a time (click, type, scroll), reads the screenshot each action returns, saves captioned stills and records a verdict per criterion. Every action goes through the same recorded tools as the other modes, so the video, captions, stills and verdict come out the same.

**Walkthrough mode** runs a plain Playwright spec in the recorded desktop, for paths someone already knows. Ask the agent to replay a path as a walkthrough, or point it at one of the app's own e2e specs. Each `test()` is a criterion and its Playwright result is the verdict. `test.step()` titles become the video's captions and attached screenshots become stills.

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

An app's own spec runs from the source at the exact commit, with the app's own `playwright.config` and `@playwright/test`. A spec written for Witness can live outside the repo. Witness keeps the config's projects and setup, runs one Chromium project headed on the recorded display, and ignores `webServer`, since the app is already running.

**Independent mode** uses Witness's own model and needs `ANTHROPIC_API_KEY`. Claude plans the criteria from the task and the diff, a separate tester loop works through them using screenshots, and a reviewer call checks each claimed result against the final screenshot, the console and the app log. The overall verdict is computed by code: any failure fails the run, and anything unchecked blocks it. The skill only uses this mode when you ask for it.

## Telling Witness how to boot your app

The first time the agent sees an app, it drafts a `witness.yaml` from the lockfile, package scripts, Playwright's `webServer`, docker compose and `.env.example`. It fills the gaps from the repo's QA docs and CI workflows, then retries the boot until the app comes up. It keeps the file in `~/.witness/<repo-name>/`. Commit it to the repo when you want everyone to share it. A full config looks like this:

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
evidence: hosted                           # or pr: where screenshots and video get published
states: before-after                       # or after: also check the base commit (the default), or only the change
animation: false                           # default true: zoom on each action, glide the cursor, ripple clicks
```

A config kept outside the repo can also copy files from your machine into the app (`files`) and load secret env from a file (`secret_env`). Witness redacts those values from every log, step, transcript and report. A `witness.yaml` inside the repo under test can do neither.

## The CLI

The skill drives the `witness` CLI, and you can run it yourself too, from scripts and CI. `witness --help` lists every command.

| Command | What it does |
|---|---|
| `witness init` | draft a `witness.yaml` for an app, and choose where evidence is published |
| `witness run` | verify a ref: boot, check, record, write the verdict (`--session`, `--walkthrough`, `--states`, `--parallel`, `--boot-only`, `--no-live`) |
| `witness act <action>` | send one recorded action to a `--session` run |
| `witness render <run>` | render `polished.mp4` and `preview.gif` |
| `witness report <run>` | write `report.md`, a before/after report when the run has a `before/` |
| `witness compare <before> <after> --out <dir>` | a before/after report from two separate runs |
| `witness upload <run>` | publish a hosted report and print its URL |
| `witness publish --pr <n> --report <file>` | put a report in your PR's description, or comment on someone else's PR |
| `witness cleanup` | remove computers and networks left behind by crashed runs |

`witness run` exits with 0 for pass, 1 for fail, 2 for blocked, 3 for usage errors and 4 when something else stopped it (Docker down, a failed upload).

## Publishing evidence

Stills and the video reach a PR in one of two ways. The agent asks which one the first time and saves the answer as `evidence` in `witness.yaml`.

| `evidence` | Where it lands | Needs |
|---|---|---|
| `pr` | stills and the video uploaded into the PR | an Ego browser signed in to GitHub |
| `hosted` | an unlisted report page; the PR gets the verdict, the criteria table and a link | the Worker below, `WITNESS_REPORTS_URL`, `WITNESS_UPLOAD_TOKEN` |

The report goes into your own PR's description (between `<!-- witness:start/end -->`, replaced on re-runs) and as a comment on anyone else's. The agent shows you a dry run and asks before it writes anything.

## Hosted reports on Cloudflare

`apps/web` is a Cloudflare Worker. Media lives in R2, report rows in D1. Report links use 22-character random ids and are unlisted: anyone with the link can view, nothing is indexed.

The infrastructure is code. [`apps/web/alchemy.run.ts`](apps/web/alchemy.run.ts) declares the bucket, the database (with its migrations) and the Worker with its bindings, and [Alchemy](https://alchemy.run) creates or updates them to match. Deploying needs a clone of this repo with `pnpm install` run.

```bash
cp apps/web/.env.example apps/web/.env     # set WITNESS_UPLOAD_TOKEN (openssl rand -hex 32)
pnpm --filter @witness/web exec alchemy profile edit --add Cloudflare  # once: sign in with OAuth or paste an API token
pnpm web:deploy                            # plan, confirm, create; prints the URL
```

Then set `WITNESS_REPORTS_URL` (the printed URL) and `WITNESS_UPLOAD_TOKEN` wherever your agent runs. `pnpm web:plan` shows what a deploy would change, `pnpm web:destroy` removes everything, and `WITNESS_DOMAIN` in `apps/web/.env` serves reports from your own domain. `pnpm web:dev` runs the whole stack locally (the Worker in workerd, R2 and D1 emulated) without a Cloudflare account. Alchemy keeps its state in your Cloudflare account, so CI can deploy too: set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `WITNESS_UPLOAD_TOKEN`.

## How it works

Each run gets its own computer: a Docker container with Xvfb, a window manager and Chromium, on its own network. It runs as a non-root user with every capability dropped and fixed memory, CPU and process limits. A small control server inside takes screenshots, sends input through xdotool, records the screen with ffmpeg and reads the page over the Chrome DevTools Protocol. The app runs inside the same container from a `git archive` of the exact commit, never your working tree. When the run ends, the computer, its services and its network are removed.

The codebase is TypeScript on [Effect](https://effect.website) 4. The computer, the orchestrator, the CLI, the control server and the Worker are services and layers with typed errors, and data is checked against a schema at every boundary. The video is a [Remotion](https://www.remotion.dev) composition over the raw recording.

```
apps/cli              the witness command (@mrevanzak/witness)
apps/web              Cloudflare Worker for hosted reports
packages/domain       schemas shared by everything: config, plan, steps, verdict, report API
packages/computer     the computer: Docker provider, control client, in-image control server
packages/orchestrator boot, plan, test, review, walkthroughs, reports
packages/renderer     timeline math and the Remotion composition
infra/computer        the computer image
examples/todo-app     demo app with a correct and a broken branch
skills/witness        the agent skill
```

To work on Witness itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Early. The pipeline is tested end to end with a scripted model and with walkthroughs, on the demo app and on a real Next.js + Strapi + Supabase monorepo. The live acceptance run with the real model (4 of 5 correct verdicts per fixture branch) hasn't been run yet. Treat independent-mode verdicts as a second opinion until it has.

Only web apps for now. Mobile apps and non-Linux guests are out of scope.

## Licenses

Witness is MIT licensed. One dependency needs a look before you adopt it: Remotion, which renders the polished video, is source-available under the [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md). It is free for individuals and for companies of up to three people. Larger companies need a Remotion company license to render videos. Everything else Witness does (the verdict, stills, reports, live view) works without rendering.

## Credits

- [Cursor's cloud agents](https://cursor.com) for the idea of attaching proof to a change.
- [Rakazo](https://github.com/elie222/rakazo) for the one-computer-per-agent design: a plain container with Xvfb, a window manager and Chromium, behind a small control API.
- [tonkotsuboy/github-upload-image-to-pr](https://github.com/tonkotsuboy/github-upload-image-to-pr) for the trick of uploading PR media through the comment box.
- [noVNC](https://novnc.com) for the live view.
