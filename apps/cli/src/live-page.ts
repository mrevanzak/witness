// The live view page (served by Live.ts). Self-contained: fonts from Google Fonts,
// no other external code. Same tokens as the walkthrough video.
export const LIVE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Witness live</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
	:root {
		--ink: #0e0f10; --surface: #17181b; --hairline: #2a2c30; --paper: #e7e5e0;
		--muted: #8b8984; --faint: #55575c; --pass: #4cc38a; --fail: #f2555a; --blocked: #e2a336;
		--sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
	}
	* { box-sizing: border-box; }
	html, body { margin: 0; height: 100%; background: var(--ink); color: var(--paper); font: 15px/1.45 var(--sans); }
	header { display: flex; align-items: baseline; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--hairline); }
	.brand { font: 500 15px var(--mono); }
	.meta { font: 13px var(--mono); color: var(--muted); }
	.phase { margin-left: auto; font: 13px var(--mono); color: var(--muted); text-align: right; }
	.chip { font: 500 12px var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; border: 1px solid currentColor; color: var(--muted); }
	.chip.pass { color: var(--pass); } .chip.fail { color: var(--fail); } .chip.blocked { color: var(--blocked); } .chip.checking { color: var(--paper); }
	main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; padding: 20px; height: calc(100% - 53px); }
	.screen { position: relative; border-radius: 8px; overflow: hidden; background: var(--surface); box-shadow: 0 0 0 1px var(--hairline); aspect-ratio: 16 / 9; align-self: start; width: 100%; }
	/* noVNC lite draws a 25px status bar above the desktop: crop it off. */
	.screen iframe { position: absolute; left: 0; top: -25px; width: 100%; height: calc(100% + 25px); border: 0; }
	.screen .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font: 14px var(--mono); padding: 24px; text-align: center; }
	.live { position: absolute; top: 12px; left: 12px; font: 500 12px var(--mono); letter-spacing: .1em; color: var(--paper); background: #0e0f10d9; border: 1px solid var(--hairline); border-radius: 4px; padding: 2px 8px; display: none; }
	.live::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--fail); margin-right: 7px; vertical-align: 1px; }
	aside { display: flex; flex-direction: column; min-height: 0; }
	h2 { font: 500 12px var(--mono); letter-spacing: .12em; color: var(--muted); margin: 0; padding-bottom: 10px; border-bottom: 1px solid var(--hairline); }
	.criteria { list-style: none; margin: 0 0 20px; padding: 0; }
	.criteria li { padding: 12px 0 12px 12px; border-bottom: 1px solid var(--hairline); border-left: 2px solid transparent; margin-left: -14px; }
	.criteria li.checking { border-left-color: var(--paper); }
	.criteria .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
	.criteria .id { font: 14px var(--mono); }
	.criteria .desc { color: var(--muted); }
	.criteria li.checking .desc { color: var(--paper); }
	.criteria li.pending .id, .criteria li.pending .desc { color: var(--faint); }
	.steps { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 120px; }
	.steps li { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 7px 0; border-bottom: 1px solid #1d1f22; }
	.steps .t { font: 13px var(--mono); color: var(--faint); }
	.steps .tool { font: 12px var(--mono); color: var(--faint); }
	.steps .end-pass { color: var(--pass); } .steps .end-fail { color: var(--fail); } .steps .end-blocked { color: var(--blocked); }
	.empty-note { color: var(--faint); font: 13px var(--mono); padding: 10px 0; }
	@media (max-width: 900px) { main { grid-template-columns: 1fr; height: auto; } .steps { max-height: 50vh; } }
	@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
</head>
<body>
<header>
	<span class="brand">witness</span>
	<span class="meta" id="meta">waiting for the run…</span>
	<span class="phase" id="phase"></span>
	<span class="chip" id="overall">running</span>
</header>
<main>
	<section class="screen" aria-label="The computer's desktop, live">
		<div class="empty" id="screen-empty">Starting the computer…</div>
		<span class="live" id="live">LIVE</span>
	</section>
	<aside>
		<h2>CRITERIA</h2>
		<ul class="criteria" id="criteria"><li class="empty-note">Planning…</li></ul>
		<h2>STEPS</h2>
		<ol class="steps" id="steps" aria-live="polite"></ol>
	</aside>
</main>
<script>
	const $ = (id) => document.getElementById(id);
	const criteria = new Map();
	let firstAt = null;
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

	function renderCriteria() {
		if (!criteria.size) return;
		$("criteria").innerHTML = [...criteria.entries()].map(([id, c]) => {
			const done = ["pass", "fail", "blocked"].includes(c.state);
			const badge = done ? '<span class="chip ' + c.state + '">' + c.state + '</span>' : '<span class="chip ' + (c.state === "checking" ? "checking" : "") + '">' + c.state + '</span>';
			return '<li class="' + c.state + '"><div class="row"><span class="id">' + esc(id) + ' · ' + esc(c.kind) + '</span>' + badge + '</div><div class="desc">' + esc(c.description) + '</div></li>';
		}).join("");
	}
	const declare = (c) => { if (!criteria.has(c.id)) criteria.set(c.id, { kind: c.kind, description: c.description, state: "pending" }); renderCriteria(); };
	const setState = (id, state) => { const c = criteria.get(id); if (c) { c.state = state; renderCriteria(); } };

	function addStep(step) {
		if (firstAt === null) firstAt = step.at;
		const t = Math.max(0, (step.at - firstAt) / 1000).toFixed(1);
		let text = step.label || step.tool;
		let cls = "";
		if (step.tool === "end_criterion") cls = "end-" + step.status;
		if (step.tool === "still") return;
		if (!step.label && !["page_snapshot", "console_logs", "network_errors", "app_logs"].includes(step.tool)) return;
		if (!step.label) text = step.tool.replace("_", " ");
		const li = document.createElement("li");
		li.innerHTML = '<span class="t">' + t + 's</span><span class="' + cls + (step.label ? '' : ' tool') + '">' + esc(text) + '</span>';
		const list = $("steps");
		const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
		list.appendChild(li);
		if (atBottom) list.scrollTop = list.scrollHeight;
	}

	const PHASES = { "run.start": "resolving the change", "source": "uploading the source", "computer.created": "computer is up", "boot.source": "source in place", "boot.setup": "running setup", "boot.start": "starting the app", "boot.ok": "app is up", "plan.start": "planning", "plan.done": "checking", "execute.done": "reviewing", "verdict": "done" };

	function onEvent(e) {
		if (e.type === "step") {
			const s = e.step;
			if (s.tool === "begin_criterion") setState(s.criterion, "checking");
			if (s.tool === "end_criterion") setState(s.criterion, s.status);
			return addStep(s);
		}
		const d = e.data || {};
		if (PHASES[e.event]) $("phase").textContent = PHASES[e.event] + (e.event === "boot.setup" && d.cmd ? " · " + d.cmd : "");
		if (e.event === "run.start") { $("meta").textContent = (d.sha || "").slice(0, 7) + " · " + d.mode; runDir = d.runDir || ""; }
		if (e.event === "computer.created") {
			if (d.liveView) {
				$("screen-empty").remove();
				const f = document.createElement("iframe");
				f.src = d.liveView; f.title = "The computer's desktop";
				document.querySelector(".screen").prepend(f);
				$("live").style.display = "inline-block";
			} else $("screen-empty").textContent = "Live desktop is off for this run (start it with --live).";
		}
		if (e.event === "plan.done" && Array.isArray(d.criteria)) d.criteria.forEach(declare);
		if (e.event === "criterion.declared") declare(d);
		if (e.event === "verdict" || e.event === "run.blocked" || e.event === "boot.blocked") {
			const overall = d.overall || "blocked";
			$("overall").textContent = overall; $("overall").className = "chip " + overall;
			if (d.message) $("phase").textContent = d.message;
			$("live").style.display = "none";
			finish(e.event === "verdict" ? "Run finished. The computer is gone; the recording and report are in the run folder." : "The run stopped before a verdict.");
		}
	}

	// The computer is torn down after the verdict: show where the evidence is instead of a dead stream.
	function finish(text) {
		const f = document.querySelector(".screen iframe");
		if (f) f.remove();
		let empty = $("screen-empty");
		if (!empty) { empty = document.createElement("div"); empty.className = "empty"; empty.id = "screen-empty"; document.querySelector(".screen").prepend(empty); }
		empty.textContent = text + (runDir ? "\\n" + runDir : "");
		empty.style.whiteSpace = "pre-line";
	}
	let runDir = "";

	const source = new EventSource("/events");
	source.onmessage = (m) => onEvent(JSON.parse(m.data));
	source.onerror = () => { $("phase").textContent = "run finished (live view closed)"; $("live").style.display = "none"; source.close(); };
</script>
</body>
</html>
`
