import { ReportManifest, ReportSection, Usage, Verdict, VerdictCriterion } from "@witness/domain"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { referencedMedia } from "../src/publish.ts"
import { hostedSection } from "../src/upload.ts"

const criterion = (id: string, status: "pass" | "fail", kind: "feature" | "regression" = "feature") =>
	new VerdictCriterion({
		description: `${id} works`,
		executor_status: status,
		explanation: "saw a | b",
		id,
		kind,
		screenshot: Option.none(),
		status,
		video_ts: Option.none(),
	})

const section = (label: string, overall: "pass" | "fail", gif?: string) =>
	new ReportSection({
		label,
		seek: { C1: [65, 72] },
		sha: "abc1234",
		stills: [],
		verdict: new Verdict({
			console_errors: [],
			criteria: [criterion("C1", overall), criterion("C2", "pass", "regression")],
			duration_s: null,
			model: "session",
			network_errors: [],
			notes: "",
			overall,
			stopped_because: "done",
			summary: "",
			usage: new Usage({ cache_read_tokens: 0, input_tokens: 0, output_tokens: 0, requests: 0, usd: 0 }),
		}),
		...(gif ? { gif } : {}),
	})

const manifest = (sections: readonly ReportSection[]) =>
	new ReportManifest({
		createdAt: "2026-10-20T00:00:00Z",
		intro: "",
		notes: ["Seeded one todo"],
		overall: sections[0]!.verdict.overall,
		preview: "production build in a fresh computer",
		sections,
		title: "Empty titles",
	})

describe("hostedSection", () => {
	const url = "https://reports.example/r/abcdefghijklmnopqrstuv"

	it("links the page and lists the criteria without local media", () => {
		const md = hostedSection(manifest([section("run", "pass", "run-preview.gif")]), url)
		expect(md).toMatch(/^## Manual verification\n/)
		expect(md).toContain(`[![Walkthrough preview](${url}/run-preview.gif)](${url})`)
		expect(md).toContain(`✅ **pass** · [Full report: video, stills and logs](${url})`)
		expect(md).toContain("| ✅ pass | C1 C1 works | 1:05–1:12 | saw a \\| b |")
		expect(md).toContain("| ✅ pass | C2 (regression) C2 works | – |")
		expect(md).toContain("- Seeded one todo")
		// Nothing for `publish` to upload, so it needs no Ego browser.
		expect(referencedMedia(md)).toEqual([])
	})

	it("shows both verdicts for a before/after, the after first", () => {
		const md = hostedSection(manifest([section("after", "pass"), section("before", "fail")]), url)
		expect(md).toContain("after: ✅ **pass** · before: ❌ **fail** · [Full report")
		expect(md).not.toContain("Walkthrough preview")
	})
})
