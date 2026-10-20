---
name: witness
description: QA a pull request or branch in a fresh, recorded Linux desktop and produce a "## Manual verification" report (stills, polished walkthrough video, per-criterion verdict). Use when asked to verify, QA, or prove a PR or a coding agent's change, or to attach that evidence to a PR description.
---

# witness

You are QA for a change you did not write. Boot the app at the change's exact commit in an **witness** computer, use it like a person, and hand back evidence: stills with captions, `polished.mp4`, and a verdict per criterion. Tests and CI are never the evidence; the recorded run is.

`$WITNESS` = the witness checkout (the directory two levels above this file). Run every `verify …` command as `pnpm -C $WITNESS -s witness …`.

## 1. Pin the change and the destination

```bash
gh pr view <N> --json number,title,author,headRefOid,baseRefName,body,files,url   # a PR
git -C <repo> rev-parse HEAD                                                     # a branch
```

- `ref` = the head **SHA**, fetched locally (`git -C <repo> fetch origin pull/<N>/head`). Base = `origin/<baseRefName>`.
- **Destination: return the report to the user** unless they asked to attach or publish it to the PR. Publishing is step 6 and only runs on that request.

## 2. Pick the boot config

- The repo has `witness.yaml` at the ref → use it.
- Else `$WITNESS/local/<repo-name>/witness.yaml` (gitignored) → pass `--config`; run its `prepare.sh` first when present (it stages local dev keys, never hosted ones).
- Else this is the app's first run. First ask the user where evidence should be published, as its own clear question with both options (see step 6): **GitHub PR** (stills and video uploaded into the PR) or **Hosted page** (an unlisted report page; the PR gets a summary linking to it). Then draft: `witness init --repo <repo> --out $WITNESS/local/<repo-name>/witness.yaml --evidence pr|hosted`. Without `--evidence`, `init` prompts on a terminal and fails anywhere else, so always pass it. It reads the lockfile, package scripts, Playwright `webServer`, docker compose and `.env.example`, and lists what it guessed. Finish it from the repo's own QA docs and CI workflows: services the app needs, env values, a seeded `login`, local secrets in a `secret_env` file next to it. Then prove it with `witness run … --config <it> --boot-only --no-live` until it boots, and keep it.

Heavy stacks (Next + CMS builds) need `--memory-gb 9 --cpus 6`.

Runs open a live view by default (the desktop, criteria and steps in the browser), so the user can watch. Pass `--no-live` for boot checks and other runs nobody needs to watch.

## 3. Pick the mode

| Mode | When | Run |
|---|---|---|
| **independent** | `ANTHROPIC_API_KEY` is set | `witness run --repo <repo> --ref <sha> --base <base> --task-file <task.md> [--config …]` — its own model plans, tests and judges |
| **in-session** | no key, a before/after comparison, or measurements the model cannot take | you explore, then a walkthrough script drives the run (step 4) |

`task.md` = the PR title and body (or the user's description of the change). Exit code: 0 pass, 1 fail, 2 blocked.

## 4. In-session: explore, then walk through

1. Boot and keep: `witness run … --boot-only --keep --task noop`. The run dir holds `session.json`.
2. Explore with `witness drive <runDir> shot | snapshot | click-text <name> | click <x> <y> | type … | key … | navigate <url> | eval <js> | console | logs`. Read every screenshot it writes. Learn the exact path, selectors and texts from the app and from the diff.
3. Write `walkthrough.ts` from [`walkthrough-template.ts`](walkthrough-template.ts): an Effect program that yields `Walkthrough`, declares 2–6 criteria (what the PR changes, plus one nearby flow it could break), and for each runs `begin` → act → `still(name, caption)` → `end(status, notes)`. Each caption is one sentence saying what the still proves. Its `effect` and `@witness/*` imports resolve from Witness, so the file can live anywhere.
4. Remove the kept computer (`docker rm -f $(docker ps -aq --filter label=witness.run=<runId>)`), then run for real: `witness run … --walkthrough walkthrough.ts --task-file task.md`. For a before/after, run it once per ref (the base or baseline commit, then the head) with the same script.
5. Read every still and `verdict.json`. A criterion you did not observe is `blocked`, never `pass`.

## 5. Render and report

```bash
witness render <runDir>        # polished.mp4 (<60 s, zoom, captions, verdict moments) + preview.gif
witness report <runDir>        # report.md: "## Manual verification", stills, walkthrough, notes
```

For a before/after: `witness compare <beforeRun> <afterRun> --out <dir> --preview "…"` writes one self-contained folder that pairs the stills, tables both verdicts and includes both videos (render each run with `--label before|after` first). Notes say what was pre-existing, set up for the run, or not verified, and why.

**Done** = every criterion has a status backed by a still you read, `polished.mp4` plays, and the report links only files that exist. Give the user the verdict, the report path, and the media paths.

## 6. Publish (only when asked)

The config's `evidence` key says where evidence goes. If it is missing (an older config, or the repo's own `witness.yaml`), ask the user which of the two they want before publishing, and add the key to a config under `$WITNESS/local` so the next run doesn't ask again.

| `evidence` | Where it lands | Needs |
|---|---|---|
| `pr` | Stills and the video uploaded into the PR | an Ego task space signed in to GitHub |
| `hosted` | An unlisted report page (video with jump-to criteria, stills, logs); the PR gets the verdict, the criteria table and a link | `WITNESS_REPORTS_URL`, `WITNESS_UPLOAD_TOKEN` |

**pr:**

```bash
witness publish --pr <N> --report <report.md> --repo <repo> --dry-run
witness publish --pr <N> --report <report.md> --repo <repo> --ego-space <id>
```

Uploads media through the PR's comment box in Ego and swaps paths for `user-attachments` URLs.

**hosted:**

```bash
witness upload <runDir> --pr <N> [--preview "…"]            # or: witness upload <beforeRun> <afterRun> --pr <N>
witness publish --pr <N> --report <runDir>/hosted-section.md --repo <repo> --dry-run
witness publish --pr <N> --report <runDir>/hosted-section.md --repo <repo>
```

`upload` prints the report URL and writes `hosted-section.md` (in the after run for a pair). That section links to the page instead of embedding local files, so `publish` needs no Ego. If the user only wants the link, give them the URL and stop there.

Either way, the current user's PR gets the section in its description between `<!-- witness:start/end -->` (replaced on re-runs, above bot footers); anyone else's PR gets a comment. Confirm with the user before the non-dry run; then open the PR (and the hosted page) and check each image loads and the video plays.

## Guardrails

- The verifier observes; code changes for a variant (a flag flipped) happen only inside the computer and are never pushed.
- Shared host state a run touches (a local database) is recorded and reverted.
- Credentials come from seed data or the user signing in; staged secret env is redacted from every log, step and report.
- `witness cleanup` removes computers and networks left by crashed runs.
