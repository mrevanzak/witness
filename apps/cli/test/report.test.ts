import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
	BEFORE_DIR,
	BlockedVerdict,
	loadRunPair,
	RunInfo,
	Still,
	Usage,
	Verdict,
	VerdictCriterion,
	WalkthroughReport,
} from "@witness/domain"
import { Effect, Option, Schema } from "effect"
import { noReportOptions, writeReport } from "../src/report.ts"

const write = <A, I>(file: string, schema: Schema.Codec<A, I>, value: A) => {
	mkdirSync(join(file, ".."), { recursive: true })
	writeFileSync(file, Schema.encodeSync(Schema.fromJsonString(schema))(value))
}

const verdict = (status: "pass" | "fail") =>
	new Verdict({
		console_errors: [],
		criteria: [
			new VerdictCriterion({
				description: "An empty title shows an error",
				executor_status: status,
				explanation: status === "pass" ? "The error shows." : "A blank todo was added.",
				id: "C1",
				kind: "feature",
				screenshot: Option.some(`c1-${status}.png`),
				status,
				video_ts: Option.none(),
			}),
		],
		duration_s: 10,
		model: "in-session",
		network_errors: [],
		notes: "",
		overall: status,
		stopped_because: "done",
		summary: "",
		usage: new Usage({ cache_read_tokens: 0, input_tokens: 0, output_tokens: 0, requests: 0, usd: 0 }),
	})

/** A finished session run: its verdict and the stills it took. */
const info = (sha: string) =>
	new RunInfo({ base: null, id: "r", prefix: "", ref: "HEAD", repo: "/repo", sha, startedAt: "", task: "Empty titles" })

const sessionRun = (dir: string, status: "pass" | "fail", stills: readonly string[]) => {
	write(join(dir, "run.json"), RunInfo, info(status === "pass" ? "aaaaaaa1" : "bbbbbbb2"))
	write(join(dir, "verdict.json"), Verdict, verdict(status))
	write(
		join(dir, "walkthrough.json"),
		WalkthroughReport,
		new WalkthroughReport({
			intro: "",
			notes: [],
			preview: "",
			stills: stills.map((name, i) => {
				const file = `stills/0${i + 1}-${name}.png`
				mkdirSync(join(dir, "stills"), { recursive: true })
				writeFileSync(join(dir, file), "png")
				return new Still({ at: 0, caption: `${name} (${status})`, file })
			}),
		})
	)
}

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	effect.pipe(Effect.provide(NodeServices.layer))

const reportFor = (dir: string) =>
	loadRunPair(dir).pipe(
		Effect.flatMap((pair) => writeReport(pair, dir, { ...noReportOptions, bundle: false })),
		Effect.map((file) => readFileSync(file, "utf8"))
	)

describe("before/after runs", () => {
	it.effect("pairs stills by name and keeps before stills that have no counterpart", () =>
		run(
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "witness-report-"))
				sessionRun(dir, "pass", ["empty-title"])
				sessionRun(join(dir, BEFORE_DIR), "fail", ["empty-title", "counter"])

				const pair = yield* loadRunPair(dir)
				assert.deepStrictEqual(
					Option.map(pair.before, (b) => b.dir),
					Option.some(join(dir, BEFORE_DIR))
				)

				const report = yield* reportFor(dir)
				const order = ["**Before:** empty-title (fail)", "**After:** empty-title (pass)", "**Before:** counter (fail)"]
				const at = order.map((line) => report.indexOf(line))
				assert.isTrue(
					at.every((i) => i >= 0),
					report
				)
				assert.deepStrictEqual(
					at,
					[...at].sort((a, b) => a - b)
				)
				assert.include(report, "| Criterion | Before | After |")
				assert.include(report, "❌ fail: A blank todo was added. | ✅ pass: The error shows. |")
				// Media are linked where they are: the before run's inside its folder.
				assert.include(report, "](./before/stills/01-empty-title.png)")
				assert.include(report, "Preview: before = bbbbbbb; after = aaaaaaa")
			})
		)
	)

	it.effect("reports the change alone, with a note, when the before run was blocked", () =>
		run(
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "witness-report-"))
				sessionRun(dir, "pass", ["empty-title"])
				write(
					join(dir, BEFORE_DIR, "verdict.json"),
					BlockedVerdict,
					new BlockedVerdict({ notes: "setup: pnpm install failed", overall: "blocked", reason: "app_failed_to_boot" })
				)

				const pair = yield* loadRunPair(dir)
				assert.isTrue(Option.isNone(pair.before))
				assert.deepStrictEqual(pair.notes, [
					"The base commit could not be checked, so there is no before state: setup: pnpm install failed",
				])
				const report = yield* reportFor(dir)
				assert.notInclude(report, "**Before:**")
				assert.include(report, "no before state: setup: pnpm install failed")
			})
		)
	)

	it.effect("finds no before run in a single run", () =>
		run(
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "witness-report-"))
				sessionRun(dir, "pass", [])
				assert.isTrue(Option.isNone((yield* loadRunPair(dir)).before))
				const report = yield* reportFor(dir)
				assert.include(report, "| ✅ pass | C1 An empty title shows an error | – | The error shows. |")
			})
		)
	)
})
