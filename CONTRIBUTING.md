# Contributing

Thanks for looking. Witness is early, so issues that describe a real app it failed on are as useful as code.

## Setup

```bash
pnpm install
pnpm image:build
pnpm typecheck && pnpm test
pnpm witness:smoke        # needs Docker
pnpm e2e:scripted         # the whole pipeline on the demo app, no API key needed
```

## How the code is written

- Effect 4 everywhere: `Context.Service` + `Layer` for anything with dependencies, `Schema.TaggedError` for expected failures, `Schema` at every boundary (files, HTTP, the model, the page). Pure math (zoom, pacing, tar headers, range parsing) stays plain functions with plain tests.
- File names are kebab-case (`docker-provider.ts`, `report-api.ts`); the services and classes inside keep their PascalCase names.
- Errors carry a specific tag and a message a person can act on. A boot failure is a `blocked` verdict, not a crash.
- Secrets never reach logs, steps, captions, transcripts or reports. If you add an output, run it through the run's redaction.
- The verifier observes. Nothing in it may edit the code under test or push anything.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org): `feat(cli): ...`, `fix(computer): ...`, `docs: ...`.
- Keep `pnpm typecheck` and `pnpm test` green. If you change the computer image or the pipeline, say which of `witness:smoke`, `e2e:scripted` and `acceptance:phase4` you ran.
- New design choices go in `DECISIONS.md` with the reason.
