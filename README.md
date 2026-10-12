# [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT) Multiplexer

vbmux is a small TypeScript service and web workspace for [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT), a connected split-flap-style display. It collects plugin data, previews the composed Note or Flagship frame in the browser, and sends the latest valid frame at a limited rate.

![Codex quota pacing hidden on a Vestaboard compose screen](docs/images/codex-pacing-off.png)

## Run with Docker Compose

Clone the repository and start the service with Docker Compose:

```sh
git clone https://github.com/jiehanzheng/vestaboard-multiplexer.git
cd vestaboard-multiplexer
cp .env.example .env
docker compose up --build
```

Open **http://localhost:3000**. Configure the board under **Settings → Board output**, then configure Codex and Water heater under **Plugins**. Set `VBMUX_PORT` in `.env` if you need a different host port. The HTTP interface has no application login; protect access through your network or reverse proxy.

Docker Compose keeps saved settings in the `vbmux-data` volume. It mounts `${HOME}/.codex` for Codex credentials; set `CODEX_HOST_DIR` in `.env` if they live elsewhere. The mounted directory must be writable so Codex can save and refresh credentials.

Stop with Ctrl-C, then run `docker compose down`. Do not add `--volumes` unless you intend to delete saved application settings. View container logs with `docker compose logs --tail 200 --follow vestaboard-orchestrator`; **Settings → Logs** shows the current run's latest 200 entries.

Existing installations can keep their checkout directory after the repository rename. If you move it, preserve the existing Compose project name with `COMPOSE_PROJECT_NAME` or `docker compose -p` so the same data volume is used. The Compose service remains named `vestaboard-orchestrator`.

## Use the web workspace

**Board** shows the desired frame, the last sent or simulated frame, delivery status, and the next eligible attempt. Choose a board element to edit its placement. Draft layout changes update the board preview; **Apply layout** saves them and **Discard layout** restores the saved layout. Unsaved Codex and Water heater settings use the same preview renderer, so their effect is visible on Board before each plugin section is saved.

**Settings** contains Board output, the shared Home Assistant connection, pause settings, and live logs. Board output controls the Local API animation strategy, delay, and step size. Pause settings can use the normal animation or one Local API override for the pause and resume writes; Cloud API connections keep these saved values but do not apply them. Each section has its own **Save …** and **Discard** controls. Save Home Assistant before refreshing its shared entity catalog. The logs view keeps the current run's latest 200 structured entries and can filter or download them.

**Plugins** contains **Codex**, **Water heater**, and **HA character blocks**. Each plugin has its own settings and save bar. Codex account status, device sign-in, quota display, pacing, polling, auto-start, and window labels live under **Plugins → Codex**. Water Heater inputs can use constants or saved Home Assistant entities under **Plugins → Water heater**.

## Saved configuration and defaults

Application settings are persisted in `data/config.json` (or the directory selected by `VBMUX_DATA_DIR`) and are authoritative after that file exists. A missing file is initialized once from the supported legacy environment settings, then the resulting values are saved. Later environment changes do not override the saved file. The UI reports detected legacy names, including obsolete names that are ignored; remove those migration-only variables from the deployment environment after moving the settings into the UI. For example, `ORCHESTRATOR_INTERVAL_MINUTES` can seed the first saved delivery interval, but the ongoing interval is changed in **Settings → Board output**.

`VBMUX_HOST`, `VBMUX_PORT`, and `VBMUX_DATA_DIR` control the process location and storage path. The board connection, delivery interval, plugin options, Home Assistant binding, layout, and pause overlay are saved through the web UI. Secrets are omitted from the public configuration response and redacted from logs. If `config.json` is malformed or unreadable, vbmux leaves it untouched, keeps the web UI available for repair, and blocks board delivery until it is valid.

The initial saved defaults are:

- Board: `auto`; delivery interval: 5 minutes.
- Cloud URL: `https://cloud.vestaboard.com/`; Local API URL: `http://vestaboard.local:7000/local-api/message`.
- Local API transition: `row`, 2,000 ms per step, step size 1; pause and resume use the same transition unless an override is saved.
- Codex: enabled, `app-server` source, 60-second polling, pacing on, auto-start off, automatic duration labels.
- Water Heater: disabled, Fahrenheit, `HW` remaining label, `MV` EMV label, blue code `67` remaining bar, and code `62` heating character.
- Pause overlay: a sparse white pause icon; transparent cells preserve the board frame underneath.

The saved pause state is in `pause.json` beside `config.json`. Manual and Home Assistant pauses combine and survive restart. Collection continues during a pause. Delivery composes the saved overlay over the last successful raw frame: numeric overlay cells draw over it, including code `0` as an opaque blank, while transparent cells preserve it. Pause, resume, Home Assistant pause changes, and overlay saves follow the normal delivery cadence. Other successful settings saves request one immediate attempt for the latest frame when delivery is eligible; unchanged frames are skipped and failed attempts consume capacity. A paused startup waits for initial collection, and the startup banner is held for 30 seconds after a successful live send.

Automatic update limits live under **Settings → Board output**. Add rolling-window rules (each attempted update occupies a slot for the whole period) or gradual-refill rules (credits refill continuously); every rule must allow an automatic write. Settings saves bypass admission but consume all rules, including failed writes, and can create refill debt; startup banners remain excluded. Usage resets on restart. Saving a new or changed rule starts it fresh; unchanged rules retain usage. Saved-rule capacity stays separate from draft edits, and the Board shows available capacity and whether the latest frame is waiting. Legacy saved intervals migrate to one equivalent rolling rule; fresh installs keep the five-minute default.

## Layout and plugin display

The editor supports Note (3 × 15) and Flagship (6 × 22). Elements have fixed heights and may occupy rectangular board ranges. The editor rejects overlapping, undersized, and out-of-bounds placements. A `null` saved layout selects the enabled Codex default layout for the detected board. The preview uses the same character-code renderer as delivery.

Codex window labels are calculated from each reset duration by default; window 1 is the longest known duration and window 2 the next longest. A custom label may be one or two uppercase Vestaboard characters. Water Heater exposes `HW` and `MV` labels, a configurable remaining-bar character, and a configurable heating divider character. Code `62` displays as a red heart on Note and a degree glyph on Flagship; code `67` is blue. Water temperature, target, remaining water, capacity, and EMV position can each be configured as a constant or a Home Assistant reading. Missing readings show `N/A`, and temperatures round to whole degrees. A heating entity selects the divider when it reports an accepted binary state; unknown states keep `/` and show a diagnostic.

## Codex plugin

The plugin reads the aggregate rate-limit windows from Codex and renders up to two duration-labeled quota rows. Note uses two quota rows and a status row. Flagship uses its six-row layout with centered 20-cell bars and reset timing in the quota rows.

| Display | Screenshot | Meaning |
| --- | --- | --- |
| Pacing on | ![Codex quota with pacing colors](docs/images/codex-pacing-on.png) | Green means quota is at or ahead of the time-remaining pace; yellow, orange, and red indicate progressively larger deficits. The white time marker appears after a window starts and takes precedence over a quota block. |
| Pacing off | ![Codex quota without pacing colors](docs/images/codex-pacing-off.png) | Only green quota blocks and blanks remain. |
| Auto-start ping | ![Codex full quota ping status](docs/images/codex-ping.png) | When enabled, a full watched window can trigger one minimal read-only Codex turn to start a real reset window. |
| Flagship | ![Codex quota on Vestaboard Flagship](docs/images/codex-flagship.png) | The same quota data rendered for the 6 × 22 board. |

Codex device login is managed from **Plugins → Codex**. The page checks mounted credentials, can start or cancel device sign-in, and exposes the verification URL when a code is pending. A stale managed token gets one explicit refresh and one retry of the failed quota read. If recovery fails, the plugin keeps a complete last successful snapshot when available, shows an authentication status on the board, and records safe diagnostics; it does not add another polling loop.

Auto-start is off by default. When enabled for the 5-hour or weekly window, a window that is still full at 100% can receive one ephemeral prompt per reset timestamp, with a 30-minute cooldown. The plugin skips `-spark` models, preferring the last visible `-nano`, then `-mini`, then another available model. Reset-credit availability is displayed as status only; vbmux does not redeem a reset.

The optional EMV problem indicator replaces the position digits with a red tile and `MFO`. In Water heater settings, select a problem entity and enter the exact, case-sensitive value that activates it (for example, `on` or `Missed flow off active`). Leave the entity empty to disable it. Missing, restored, or unavailable readings show a diagnostic; the stale timeout limits how long the position display remains visible.

HA character blocks render `ready` Home Assistant entities’ flat character-code attributes, filling rows and padding with blanks. Add, name, edit, or remove independent blocks under **Plugins → HA character blocks**, then place them on Board. Each has its own source, size, fallback, and staleness setting. Optional boolean activity attributes let healthy inactive sources yield their space; blank codes remain opaque. Optional text attributes append normalized uppercase text directly after the numeric prefix; only text is shortened to fit. Text can use a separate entity on the same HA connection. Invalid, missing, restored, or disconnected sources display blank or `N/A` immediately; `N/A` needs three columns. Oversized numeric payloads are rejected. Settings and layout save/discard together. Healthy unchanged data does not expire, relevant attribute updates reach the desired frame immediately, and physical writes follow the automatic update limits.

Any Board content can share space when every overlapping placement enables priority. Higher priorities win whole rectangles, including blank cells; ties use saved order, adjustable with the arrows. Inactive content yields; unavailable fallbacks yield to active content regardless of priority. Geometry is validated even for hidden content. Use **Add alternative here** when the board is full.

Each plugin has a **Stale readings** setting (15 minutes by default, or never expire). Codex ages from its last successful collection; Water Heater ages from when an input becomes unavailable or HA disconnects. Stale Codex and Water Heater elements show `N/A`; constants and healthy, unchanged HA entities do not expire. Recovery is automatic. Expiry uses the minute refresh and normal board delivery limits; it does not change pause automation. Retained readings are not persisted across restarts.
