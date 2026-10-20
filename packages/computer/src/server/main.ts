// Entrypoint of the control server inside the computer image (bundled to
// infra/computer/control/dist/control.mjs). SIGTERM from start.sh interrupts the
// program: the recorder finalises a running recording, Chromium and background
// commands are stopped, then the process exits.

import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { Artifacts } from "./artifacts.ts"
import { Browser, ChromeLive } from "./browser.ts"
import { Display } from "./display.ts"
import { Exec } from "./exec.ts"
import { Recorder } from "./recorder.ts"
import { RoutesLive } from "./routes.ts"

const ServicesLive = Layer.mergeAll(Display.layer, Browser.layer, Exec.layer, Recorder.layer, ChromeLive).pipe(
	Layer.provideMerge(Artifacts.layer),
	Layer.provideMerge(NodeServices.layer)
)

const ServerLive = Layer.unwrap(
	Effect.gen(function* () {
		const port = yield* Config.Int("CONTROL_PORT").pipe(Config.withDefault(7070))
		return HttpRouter.serve(RoutesLive).pipe(
			Layer.provide(NodeHttpServer.layer(createServer, { host: "0.0.0.0", port }))
		)
	})
)

Layer.launch(ServerLive.pipe(Layer.provide(ServicesLive))).pipe(NodeRuntime.runMain)
