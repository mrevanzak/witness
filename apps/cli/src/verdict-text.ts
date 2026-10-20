// How a verdict reads in the terminal, for `run` and `act finish` alike.
import { isVerdict, type VerdictFile } from "@witness/domain"
import { Console, Effect, Option } from "effect"

/** Prints a verdict (or why there is none) under `heading`, e.g. "before (base commit): ". */
export const printVerdict = Effect.fnUntraced(function* (heading: string, v: VerdictFile) {
	if (!isVerdict(v)) {
		yield* Console.log(`${heading}BLOCKED (${v.reason}): ${v.notes}`)
		if (v.log_tail) {
			yield* Console.log(`--- log tail ---\n${v.log_tail}`)
		}
		return
	}
	yield* Console.log(`\n${heading}${v.overall.toUpperCase()}`)
	for (const c of v.criteria) {
		yield* Console.log(
			`  ${c.id} ${c.status.padEnd(7)} ${c.description}${Option.match(c.video_ts, { onNone: () => "", onSome: ([a, b]) => `  [${a}s-${b}s]` })}`
		)
	}
	if (v.usage.usd > 0) {
		yield* Console.log(`  model spend ≈ $${v.usage.usd.toFixed(2)}`)
	}
})
