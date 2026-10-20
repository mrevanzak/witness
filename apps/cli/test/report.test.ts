import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { BlockedVerdict, Still, Usage, Verdict, VerdictCriterion, WalkthroughReport } from "@witness/domain"
import { Effect, Option, Schema } from "effect"
import { BEFORE_DIR, beforeRun, writeRunReport } from "../src/index.ts"

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
const sessionRun = (dir: string, status: "pass" | "fail", stills: readonly string[]) => {
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

describe("before/after runs", () => {
	it.effect("pairs stills by name and keeps before stills that have no counterpart", () =>
		run(
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "witness-report-"))
				sessionRun(dir, "pass", ["empty-title"])
				sessionRun(join(dir, BEFORE_DIR), "fail", ["empty-title", "counter"])

				const before = yield* beforeRun(dir)
				assert.deepStrictEqual(before, Option.some({ blocked: Option.none(), dir: join(dir, BEFORE_DIR) }))

				const report = readFileSync(yield* writeRunReport(dir), "utf8")
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

				const before = yield* beforeRun(dir)
				assert.deepStrictEqual(
					Option.flatMap(before, (b) => b.blocked),
					Option.some("setup: pnpm install failed")
				)
				const report = readFileSync(yield* writeRunReport(dir), "utf8")
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
				assert.isTrue(Option.isNone(yield* beforeRun(dir)))
			})
		)
	)
})
