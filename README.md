# [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT) Orchestrator

A small TypeScript service for [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT), a connected split-flap-style display for showing short messages, status, and ambient information, that collects plugin data independently and sends the latest message to the board at a limited rate (referral link).

![Codex quota pacing hidden on a Vestaboard compose screen](docs/images/codex-pacing-off.png)

## How to Set Up

Use `pfm` to reserve host ports before starting a local server or container. These commands require `pfm` and `jq`; Docker is the intended deployment runtime.

### Local preview

With Node 22.12+ and pnpm installed, run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pfm port reserve vbmux-preview --preferred-port=8787 --host=127.0.0.1
export VBMUX_PORT="$(pfm status --json | jq -er '.ports[] | select(.role == "vbmux-preview") | .port')"
echo "Open http://127.0.0.1:$VBMUX_PORT"
CODEX_QUOTA_SOURCE=fixture VBMUX_DATA_DIR=./data/preview VBMUX_HOST=127.0.0.1 node dist/src/index.js --dry-run
```

The React app includes Note and Flagship board previews. This command uses sample Codex data, separate preview settings, and no physical board writes. Water readings can use constants without Home Assistant. Keep the command running while using the preview; stop it with Ctrl-C, then release its port with `pfm port release vbmux-preview`.

### Docker

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Reserve a host port and start the app:

   ```sh
   pfm port reserve vbmux-web --preferred-port=3000 --host=0.0.0.0
   export VBMUX_PORT="$(pfm status --json | jq -er '.ports[] | select(.role == "vbmux-web") | .port')"
   echo "Open http://localhost:$VBMUX_PORT"
   docker compose up --build
   ```

3. Open the printed URL, add the board connection in **Board settings**, and sign in under **Connections**. Compose can also reuse your mounted `${HOME}/.codex` credentials; set `CODEX_HOST_DIR` if they live elsewhere.

Use `pfm status` to inspect reservations. After stopping the container, release its host port with `pfm port release vbmux-web`.

The React interface previews layout edits before **Apply**. Live status shows the desired frame, last sent frame, next eligible update, and pause state. **Pause updates** keeps collecting data while holding the physical board. HTTP has no application authentication; manage access through your own network or proxy.

Core environment variables configure the orchestrator and Vestaboard transport. Plugin-specific variables are documented in each plugin section below.

| Variable | Description |
| --- | --- |
| `VBMUX_PORT` | Use the host port assigned by `pfm`. Compose keeps the container’s internal HTTP port at `3000`. |
| `VBMUX_DATA_DIR` | Saved configuration and pause state directory.<br><br>Default: `./data` (`/app/data` in Docker) |
| `ORCHESTRATOR_INTERVAL_MINUTES` | Minimum time between normal board write attempts. Failed attempts also count.<br><br>Default: `5` |
| `CODEX_QUOTA_POLL_INTERVAL_SECONDS` | How often Codex collects fresh quota, independently of board writes.<br><br>Default: `60` |
| `VESTABOARD_TOKEN` | Vestaboard Cloud Read/Write API token.<br><br>Default: configure this or a local API key in the web interface |
| `VESTABOARD_CLOUD_URL` | Vestaboard Cloud API endpoint.<br><br>Default: `https://cloud.vestaboard.com/` |
| `VESTABOARD_LOCAL_API_KEY` | Local API key. If set, this is preferred over the cloud API.<br><br>Default: configure this or a cloud token in the web interface |
| `VESTABOARD_LOCAL_URL` | Local API endpoint.<br><br>Default: `http://vestaboard.local:7000/local-api/message` |
| `VESTABOARD_LOCAL_MESSAGE_STRATEGY` | Local API message transition strategy: `column`, `reverse-column`, `edges-to-center`, `row`, `diagonal`, or `random`. Invalid configuration appears in the UI and prevents board writes.<br><br>Default: `row` |
| `VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS` | Positive local API transition delay between animation steps.<br><br>Default: `2000` |
| `VESTABOARD_LOCAL_MESSAGE_STEP_SIZE` | Positive local API transition step size.<br><br>Default: `1` |
| `VESTABOARD_BOARD` | Board renderer: `auto`, `note`, or `flagship`. In `auto`, the orchestrator reads the current message layout through the configured Vestaboard API and detects Note (`3x15`) or Flagship (`6x22`). If detection cannot determine the board type, it assumes Note; changing the board connection or board setting runs detection again.<br><br>Default: `auto` |

On startup, the orchestrator sends a `vbmux via local` or `vbmux via cloud` banner with the current `yyyymmdd hhmm` timestamp and enabled plugin slugs. The banner displays for 30 seconds outside the normal write limit, then the latest data is sent. Codex collection continues independently of board writes. Changes coalesce into the newest message; unchanged messages are skipped. Normal attempts, including failed attempts, are separated by `ORCHESTRATOR_INTERVAL_MINUTES`.

## Layout configuration

The interface saves settings in `data/config.json` (`VBMUX_DATA_DIR` changes the directory); Docker persists this directory in its `vbmux-data` volume. Existing environment variables override corresponding saved settings. A missing file uses defaults; an invalid file leaves the interface available for repair and prevents board writes.

Elements span the board width and have a fixed height. Assign their zero-based starting row in `layout`; overlapping or out-of-bounds placements are rejected. `null` selects the default Codex layout for the detected board. For example, a minimal saved configuration is:

```json
{"version":1,"layout":[{"elementId":"codex.window-1","startRow":0},{"elementId":"codex.window-2","startRow":1},{"elementId":"codex.status","startRow":2}]}
```

`codex.window-1` is the longest window and `codex.window-2` is the next longest. Each has a separate two-row `-large` element. `codex.header`, `codex.reset-summary`, and `codex.status` are one-row elements. Renderers use the available width: 15 columns on Note or 22 on Flagship.

## Plugins

Plugins own their settings, collection, cached readings and rendering. The platform owns board encoding, layout, delivery and pause; application code wires them together. Home Assistant provides one shared raw entity subscription, consumed independently by Water Heater and platform pause. Browser-safe Zod schemas define settings and HTTP contracts; plugins do not import one another.

The server and `--once` use the same application engine. `--once` collects initial readings, composes and attempts one frame, then shuts down without a banner or HTTP server. Status and draft previews only read cached data. Delivery owns its timer and checks pause before writing; collections continue while paused. Persistence errors appear separately from connection errors.

### Water heater / Home Assistant

In **Connections**, enter your Home Assistant URL and long-lived access token, test the connection, then choose entities by name. Remaining hot water, capacity, tank temperature and target each accept a constant or an entity state/numeric attribute. Use US gallons and select one shared temperature unit (F or C). The temperature bar also requires a baseline.

Add `water.remaining`, `water.temperature-bar`, or `water.temperature-text` to any free row. Each occupies one row; the text element shows current/target temperature. Missing initial readings show `N/A`; failed reads keep the last good value and report the error in the interface.

One read-only Home Assistant WebSocket supplies water readings and an optional pause entity. Configure exact pause/resume states for that entity. Manual pause and HA pause combine: either can hold delivery. Both survive restart; a new HA binding starts paused until a recognized state arrives, and an outage retains its last result. Collection continues while paused, including during startup.

### Codex

The Codex plugin reads the aggregate percentage windows from `account/rateLimits/read` and renders up to two duration-labeled quota rows for Vestaboard Note and Flagship.

| Configuration | Screenshot | What it means |
| --- | --- | --- |
| Pacing on | ![Codex quota with pacing colors](docs/images/codex-pacing-on.png) | Colored blocks are quota remaining. Any nonzero quota renders at least one quota block. <br>Green means quota is at or ahead of the time-remaining pace. Yellow, orange, and red mean progressively worse pacing deficits. <br>White is the current time marker and always overrides the quota color. |
| Pacing off | ![Codex quota without pacing colors](docs/images/codex-pacing-off.png) | `CODEX_QUOTA_SHOW_PACING=off` hides pacing entirely: only green quota blocks and blanks remain. This is the clean, quiet mode for just checking remaining quota. |
| Auto-start ping | ![Codex full quota ping status](docs/images/codex-ping.png) | Only if enabled: when a watched window is still full at 100%, the plugin can send one minimal Codex ping to start a real reset window. The status lane briefly shows the ping model. |
| Flagship | ![Codex quota on Vestaboard Flagship](docs/images/codex-flagship.png) | This plugin supports Flagship boards' 6x22 layout as well -- with 20-cell centered bars, right-aligned reset labels, and a final-row status lane. |

The first two rows are quota windows:

```text
5HRRR  W    30%
WKGGGGWG    60%
0300♥06/22-0000
```

`G`, `Y`, `O`, `R`, and `W` in dry-run output stand for Vestaboard green, yellow, orange, red, and white block character codes. The actual API payload sends `characters`, not plain text. Percentages are remaining quota, derived from `100 - usedPercent`. Full quota renders as `100` on Note so the row still fits, and as `100%` on Flagship where the larger usage field has room. Quota blocks use reached buckets: any nonzero quota renders at least one quota block, each Note block represents quota reaching into another 10% bucket, and each Flagship block represents quota reaching into another 5% bucket. The white time marker can still cover a quota block when both land on the same cell. The white marker moves in equal remaining-time buckets: on Note, each 5-hour cell represents 30 minutes.

On Note, the status lane is the third physical row. It normally shows available reset timing, using times for short windows and dates for long windows when both do not fit. Current-cycle statuses, fetch failures, reset availability, and auto-start ping notices temporarily replace reset timing; expired statuses stop appearing without changing cached readings. Unused rows and unavailable reset fields stay blank.

On Vestaboard Flagship, the same quota data renders as a 6-row by 22-column layout. Reset timing moves into each quota row, the progress bars expand to 20 centered cells, and the final row stays blank unless the shared status lane has an active status such as `RESET AVAILABLE`, `AUTO PING FAIL`, `AUTH EXPIRED`, `TIMEOUT`, or `FETCH FAIL`.

If Codex is temporarily unavailable after a successful read, the plugin can reuse the complete last successful snapshot and mark the board with a short status-lane message instead of throwing away the display.

#### Codex Login

Use **Connections → Sign in with Codex** for device-code login, or reuse credentials in the directory Docker mounts into the container. Device-code login must be enabled in your ChatGPT security settings. The interface owns the login process and supports cancellation; Codex persists and refreshes its credentials.

Codex-managed ChatGPT authentication persists and normally refreshes its tokens automatically. If a quota read still returns `401 Unauthorized` or `token_expired`, the orchestrator asks the same app-server process to refresh the managed token and retries the quota read once. If that recovery also fails, cached quota remains visible when available, the board shows `AUTH EXPIRED`, and logs report only safe credential-file metadata plus the recovery command. The regular collection interval does not change.

There are two common cases:

- If you run this on the same machine where you normally use Codex, Compose already mounts `${HOME}/.codex` into the container. No extra login step is needed.
- If you run this on a server with Docker, go to the directory that contains `docker-compose.yml` and log in using the Codex binary inside the container:

  ```sh
  docker compose run --rm --build vestaboard-orchestrator codex login status
  docker compose run --rm --build vestaboard-orchestrator codex login --device-auth
  ```

If the host login directory is somewhere else, set `CODEX_HOST_DIR` in `.env` to that host path. Compose mounts it at `/home/node/.codex` inside the container, where `codex app-server` reads the persisted auth and config. The mounted directory and `auth.json` must be writable by the container user so Codex can persist refreshed credentials, including by atomically replacing the file.

#### Codex Env Config

| Variable | Description |
| --- | --- |
| `CODEX_QUOTA_SOURCE` | Use `fixture` for offline formatting checks.<br><br>Default: `app-server` |
| `CODEX_QUOTA_TIME_ZONE` | Time zone used for reset labels.<br><br>Default: local process timezone |
| `CODEX_QUOTA_SHOW_PACING` | `on` overlays red/blue pacing blocks; `off` shows only green quota blocks and blanks.<br><br>Default: `on` |
| `CODEX_HOST_DIR` | Host Codex config directory mounted into Docker at `/home/node/.codex`.<br><br>Default: `${HOME}/.codex` |
| `CODEX_AUTO_START_WINDOW_5H` | Ping Codex once when the 5-hour window is completely unused at 100%.<br><br>Default: `false` |
| `CODEX_AUTO_START_WINDOW_WK` | Ping Codex once when the weekly window is completely unused at 100%.<br><br>Default: `false` |
| `CODEX_QUOTA_DEMO_PAUSE_MINUTES` | How long a `SIGUSR2` demo remains visible while collection continues.<br><br>Default: `5` |

When auto-start is enabled, the plugin lists visible Codex models, skips `-spark` models, prefers the last `-nano` model, then the last `-mini` model, then the last remaining model. It sends a read-only ephemeral prompt: `Reply exactly: ok. Do not inspect files or run commands.` A running process auto-starts at most once per reset timestamp and never pings more than once every 30 minutes.

When any displayed quota row is exhausted at 0% and `account/rateLimits/read` reports reset credits are available, the status lane shows `RESET AVAILABLE`. The plugin only displays that read-only account status; it does not invoke a reset.

#### Runtime Signals

Use fixture mode to validate formatting without an authenticated Codex app-server. First reserve and export `VBMUX_PORT` using the Docker setup above:

```sh
CODEX_QUOTA_SOURCE=fixture docker compose up --build
```

The long-running process supports an immediate full refresh and a realistic Codex quota demo without restarting:

```sh
kill -HUP <pid>   # refresh all widgets immediately
kill -USR2 <pid>  # subtract one percentage point from the first displayed quota
```

`SIGHUP` requests fresh quota, coalescing repeated requests. `SIGUSR2` demo drops are cumulative for the running process: two signals render a two-point drop from whichever quota is displayed first. The demo remains visible for `CODEX_QUOTA_DEMO_PAUSE_MINUTES` while collection continues. Both signals respect the board write limit.
