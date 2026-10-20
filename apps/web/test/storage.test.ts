import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { newReportId } from "../src/api.ts"
import { contentTypeOf, parseRange } from "../src/storage.ts"

describe("parseRange", () => {
	it("handles open, closed and suffix ranges", () => {
		assert.deepStrictEqual(parseRange("bytes=0-99", 1000), Option.some({ offset: 0, length: 100 }))
		assert.deepStrictEqual(parseRange("bytes=900-", 1000), Option.some({ offset: 900, length: 100 }))
		assert.deepStrictEqual(parseRange("bytes=-100", 1000), Option.some({ offset: 900, length: 100 }))
		assert.deepStrictEqual(parseRange("bytes=990-5000", 1000), Option.some({ offset: 990, length: 10 }))
	})
	it("ignores missing, malformed and unsatisfiable ranges", () => {
		for (const h of [undefined, "", "bytes=-", "items=0-1", "bytes=5-2", "bytes=1000-"]) assert.isTrue(Option.isNone(parseRange(h, 1000)))
	})
})

describe("report ids", () => {
	it("are 22 base62 chars and do not repeat", () => {
		const ids = new Set(Array.from({ length: 2000 }, () => newReportId()))
		assert.strictEqual(ids.size, 2000)
		for (const id of ids) assert.match(id, /^[0-9A-Za-z]{22}$/)
	})
})

describe("contentTypeOf", () => {
	it("maps media extensions", () => {
		assert.strictEqual(contentTypeOf("after-video.mp4"), "video/mp4")
		assert.strictEqual(contentTypeOf("x.PNG"), "image/png")
		assert.strictEqual(contentTypeOf("x.bin"), "application/octet-stream")
	})
})
