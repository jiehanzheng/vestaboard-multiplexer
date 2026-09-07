# Vestaboard vbmux

This milestone is the standalone daemon and one-shot CLI. One runtime collects Codex quota readings, composes the configured board layout, persists manual pause state, and owns rate-limited delivery. The HTTP/React workspace is added in the final milestone.

## Run

The project uses pnpm and Node 22.12 or newer.

```sh
pnpm install --frozen-lockfile
pnpm test
CODEX_QUOTA_SOURCE=fixture VBMUX_DATA_DIR=/tmp/vbmux-fixture pnpm dry-run
pnpm start
```

Docker is also supported:

```sh
cp .env.example .env
docker compose up --build
```

The daemon reads `data/config.json`. When that file does not exist, supported legacy environment variables seed it once; later runs use the saved file. Board credentials are never returned by runtime status or persisted logs. Set either `VESTABOARD_TOKEN` or `VESTABOARD_LOCAL_API_KEY` for a live write. Fixture mode is useful for formatting and compiled one-shot checks without board credentials.

## Configuration

The first run imports these legacy variables and then persists their values:

| Variable | Purpose |
| --- | --- |
| `VESTABOARD_TOKEN` | Cloud Read/Write token. |
| `VESTABOARD_LOCAL_API_KEY` | Local board API key; takes precedence over cloud. |
| `VESTABOARD_CLOUD_URL` | Cloud endpoint. |
| `VESTABOARD_LOCAL_URL` | Local API endpoint. |
| `VESTABOARD_BOARD` | `auto`, `note`, or `flagship`; auto detection retries on the daemon minute tick. |
| `ORCHESTRATOR_INTERVAL_MINUTES` | Normal delivery interval; default `5`. |
| `CODEX_QUOTA_SOURCE` | `app-server` or `fixture`; default `app-server`. |
| `CODEX_QUOTA_POLL_INTERVAL_SECONDS` | Codex collection interval; default `60`. |
| `CODEX_QUOTA_TIME_ZONE` | Time zone used for reset labels. |
| `CODEX_QUOTA_SHOW_PACING` | `on` or `off`; default `on`. |
| `CODEX_AUTO_START_WINDOW_5H` | Enable the 5-hour auto-start check, which sends one minimal Codex turn when that window is unused. |
| `CODEX_AUTO_START_WINDOW_WK` | Enable the weekly auto-start check, which sends one minimal Codex turn when that window is unused. |

The service has one engine in both modes:

- `pnpm once` prepares the configured board, collects Codex once, composes the latest frame, and performs one delivery attempt.
- `pnpm start` starts Codex polling, retries unresolved automatic board detection on the existing minute tick, and runs the delivery scheduler.
- `pnpm dry-run` uses the same one-shot engine while logging the encoded frame instead of writing to a board.
- Manual pause is stored in `pause.json`; a failed persistence operation keeps delivery paused until repaired.
- `pauseOverlay` stores separate Note and Flagship canvases. Transparent cells preserve the frozen raw frame, while numeric cells draw over it during an effective manual or Home Assistant pause; code `0` is an opaque blank. Collection continues while paused, and pause, resume, and overlay saves use the normal delivery cadence. A paused startup waits for the bounded initial collection before its first frame, and a board-size change rebuilds the frozen base for the new dimensions.

The runtime contract lives under `src/runtime/actions.ts`. It is intentionally transport-neutral so the later HTTP server can depend on the engine without making the engine depend on web code.

## Codex display

Codex renders two duration-labeled quota windows for Note and Flagship boards. Each row uses its calculated duration label by default; Codex settings can replace either with one or two uppercase Vestaboard characters. Pacing colors, reset timing, authentication recovery, cached readings during a temporary outage, and optional auto-start checks are preserved from the validated source. Collection and rendering are separate: status, element, and preview queries use cached readings and never fetch Codex or write the board.

Note uses one quota row per window and a third status row. Flagship uses six rows with centered 20-cell bars and a final status row. The white time marker can cover a quota block when both land on one cell; reset labels, authentication failures, and reset availability use the status lane. Dry-run output logs the encoded `characters` payload, so formatting checks do not require a board write.

Codex authentication is read from the mounted Codex directory. The quota source refreshes expired managed tokens once and retries the failed read; it does not add a second polling loop. Device-code login controls are introduced with the React milestone.

## Development

Use `pfm` to reserve a port before running any command that binds a port. Phase one has no HTTP listener, so the normal build and test commands do not bind one. Keep test data in an isolated temporary directory.
