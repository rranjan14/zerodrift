# zerodrift examples

A runnable end-to-end demo of the [`zerodrift`](../) engine: a reference Go
backend (`go/`) implementing the three-endpoint protocol, and a Next.js app
(`webapp/`) that consumes the library straight from source (via the webapp's
`tsconfig.json` path alias to `../../src`).

Prerequisites: Docker, Go 1.22+, Node 18+, and Make.

Run everything from this `examples/` directory:

```bash
cd examples
make go-tidy        # generate go.sum (once, after cloning)
make start-backend  # Postgres + API (:8080) + SSE (:8081), via docker compose
make install-webapp # npm install in webapp/
make run-webapp     # Next.js dev server on :3000
```

Open [http://localhost:3000](http://localhost:3000) in two tabs to watch
optimistic writes and SSE sync propagate.

Useful commands:

```bash
make ps             # running containers
make logs           # tail backend logs
make stop-backend   # stop services
make clean          # stop + wipe the Postgres volume
```

`make` and `docker compose` resolve `Makefile` / `docker-compose.yml` from
this directory — everything the demo needs is self-contained here.
