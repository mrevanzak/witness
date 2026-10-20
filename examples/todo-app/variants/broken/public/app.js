const form = document.getElementById("new-todo")
const input = document.getElementById("title")
const list = document.getElementById("list")
const count = document.getElementById("count")

async function api(path, init) {
	const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init })
	return res.status === 204 ? null : res.json()
}

function render(todos) {
	list.replaceChildren(
		...todos.map((t) => {
			const li = document.createElement("li")
			li.className = t.done ? "done" : ""
			const box = Object.assign(document.createElement("input"), { checked: t.done, type: "checkbox" })
			box.setAttribute("aria-label", `Mark "${t.title}" done`)
			box.onchange = async () => {
				await api(`/api/todos/${t.id}`, { body: JSON.stringify({ done: box.checked }), method: "PATCH" })
				load()
			}
			const label = Object.assign(document.createElement("span"), { textContent: t.title })
			const del = Object.assign(document.createElement("button"), { className: "delete", textContent: "Delete" })
			del.setAttribute("aria-label", `Delete "${t.title}"`)
			del.onclick = async () => {
				await api(`/api/todos/${t.id}`, { method: "DELETE" })
				load()
			}
			li.append(box, label, del)
			return li
		})
	)
	const left = todos.filter((t) => !t.done).length
	count.textContent = `${left} item${left === 1 ? "" : "s"} left`
}

async function load() {
	render(await api("/api/todos"))
}

const error = document.getElementById("title-error")

form.addEventListener("submit", async (e) => {
	e.preventDefault()
	if (input.value === "") {
		error.textContent = "Title is required"
	}
	await api("/api/todos", { body: JSON.stringify({ title: input.value }), method: "POST" })
	input.value = ""
	load()
})

load()
