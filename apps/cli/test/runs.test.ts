import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { withWitnessIgnored } from "../src/runs.ts"

describe("withWitnessIgnored", () => {
	it("appends .witness/ to an existing .gitignore", () => {
		expect(Option.getOrThrow(withWitnessIgnored("node_modules/\n"))).toBe(
			"node_modules/\n# Witness runs (recordings, screenshots, verdicts)\n.witness/\n"
		)
	})
	it("adds the missing newline first", () => {
		expect(Option.getOrThrow(withWitnessIgnored("dist"))).toMatch(/^dist\n# Witness/)
	})
	it("creates the file's text from nothing", () => {
		expect(Option.getOrThrow(withWitnessIgnored(""))).toMatch(/^# Witness.*\n\.witness\/\n$/)
	})
	it("leaves a .gitignore that already ignores it", () => {
		for (const line of [".witness", ".witness/", "/.witness", "/.witness/", "  .witness/  "]) {
			expect(Option.isNone(withWitnessIgnored(`dist\n${line}\n`))).toBe(true)
		}
	})
})
