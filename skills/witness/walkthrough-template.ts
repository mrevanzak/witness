// Walkthrough template (in-session mode): copy next to the run's task file and
// replace the criteria and steps with the path you explored. Run it with
//   witness run ... --walkthrough walkthrough.ts --task-file task.md
import { Walkthrough } from "@witness/orchestrator"
import { Effect } from "effect"

export default Effect.gen(function* () {
	const w = yield* Walkthrough
	yield* w.preview(`production build of \`${w.change.repo.sha.slice(0, 7)}\` in a fresh Witness computer, at \`${w.config.url}\`.`)
	yield* w.intro("Fresh browser profile; the app seeds two todos.")

	yield* w.criterion("C1", "feature", "Submitting an empty title shows 'Title is required' and adds nothing")
	yield* w.criterion("C2", "regression", "Adding a normal todo still works")

	yield* w.begin("C1")
	yield* w.clickText("Add todo", "Submit with an empty title", { tag: "button" })
	yield* w.wait(600)
	const c1 = yield* w.evaluate<{ error: string; left: string }>(`({ error: document.getElementById("title-error")?.textContent ?? "", left: document.getElementById("count")?.textContent ?? "" })`)
	yield* w.still("empty-title", `Submitting an empty title: error text "${c1.error || "(none)"}", counter "${c1.left}".`)
	const c1ok = c1.error.includes("Title is required") && c1.left.startsWith("2 ")
	yield* w.end("C1", c1ok ? "pass" : "fail", `Error text ${c1.error ? `"${c1.error}"` : "not shown"}; counter says "${c1.left}" (was 2 items left).`)

	yield* w.begin("C2")
	yield* w.clickText("What needs doing", "Focus the title field", { tag: "input" })
	yield* w.type("Buy bread", "Type 'Buy bread'")
	yield* w.key("Return", "Press Enter to add")
	yield* w.waitFor(`document.body.innerText.includes("Buy bread")`, { timeoutMs: 5000 }).pipe(Effect.ignore)
	const added = yield* w.evaluate<boolean>(`document.body.innerText.includes("Buy bread")`)
	yield* w.still("normal-todo", added ? "A normal todo is added to the list." : "The normal todo did not appear.")
	yield* w.end("C2", added ? "pass" : "fail", added ? "'Buy bread' is in the list." : "'Buy bread' did not appear.")
})
