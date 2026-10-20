// Tiny todo app: static UI + in-memory JSON API. No dependencies.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const portArg = process.argv.indexOf("--port");
const port = Number((portArg >= 0 && process.argv[portArg + 1]) || process.env.PORT || 3000);
const PUBLIC = join(import.meta.dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

let nextId = 1;
const todos = (process.env.TODO_SEED ?? "")
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean)
	.map((title) => ({ id: nextId++, title, done: false }));

const send = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

const readJson = (req) =>
	new Promise((resolve) => {
		let s = "";
		req.on("data", (c) => (s += c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(s || "{}"));
			} catch {
				resolve({});
			}
		});
	});

createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	console.log(req.method, url.pathname);
	if (url.pathname === "/api/health") return send(res, 200, { ok: true });
	if (url.pathname === "/api/todos" && req.method === "GET") return send(res, 200, todos);
	if (url.pathname === "/api/todos" && req.method === "POST") {
		const { title = "" } = await readJson(req);
		const todo = { id: nextId++, title: String(title), done: false };
		todos.push(todo);
		return send(res, 201, todo);
	}
	const m = url.pathname.match(/^\/api\/todos\/(\d+)$/);
	if (m) {
		const i = todos.findIndex((t) => t.id === Number(m[1]));
		if (i === -1) return send(res, 404, { error: "not found" });
		if (req.method === "PATCH") {
			Object.assign(todos[i], { done: !!(await readJson(req)).done });
			return send(res, 200, todos[i]);
		}
		if (req.method === "DELETE") {
			todos.splice(i, 1);
			return send(res, 204, {});
		}
	}
	const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	try {
		const body = await readFile(join(PUBLIC, file.replace(/\.\./g, "")));
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404).end("not found");
	}
}).listen(port, "0.0.0.0", () => console.log(`todo app on :${port}`));
