// Walkthrough template: a plain Playwright spec. Copy it next to the run's task
// file, replace the tests with the path you learned in a session, and run it with
//   witness run ... --walkthrough walkthrough.spec.ts --task-file task.md
// baseURL is the app's url from witness.yaml. Each test is a criterion (tag it
// @regression for a regression check), test.step titles are the video's captions,
// and each attached screenshot is a still whose name is its caption. Annotations
// of type "notes" (a criterion's notes), "intro", "preview" and "note" feed the report.
import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
	await page.goto("/")
	test.info().annotations.push({ description: "Fresh browser profile; the app seeds two todos.", type: "intro" })
})

test("Submitting an empty title shows 'Title is required' and adds nothing", async ({ page }) => {
	await test.step("Submit with an empty title", async () => {
		await page.getByRole("button", { name: "Add todo" }).click()
	})
	// Attach before asserting, so the still exists when the check fails.
	await test.info().attach("The form right after submitting an empty title.", {
		body: await page.screenshot(),
		contentType: "image/png",
	})
	await test.step("Check the error and the counter", async () => {
		await expect(page.locator("#title-error")).toHaveText("Title is required")
		await expect(page.locator("#count")).toHaveText(/^2 /)
	})
})

test("Adding a normal todo still works", { tag: "@regression" }, async ({ page }) => {
	await test.step("Add 'Buy bread'", async () => {
		await page.getByPlaceholder("What needs doing?").fill("Buy bread")
		await page.keyboard.press("Enter")
	})
	await expect(page.getByText("Buy bread")).toBeVisible()
	await test.info().attach("'Buy bread' is added to the list.", {
		body: await page.screenshot(),
		contentType: "image/png",
	})
})
