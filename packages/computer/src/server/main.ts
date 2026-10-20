// Entrypoint of the control server inside the computer image (bundled to
// infra/computer/control/dist/control.mjs). SIGTERM from start.sh interrupts the
// program: the recorder finalises a running recording, Chromium and background
// commands are stopped, then the process exits.
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { Artifacts } from "./Artifacts.ts"
import { Browser, ChromeLive } from "./Browser.ts"
import { Display } from "./Display.ts"
import { Exec } from "./Exec.ts"
import { Recorder } from "./Recorder.ts"
import { RoutesLive } from "./Routes.ts"

const ServicesLive = Layer.mergeAll(Display.layer, Browser.layer, Exec.layer, Recorder.layer, ChromeLive).pipe(
	Layer.provideMerge(Artifacts.layer),
	Layer.provideMerge(NodeServices.layer)
)

const ServerLive = Layer.unwrap(
	Effect.gen(function* () {
		const port = yield* Config.Int("CONTROL_PORT").pipe(Config.withDefault(7070))
		return HttpRouter.serve(RoutesLive).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port, host: "0.0.0.0" })))
	})
)

Layer.launch(ServerLive.pipe(Layer.provide(ServicesLive))).pipe(NodeRuntime.runMain)
