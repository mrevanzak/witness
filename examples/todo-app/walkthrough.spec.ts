// Walkthrough for the todo app's empty-title change, as a Playwright spec:
//   witness run --repo runs/fixtures/todo-app --ref feat/empty-title --base main \
//     --task "Validate empty todo titles" --walkthrough examples/todo-app/walkthrough.spec.ts
// Each test is a criterion, test.step titles are the video's captions, and each
// attached screenshot is a still whose name is its caption.
import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
	await page.goto("/")
	test.info().annotations.push({ description: "Fresh browser profile; the app seeds two todos.", type: "intro" })
})

test("Submitting an empty title shows 'Title is required' and adds nothing", async ({ page }) => {
	await test.step("Submit with an empty title", async () => {
		await page.getByRole("button", { name: "Add todo" }).click()
	})
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
