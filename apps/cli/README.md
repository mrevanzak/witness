# Witness

Witness checks a code change the way a QA tester would, then hands you the evidence. Point it at a branch or a pull request. It boots the app in a fresh Linux desktop, works out what the change should do, uses the app with a mouse and keyboard, and records everything. You get a verdict per criterion, stills, a short edited video, and a report you can drop into the PR or share as a link.

It never edits code and it doesn't take the coding agent's word for anything. It only reports what it saw.

## Install

You need Docker (OrbStack works well on macOS), Node 22.18 or newer, and ffmpeg.

```bash
npm install -g @mrevanzak/witness
witness image             # builds the computer image once: Xvfb, Chromium, ffmpeg, control server
```

## Use

```bash
witness init --repo ../my-app                      # drafts witness.yaml: how to boot the app
witness run --repo ../my-app --boot-only           # proves the app boots
witness run --repo ../my-app --ref feat/x --base main --task "Empty todo titles are rejected" --session
witness act …                                      # drive the session, one recorded action at a time
witness render .witness/runs/<run-id>              # polished.mp4 + preview.gif
witness report .witness/runs/<run-id>              # report.md, ready for the PR description
```

Runs are recorded under `.witness/runs/` at the root of the git repo you run `witness` from. Exit codes: 0 pass, 1 fail, 2 blocked, 3 usage error.

`witness --help` lists every command. The full guide (the three ways to drive a run, `witness.yaml`, before and after, publishing evidence, the Claude Code skill) is in the [repository](https://github.com/mrevanzak/witness#readme).

## License

MIT
