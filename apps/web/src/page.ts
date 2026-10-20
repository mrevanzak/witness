// The hosted report page, rendered on the server from a ReportManifest.
import type { ReportManifest, ReportSection } from "@witness/domain"
import { Option } from "effect"

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "'": "&#39;", '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
const STATUS_WORD: Record<string, string> = { blocked: "Blocked", fail: "Fail", pass: "Pass" }

/** `code` spans from backticks, everything else escaped. */
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>")

const section = (id: string, s: ReportSection, index: number, many: boolean) => {
	const media = (f: string) => `/r/${id}/${encodeURIComponent(f)}`
	const v = s.verdict
	const failed = v.criteria.filter((c) => c.status === "fail").length
	const blocked = v.criteria.filter((c) => c.status === "blocked").length
	const counts = [
		`${v.criteria.length} criteria`,
		failed ? `${failed} failed` : "",
		blocked ? `${blocked} blocked` : "",
	]
		.filter(Boolean)
		.join(" · ")
	const criteria = v.criteria
		.map((c) => {
			const seek = s.seek[c.id]
			const time = seek
				? `<button class="seek" data-video="v${index}" data-t="${seek[0]}" aria-label="Play ${esc(c.id)} at ${mmss(seek[0])}">${mmss(seek[0])}–${mmss(seek[1])}</button>`
				: ""
			return `<li class="crit">
				<div class="crit-head"><span class="chip ${c.status}">${c.status}</span><span class="cid">${esc(c.id)}${c.kind === "regression" ? " · regression" : ""}</span>${time}</div>
				<p class="cdesc">${inline(c.description)}</p>
				<p class="cexp">${inline(c.explanation)}</p>
			</li>`
		})
		.join("")
	const stills = s.stills
		.map(
			(st) =>
				`<figure><a href="${media(st.file)}" target="_blank" rel="noopener"><img src="${media(st.file)}" alt="${esc(st.caption)}" loading="lazy" /></a><figcaption>${inline(st.caption)}</figcaption></figure>`
		)
		.join("")
	const errors = v.console_errors.length
		? `<details><summary>${v.console_errors.length} console error${v.console_errors.length === 1 ? "" : "s"}</summary><ul class="log">${v.console_errors
				.slice(0, 50)
				.map(
					(e) =>
						`<li><span class="t">${e.t === null ? "" : `${e.t.toFixed(1)}s`}</span> ${esc(e.text.slice(0, 300))}</li>`
				)
				.join("")}</ul></details>`
		: ""
	const net = v.network_errors.length
		? `<details><summary>${v.network_errors.length} failed request${v.network_errors.length === 1 ? "" : "s"}</summary><ul class="log">${v.network_errors
				.slice(0, 50)
				.map(
					(e) =>
						`<li><span class="t">${e.status ?? e.error ?? ""}</span> ${esc(e.method)} ${esc(e.url.slice(0, 200))}</li>`
				)
				.join("")}</ul></details>`
		: ""
	return `<section class="run">
		${many ? `<h2 class="run-title">${esc(s.label ?? `Run ${index + 1}`)} <span class="sha">${esc(s.sha.slice(0, 7))}</span> <span class="chip ${v.overall}">${v.overall}</span></h2>` : ""}
		<div class="watch">
			${s.video ? `<video id="v${index}" src="${media(s.video)}" controls preload="metadata" playsinline></video>` : `<div class="novideo">No video for this run.</div>`}
			<div class="side"><p class="counts">${counts}</p><ol class="criteria">${criteria}</ol></div>
		</div>
		${stills ? `<div class="stills">${stills}</div>` : ""}
		${errors}${net}
	</section>`
}

export const reportPage = (id: string, m: ReportManifest): string => {
	const many = m.sections.length > 1
	const meta = [m.repo, m.pr ? `PR #${m.pr}` : undefined, many ? undefined : m.sections[0]?.sha.slice(0, 7)]
		.filter(Boolean)
		.map((x) => esc(String(x)))
		.join(" · ")
	const created = Option.match(
		Option.liftThrowable(() => new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " "))(),
		{ onNone: () => m.createdAt, onSome: (d) => `${d} UTC` }
	)
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(m.title)} · Witness</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
	:root {
		--bg: #0e0f10; --surface: #17181b; --hairline: #2a2c30; --text: #e7e5e0; --muted: #8b8984; --faint: #5c5e63;
		--pass: #4cc38a; --fail: #f2555a; --blocked: #e2a336;
		--sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
		color-scheme: dark;
	}
	@media (prefers-color-scheme: light) {
		:root { --bg: #f6f5f2; --surface: #ffffff; --hairline: #dedcd6; --text: #18191b; --muted: #66645f; --faint: #9a9892; --pass: #18864f; --fail: #c8262c; --blocked: #a86b00; color-scheme: light; }
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 var(--sans); }
	.wrap { max-width: 1200px; margin: 0 auto; padding: 0 24px 64px; }
	header { display: flex; align-items: baseline; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--hairline); }
	.brand { font: 500 15px var(--mono); }
	.meta { font: 13px var(--mono); color: var(--muted); }
	.unlisted { margin-left: auto; font: 12px var(--mono); color: var(--faint); }
	h1 { font-size: 30px; font-weight: 600; line-height: 1.25; margin: 36px 0 8px; max-width: 46ch; }
	.verdict { display: flex; align-items: baseline; gap: 16px; margin: 0 0 18px; }
	.verdict .word { font-size: 56px; font-weight: 600; line-height: 1; }
	.verdict .when { font: 13px var(--mono); color: var(--muted); }
	.pass { color: var(--pass); } .fail { color: var(--fail); } .blocked { color: var(--blocked); }
	.preview, .intro { color: var(--muted); max-width: 80ch; margin: 0 0 10px; }
	code { font: 0.88em var(--mono); background: var(--surface); border: 1px solid var(--hairline); border-radius: 4px; padding: 0 4px; }
	.run { margin-top: 40px; }
	.run-title { font-size: 18px; font-weight: 600; display: flex; gap: 12px; align-items: center; margin: 0 0 14px; }
	.sha { font: 13px var(--mono); color: var(--muted); font-weight: 400; }
	.watch { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; align-items: start; }
	video, .novideo { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 8px; box-shadow: 0 0 0 1px var(--hairline); }
	.novideo { display: grid; place-items: center; color: var(--muted); font: 14px var(--mono); }
	.counts { font: 13px var(--mono); color: var(--muted); margin: 0 0 6px; }
	.criteria { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--hairline); }
	.crit { padding: 14px 0; border-bottom: 1px solid var(--hairline); }
	.crit-head { display: flex; align-items: center; gap: 10px; }
	.cid { font: 13px var(--mono); color: var(--muted); }
	.chip { font: 500 11px var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; border: 1px solid currentColor; }
	.seek { margin-left: auto; font: 13px var(--mono); color: var(--text); background: none; border: 1px solid var(--hairline); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
	.seek:hover { border-color: var(--muted); }
	.seek:focus-visible, a:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
	.cdesc { margin: 6px 0 4px; font-weight: 500; }
	.cexp { margin: 0; color: var(--muted); font-size: 15px; }
	.stills { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 28px; }
	figure { margin: 0; }
	figure img { width: 100%; display: block; border-radius: 6px; box-shadow: 0 0 0 1px var(--hairline); }
	figcaption { color: var(--muted); font-size: 14px; margin-top: 8px; }
	details { margin-top: 20px; border-top: 1px solid var(--hairline); padding-top: 12px; }
	summary { cursor: pointer; font: 13px var(--mono); color: var(--muted); }
	.log { list-style: none; padding: 0; margin: 10px 0 0; font: 13px var(--mono); color: var(--muted); }
	.log li { padding: 4px 0; border-bottom: 1px solid var(--hairline); overflow-wrap: anywhere; }
	.log .t { color: var(--faint); margin-right: 8px; }
	.notes { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--hairline); color: var(--muted); }
	.notes h2 { font: 500 12px var(--mono); letter-spacing: .12em; margin: 0 0 8px; }
	.notes li { margin: 6px 0; }
	footer { margin-top: 56px; font: 12px var(--mono); color: var(--faint); }
	@media (max-width: 900px) { .watch { grid-template-columns: 1fr; } .stills { grid-template-columns: 1fr; } h1 { font-size: 24px; } .verdict .word { font-size: 44px; } .wrap { padding: 0 16px 48px; } }
</style>
</head>
<body>
<div class="wrap">
	<header><span class="brand">witness</span><span class="meta">${meta}</span><span class="unlisted">unlisted report</span></header>
	<h1>${inline(m.title)}</h1>
	<div class="verdict"><span class="word ${m.overall}">${STATUS_WORD[m.overall] ?? m.overall}</span><span class="when">${esc(created)}</span></div>
	${m.preview ? `<p class="preview">${inline(m.preview)}</p>` : ""}
	${m.intro ? `<p class="intro">${inline(m.intro)}</p>` : ""}
	${m.sections.map((s, i) => section(id, s, i, many)).join("")}
	${m.notes.length ? `<div class="notes"><h2>NOTES</h2><ul>${m.notes.map((n) => `<li>${inline(n)}</li>`).join("")}</ul></div>` : ""}
	<footer>Unlisted: anyone with this link can view it. Recorded and judged by Witness.</footer>
</div>
<script>
	for (const b of document.querySelectorAll(".seek")) {
		b.addEventListener("click", () => {
			const v = document.getElementById(b.dataset.video);
			if (!v) return;
			v.currentTime = Number(b.dataset.t);
			v.play();
			v.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
		});
	}
</script>
</body>
</html>`
}

export const notFoundPage = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>Not found · Witness</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f10;color:#e7e5e0;font:16px/1.5 ui-monospace,monospace}p{color:#8b8984}</style></head>
<body><main><h1>No report here</h1><p>The link may be mistyped, or the report was deleted.</p></main></body></html>`
