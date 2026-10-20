// Fits a unified diff into a character budget for the planner. Small files keep
// their full hunks; when the whole diff does not fit, the largest files are cut
// to a per-file head and the rest are summarised as "+added -removed" lines, so
// the planner still sees every changed path.

export type FileDiff = {
	added: number
	binary: boolean
	path: string
	removed: number
	text: string
}

export function splitDiff(diff: string): FileDiff[] {
	const files: FileDiff[] = []
	const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "))
	for (const text of parts) {
		const header = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"))
		const plus = text.match(/^\+\+\+ b\/(.*)$/m)?.[1]
		const path = plus ?? header.match(/ b\/(.*)$/)?.[1] ?? header
		let added = 0
		let removed = 0
		for (const line of text.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				added += 1
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				removed += 1
			}
		}
		files.push({ added, binary: /^Binary files /m.test(text), path, removed, text })
	}
	return files
}

const LOCKFILE =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/
const GENERATED =
	/(^|\/)(dist|build|\.next|out|vendor|node_modules|__generated__|generated)\/|\.min\.(js|css)$|\.map$|\.snap$/

export type DiffContext = {
	files: Array<{ path: string; added: number; removed: number; included: "full" | "head" | "summary" }>
	text: string
	truncated: boolean
}

export function fitDiff(diff: string, budget = 60_000, headChars = 4000): DiffContext {
	const files = splitDiff(diff)
	const total = files.reduce((n, f) => n + f.text.length, 0)
	const noisy = (f: FileDiff) => f.binary || LOCKFILE.test(f.path) || GENERATED.test(f.path)
	if (total <= budget && !files.some(noisy)) {
		return {
			files: files.map((f) => ({ added: f.added, included: "full", path: f.path, removed: f.removed })),
			text: diff,
			truncated: false,
		}
	}

	// Smallest real-code files first get their full text; then heads; then summaries.
	const order = [...files].sort((a, b) => Number(noisy(a)) - Number(noisy(b)) || a.text.length - b.text.length)
	const mode = new Map<FileDiff, "full" | "head" | "summary">()
	let used = 0
	const summaryCost = (f: FileDiff) => f.path.length + 40
	const reserve = files.reduce((n, f) => n + summaryCost(f), 0)
	for (const f of order) {
		if (noisy(f)) {
			mode.set(f, "summary")
			continue
		}
		if (used + f.text.length + reserve <= budget) {
			mode.set(f, "full")
			used += f.text.length
		} else if (used + headChars + reserve <= budget) {
			mode.set(f, "head")
			used += headChars
		} else {
			mode.set(f, "summary")
		}
	}

	const out: string[] = []
	const summaries: string[] = []
	for (const f of files) {
		const m = mode.get(f)!
		if (m === "full") {
			out.push(f.text)
		} else if (m === "head") {
			out.push(`${f.text.slice(0, headChars)}\n… [truncated: ${f.path} +${f.added} -${f.removed}]\n`)
		} else {
			summaries.push(
				`${f.path}: +${f.added} -${f.removed}${f.binary ? " (binary)" : LOCKFILE.test(f.path) ? " (lockfile)" : GENERATED.test(f.path) ? " (generated)" : ""}`
			)
		}
	}
	if (summaries.length) {
		out.push(`\n# Not shown (summary only):\n${summaries.join("\n")}\n`)
	}
	return {
		files: files.map((f) => ({ added: f.added, included: mode.get(f)!, path: f.path, removed: f.removed })),
		text: out.join(""),
		truncated: true,
	}
}
