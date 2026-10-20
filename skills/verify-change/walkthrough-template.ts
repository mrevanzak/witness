// Walkthrough for `verify run --walkthrough <this file>`. Copy it next to the run's
// task file, then replace the criteria and steps with the path you explored.
// Coordinates are screen pixels (1920x1080); prefer clickText / findElement.
import type { Walkthrough } from "@acv/orchestrator";

const walkthrough: Walkthrough = async (w) => {
	const origin = new URL(w.cfg.url).origin;
	w.preview(`production build of \`${w.change.repo.sha.slice(0, 7)}\` in a fresh ai-change-verifier computer, at \`${w.cfg.url}\`.`);
	w.intro("Fresh browser profile; seeded test data.");

	w.criterion("C1", "feature", "What the change should now do, phrased as pass/fail");
	w.criterion("C2", "regression", "A nearby existing flow still works");

	await w.begin("C1");
	await w.navigate(`${origin}/`, "Open the app");
	await w.waitFor(`document.querySelector("main")`);
	await w.clickText("Some button", "Click the button the change touched");
	await w.waitFor(`document.body.innerText.includes("Expected text")`, { timeoutMs: 15_000 });
	const seen = await w.evaluate<boolean>(`document.body.innerText.includes("Expected text")`);
	await w.still("c1-result", "After clicking the button, the expected text appears.");
	await w.end("C1", seen ? "pass" : "fail", seen ? "Expected text shown." : "Expected text never appeared.");

	await w.begin("C2");
	// ...
	await w.end("C2", "pass", "What was seen.");

	w.note("Anything pre-existing, set up for this run, or not verified (and why).");
};

export default walkthrough;
