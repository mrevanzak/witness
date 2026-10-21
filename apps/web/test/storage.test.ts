import { assert, describe, it } from "@effect/vitest"
import { ReportManifest, ReportSection, Usage, Verdict } from "@witness/domain"
import { Effect, Layer, Option } from "effect"
import { newReportId } from "../src/api.ts"
import { Bindings, contentTypeOf, parseRange, ReportStore } from "../src/storage.ts"

/** The few R2Bucket calls ReportStore makes, over a Map. */
const memoryBucket = () => {
	const objects = new Map<string, string>()
	const object = (k: string) => {
		const v = objects.get(k)
		return v === undefined ? null : { text: async () => v }
	}
	return {
		delete: async (k: string) => void objects.delete(k),
		get: async (k: string) => object(k),
		head: async (k: string) => object(k),
		put: async (k: string, v: string) => void objects.set(k, v),
	} as unknown as R2Bucket
}

const store = (media: R2Bucket) =>
	ReportStore.layer.pipe(Layer.provide(Layer.succeed(Bindings, { media, publicUrl: Option.none(), uploadToken: "" })))

const manifest = new ReportManifest({
	createdAt: "2026-10-21T00:00:00.000Z",
	intro: "",
	notes: [],
	preview: "",
	sections: [
		new ReportSection({
			seek: {},
			sha: "abc1234",
			stills: [],
			verdict: new Verdict({
				console_errors: [],
				criteria: [],
				duration_s: null,
				model: "session",
				network_errors: [],
				notes: "",
				overall: "pass",
				stopped_because: "done",
				summary: "",
				usage: new Usage({ cache_read_tokens: 0, input_tokens: 0, output_tokens: 0, requests: 0, usd: 0 }),
			}),
		}),
	],
	title: "t",
})

describe("ReportStore", () => {
	it.effect("shows a report only once it is finalized", () =>
		Effect.gen(function* () {
			const s = yield* ReportStore
			const id = newReportId()
			assert.isTrue(Option.isNone(yield* s.status(id)))
			yield* s.create(id, manifest)
			assert.deepStrictEqual(yield* s.status(id), Option.some("uploading"))
			assert.isTrue(Option.isNone(yield* s.manifest(id)))
			yield* s.finalize(id)
			yield* s.finalize(id)
			assert.deepStrictEqual(yield* s.status(id), Option.some("ready"))
			assert.strictEqual(Option.getOrThrow(yield* s.manifest(id)).title, "t")
		}).pipe(Effect.provide(store(memoryBucket())))
	)
})

describe("parseRange", () => {
	it("handles open, closed and suffix ranges", () => {
		assert.deepStrictEqual(parseRange("bytes=0-99", 1000), Option.some({ length: 100, offset: 0 }))
		assert.deepStrictEqual(parseRange("bytes=900-", 1000), Option.some({ length: 100, offset: 900 }))
		assert.deepStrictEqual(parseRange("bytes=-100", 1000), Option.some({ length: 100, offset: 900 }))
		assert.deepStrictEqual(parseRange("bytes=990-5000", 1000), Option.some({ length: 10, offset: 990 }))
	})
	it("ignores missing, malformed and unsatisfiable ranges", () => {
		for (const h of [undefined, "", "bytes=-", "items=0-1", "bytes=5-2", "bytes=1000-"]) {
			assert.isTrue(Option.isNone(parseRange(h, 1000)))
		}
	})
})

describe("report ids", () => {
	it("are 22 base62 chars and do not repeat", () => {
		const ids = new Set(Array.from({ length: 2000 }, () => newReportId()))
		assert.strictEqual(ids.size, 2000)
		for (const id of ids) {
			assert.match(id, /^[0-9A-Za-z]{22}$/)
		}
	})
})

describe("contentTypeOf", () => {
	it("maps media extensions", () => {
		assert.strictEqual(contentTypeOf("after-video.mp4"), "video/mp4")
		assert.strictEqual(contentTypeOf("x.PNG"), "image/png")
		assert.strictEqual(contentTypeOf("x.bin"), "application/octet-stream")
	})
})
