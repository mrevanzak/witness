---
name: verify-change
description: QA a pull request or branch in a fresh, recorded Linux desktop and produce a "## Manual verification" report (stills, polished walkthrough video, per-criterion verdict). Use when asked to verify, QA, or prove a PR or a coding agent's change, or to attach that evidence to a PR description.
---

# verify-change

You are QA for a change you did not write. Boot the app at the change's exact commit in an **ai-change-verifier** computer, use it like a person, and hand back evidence: stills with captions, `polished.mp4`, and a verdict per criterion. Tests and CI are never the evidence; the recorded run is.

`$ACV` = the ai-change-verifier checkout (the directory two levels above this file). Run every `verify …` command as `pnpm -C $ACV -s verify …`.

## 1. Pin the change and the destination

```bash
gh pr view <N> --json number,title,author,headRefOid,baseRefName,body,files,url   # a PR
git -C <repo> rev-parse HEAD                                                     # a branch
```

- `ref` = the head **SHA**, fetched locally (`git -C <repo> fetch origin pull/<N>/head`). Base = `origin/<baseRefName>`.
- **Destination: return the report to the user** unless they asked to attach or publish it to the PR. Publishing is step 6 and only runs on that request.

## 2. Pick the boot config

- The repo has `verify.yaml` at the ref → use it.
- Else `$ACV/examples/<repo-name>/verify.yaml` → pass `--config`; run its `prepare.sh` first when present (it stages local dev keys, never hosted ones).
- Else write one under `$ACV/examples/<repo-name>/` from the repo's own QA/e2e setup (`.agents/verification-e2e-pr/`, CI workflows, Playwright `webServer`), prove it with `verify run --boot-only`, and keep it.

Heavy stacks (Next + CMS builds) need `--memory-gb 9 --cpus 6`.

## 3. Pick the mode

| Mode | When | Run |
|---|---|---|
| **independent** | `ANTHROPIC_API_KEY` is set | `verify run --repo <repo> --ref <sha> --base <base> --task-file <task.md> [--config …]` — its own model plans, tests and judges |
| **in-session** | no key, a before/after comparison, or measurements the model cannot take | you explore, then a walkthrough script drives the run (step 4) |

`task.md` = the PR title and body (or the user's description of the change). Exit code: 0 pass, 1 fail, 2 blocked.

## 4. In-session: explore, then walk through

1. Boot and keep: `verify run … --boot-only --keep --task noop`. The run dir holds `session.json`.
2. Explore with `verify drive <runDir> shot | snapshot | click-text <name> | click x y | type … | key … | navigate <url> | console | logs`. Read every screenshot it writes. Learn the exact path, selectors and texts from the app and from the diff.
3. Write `walkthrough.ts` from [`walkthrough-template.ts`](walkthrough-template.ts): declare 2–6 criteria (what the PR changes, plus one nearby flow it could break), and for each `begin` → act → `still(name, caption)` → `end(status, notes)`. Each caption is one sentence saying what the still proves.
4. Remove the kept computer (`docker rm -f $(docker ps -aq --filter label=acv.run=<runId>)`), then run for real: `verify run … --walkthrough walkthrough.ts --task-file task.md`. For a before/after, run it once per ref (the base or baseline commit, then the head) with the same script.
5. Read every still and `verdict.json`. A criterion you did not observe is `blocked`, never `pass`.

## 5. Render and report

```bash
verify render <runDir>        # polished.mp4 (<60 s, zoom, captions, verdict moments) + preview.gif
verify report <runDir>        # report.md: "## Manual verification", stills, walkthrough, notes
```

For a before/after, write one `report.md` that pairs the two runs' stills (before, then after, per point) and lists both walkthroughs. Notes say what was pre-existing, set up for the run, or not verified, and why.

**Done** = every criterion has a status backed by a still you read, `polished.mp4` plays, and the report links only files that exist. Give the user the verdict, the report path, and the media paths.

## 6. Publish (only when asked)

```bash
verify publish --pr <N> --report <report.md> --repo <repo> --dry-run
verify publish --pr <N> --report <report.md> --repo <repo> --ego-space <id>
```

Uploads media through the PR's comment box in Ego (signed in to GitHub) and swaps paths for `user-attachments` URLs. The current user's PR gets the section in its description between `<!-- ai-change-verifier:start/end -->` (replaced on re-runs, above bot footers); anyone else's PR gets a comment. Confirm with the user before the non-dry run; then open the PR and check each image loads and the video plays.

## Guardrails

- The verifier observes; code changes for a variant (a flag flipped) happen only inside the computer and are never pushed.
- Shared host state a run touches (a local database) is recorded and reverted.
- Credentials come from seed data or the user signing in; staged secret env is redacted from every log, step and report.
- `verify cleanup` removes computers and networks left by crashed runs.
