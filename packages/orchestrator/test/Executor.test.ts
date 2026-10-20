import { assert, describe, it } from "@effect/vitest"
import { buildTools } from "../src/Executor.ts"

describe("buildTools", () => {
	it("defines strict schemas with every property required", () => {
		for (const t of buildTools(true)) {
			const s = t.input_schema as unknown as { properties: Record<string, unknown>; required: Array<string>; additionalProperties: boolean }
			assert.isTrue(t.strict)
			assert.isFalse(s.additionalProperties)
			assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort())
		}
	})
	it("offers type_secret only when a password is configured", () => {
		assert.include(buildTools(true).map((t) => t.name), "type_secret")
		assert.notInclude(buildTools(false).map((t) => t.name), "type_secret")
	})
	it("has no tool that edits code or runs commands", () => {
		const names = buildTools(true).map((t) => t.name)
		for (const banned of ["bash", "exec", "shell", "write_file", "edit", "git"]) assert.notInclude(names, banned)
	})
})
