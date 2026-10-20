"use strict"
// Witness's Playwright reporter, staged into the computer next to the spec. It
// writes one JSON line per test, step and result to `out`; the orchestrator turns
// them into criteria, steps, stills and a verdict. Only tests of `project` count
// (setup projects it depends on still run, but are not criteria).
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

// Click points from a trace.zip: each input event's point, timed by its call's start.
const TRACE_POINTS = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
out = []
for name in z.namelist():
    if not name.endswith(".trace"):
        continue
    wall = mono = None
    starts = {}
    for line in z.read(name).decode("utf-8", "replace").splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "context-options":
            wall, mono = e.get("wallTime"), e.get("monotonicTime")
        elif t == "before":
            starts[e.get("callId")] = e.get("startTime")
        elif t == "input" and e.get("point") and wall is not None and mono is not None:
            s = starts.get(e.get("callId"))
            if s is not None:
                out.append({"at": wall + (s - mono), "x": e["point"]["x"], "y": e["point"]["y"]})
print(json.dumps(out))
`

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colours from error messages
const ANSI = /\u001b\[[0-9;]*m/g
const slug = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "still"

/** Title of the innermost test.step around `step`, if any. */
const parentStep = (step) => {
	for (let p = step.parent; p; p = p.parent) {
		if (p.category === "test.step") {
			return p.title
		}
	}
}

class WitnessReporter {
	constructor(options) {
		this.out = options.out
		this.project = options.project
		this.dir = path.dirname(this.out)
		this.n = 0
		fs.mkdirSync(path.join(this.dir, "att"), { recursive: true })
		fs.writeFileSync(this.out, "")
	}

	write(event) {
		fs.appendFileSync(this.out, `${JSON.stringify(event)}\n`)
	}

	ours(test) {
		return !this.project || test.parent.project()?.name === this.project
	}

	onBegin(_config, suite) {
		this.write({ total: suite.allTests().filter((t) => this.ours(t)).length, type: "begin" })
	}

	onTestBegin(test, result) {
		if (this.ours(test)) {
			this.write({ at: result.startTime.getTime(), id: test.id, tags: test.tags, title: test.title, type: "test" })
		}
	}

	onStepBegin(test, _result, step) {
		if (!this.ours(test)) {
			return
		}
		if (step.category === "pw:api" || step.category === "test.step" || step.category.includes("attach")) {
			this.write({
				at: step.startTime.getTime(),
				category: step.category,
				id: test.id,
				parent: parentStep(step),
				title: step.title,
				type: "step",
			})
		}
	}

	onTestEnd(test, result) {
		if (!this.ours(test)) {
			return
		}
		const attachments = []
		let points = []
		for (const a of result.attachments) {
			if (a.name === "trace" && a.path) {
				try {
					points = JSON.parse(execFileSync("python3", ["-c", TRACE_POINTS, a.path], { encoding: "utf8" }))
				} catch {
					points = []
				}
				continue
			}
			if (!(a.contentType?.startsWith("image/") && (a.path || a.body))) {
				continue
			}
			this.n += 1
			const file = path.join("att", `${String(this.n).padStart(2, "0")}-${slug(a.name)}.png`)
			if (a.path) {
				fs.copyFileSync(a.path, path.join(this.dir, file))
			} else {
				fs.writeFileSync(path.join(this.dir, file), a.body)
			}
			attachments.push({ file, name: a.name })
		}
		this.write({
			annotations: [...test.annotations, ...(result.annotations ?? [])],
			at: result.startTime.getTime() + result.duration,
			attachments,
			error: (result.error?.message ?? "").replace(ANSI, ""),
			id: test.id,
			outcome: test.outcome(),
			points,
			status: result.status,
			type: "end",
		})
	}

	onEnd(result) {
		this.write({ status: result.status, type: "done" })
	}

	printsToStdio() {
		return false
	}
}

module.exports = WitnessReporter
