# [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT) Orchestrator

A small TypeScript service for [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT), a connected split-flap-style display for showing short messages, status, and ambient information, that polls local plugins, picks the highest-priority message, and sends it to the board (referral link).

![Codex quota pacing hidden on a Vestaboard compose screen](docs/images/codex-pacing-off.png)

## How to Set Up

Docker is the intended runtime path.

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Set `VESTABOARD_TOKEN` in `.env` to a Vestaboard Cloud Read/Write API token.

3. Make sure Docker can see your Codex auth. By default, Compose mounts `${HOME}/.codex` into `/home/node/.codex`, which lets `codex app-server` reuse persisted auth. If your Codex config lives somewhere else, set `CODEX_HOST_DIR` in `.env`.

4. Start the orchestrator:

   ```sh
   docker compose up --build
   ```

Core environment variables configure the orchestrator and Vestaboard transport. Plugin-specific variables are documented in each plugin section below.

| Variable | Description |
| --- | --- |
| `ORCHESTRATOR_INTERVAL_MINUTES` | How often the orchestrator polls plugins.<br><br>Default: `5` |
| `VESTABOARD_TOKEN` | Vestaboard Cloud Read/Write API token.<br><br>Default: **You MUST set either this or VESTABOARD_LOCAL_API_KEY** |
| `VESTABOARD_CLOUD_URL` | Vestaboard Cloud API endpoint.<br><br>Default: `https://cloud.vestaboard.com/` |
| `VESTABOARD_LOCAL_API_KEY` | Local API key. If set, this is preferred over the cloud API.<br><br>Default: **You MUST set either this or VESTABOARD_TOKEN** |
| `VESTABOARD_LOCAL_URL` | Local API endpoint.<br><br>Default: `http://vestaboard.local:7000/local-api/message` |
| `VESTABOARD_LOCAL_MESSAGE_STRATEGY` | Local API message transition strategy: `column`, `reverse-column`, `edges-to-center`, `row`, `diagonal`, or `random`. Invalid values log an error, use the default, and show `check logs` on the startup message.<br><br>Default: `row` |
| `VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS` | Local API transition delay between animation steps. Invalid, non-finite, or non-positive values log an error, use the default, and show `check logs` on the startup message.<br><br>Default: `2000` |
| `VESTABOARD_LOCAL_MESSAGE_STEP_SIZE` | Local API transition step size. Invalid, non-finite, or non-positive values log an error, use the default, and show `check logs` on the startup message.<br><br>Default: `1` |
| `VESTABOARD_BOARD` | Board renderer: `auto`, `note`, or `flagship`. In `auto`, the orchestrator reads the current message layout through the configured Vestaboard API and detects Note (`3x15`) or Flagship (`6x22`). If detection cannot determine the board type, it assumes Note for that tick and retries on the next tick.<br><br>Default: `auto` |

On startup, the orchestrator sends a `vbmux via local` or `vbmux via cloud` banner with the current `yyyymmdd hhmm` timestamp and enabled plugin slugs, then waits 60 seconds before polling. The loop is serial: it runs one plugin pass, sends the selected message, waits `ORCHESTRATOR_INTERVAL_MINUTES`, then starts the next pass. If the winning message is unchanged from the last successful send, the orchestrator skips the Vestaboard API call.

## Plugins

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

On Note, the status lane is the third physical row. It normally shows available reset timing, using times for short windows and dates for long windows when both do not fit. Current-cycle statuses, fetch failures, reset availability, and auto-start ping notices temporarily replace reset timing; expired statuses are pruned on later ticks. Unused rows and unavailable reset fields stay blank.

On Vestaboard Flagship, the same quota data renders as a 6-row by 22-column layout. Reset timing moves into each quota row, the progress bars expand to 20 centered cells, and the final row stays blank unless the shared status lane has an active status such as `RESET AVAILABLE`, `AUTO PING FAIL`, `AUTH EXPIRED`, `TIMEOUT`, or `FETCH FAIL`.

If Codex is temporarily unavailable after a successful read, the plugin can reuse the complete last successful snapshot and mark the board with a short status-lane message instead of throwing away the display.

#### Codex Login

The app-server quota source needs a Codex login in the directory Docker mounts into the container.

Codex-managed ChatGPT authentication persists and normally refreshes its tokens automatically. If a quota read still returns `401 Unauthorized` or `token_expired`, the orchestrator asks the same app-server process to refresh the managed token and retries the quota read once. If that recovery also fails, cached quota remains visible when available, the board shows `AUTH EXPIRED`, and logs report only safe credential-file metadata plus the recovery command. The regular polling interval does not change.

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
| `CODEX_QUOTA_PRIORITY` | Plugin priority: `low`, `normal`, `high`, `urgent`, or a number.<br><br>Default: `normal` |
| `CODEX_QUOTA_ERROR_PRIORITY` | Priority used when the plugin can only render an error or cached quota.<br><br>Default: `low` |
| `CODEX_QUOTA_TIME_ZONE` | Time zone used for reset labels.<br><br>Default: local process timezone |
| `CODEX_QUOTA_SHOW_PACING` | `on` overlays red/blue pacing blocks; `off` shows only green quota blocks and blanks.<br><br>Default: `on` |
| `CODEX_HOST_DIR` | Host Codex config directory mounted into Docker at `/home/node/.codex`.<br><br>Default: `${HOME}/.codex` |
| `CODEX_AUTO_START_WINDOW_5H` | Ping Codex once when the 5-hour window is completely unused at 100%.<br><br>Default: `false` |
| `CODEX_AUTO_START_WINDOW_WK` | Ping Codex once when the weekly window is completely unused at 100%.<br><br>Default: `false` |
| `CODEX_QUOTA_DEMO_PAUSE_MINUTES` | How long normal polling pauses after a `SIGUSR2` demo render.<br><br>Default: `5` |

When auto-start is enabled, the plugin lists visible Codex models, skips `-spark` models, prefers the last `-nano` model, then the last `-mini` model, then the last remaining model. It sends a read-only ephemeral prompt: `Reply exactly: ok. Do not inspect files or run commands.` A running process auto-starts at most once per reset timestamp and never pings more than once every 30 minutes.

When any displayed quota row is exhausted at 0% and `account/rateLimits/read` reports reset credits are available, the status lane shows `RESET AVAILABLE`. The plugin only displays that read-only account status; it does not invoke a reset.

#### Runtime Signals

Use fixture mode to validate formatting without an authenticated Codex app-server:

```sh
CODEX_QUOTA_SOURCE=fixture docker compose up --build
```

The long-running process supports an immediate full refresh and a realistic Codex quota demo without restarting:

```sh
kill -HUP <pid>   # refresh all widgets immediately
kill -USR2 <pid>  # subtract one percentage point from the first displayed quota
```

`SIGHUP` wakes the orchestrator during its startup, normal polling, or demo pause and coalesces repeated refresh requests into the next full tick. `SIGUSR2` demo drops are cumulative for the running process: two signals render a two-point drop from whichever quota is displayed first. Only demo renders use `CODEX_QUOTA_DEMO_PAUSE_MINUTES`.
