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

**Settings** contains Board output, the shared Home Assistant connection, pause settings, and live logs. Each section has its own **Save …** and **Discard** controls. Save Home Assistant before refreshing its shared entity catalog. The logs view keeps the current run's latest 200 structured entries and can filter or download them.

**Plugins** contains **Codex** and **Water heater**. Each plugin has its own settings and save bar. Codex account status, device sign-in, quota display, pacing, polling, auto-start, and window labels live under **Plugins → Codex**. Water Heater inputs can use constants or saved Home Assistant entities under **Plugins → Water heater**.

## Saved configuration and defaults

Application settings are persisted in `data/config.json` (or the directory selected by `VBMUX_DATA_DIR`) and are authoritative after that file exists. A missing file is initialized once from the supported legacy environment settings, then the resulting values are saved. Later environment changes do not override the saved file. The UI reports detected legacy names, including obsolete names that are ignored; remove those migration-only variables from the deployment environment after moving the settings into the UI. For example, `ORCHESTRATOR_INTERVAL_MINUTES` can seed the first saved delivery interval, but the ongoing interval is changed in **Settings → Board output**.

`VBMUX_HOST`, `VBMUX_PORT`, and `VBMUX_DATA_DIR` control the process location and storage path. The board connection, delivery interval, plugin options, Home Assistant binding, layout, and pause overlay are saved through the web UI. Secrets are omitted from the public configuration response and redacted from logs. If `config.json` is malformed or unreadable, vbmux leaves it untouched, keeps the web UI available for repair, and blocks board delivery until it is valid.

The initial saved defaults are:

- Board: `auto`; delivery interval: 5 minutes.
- Cloud URL: `https://cloud.vestaboard.com/`; Local API URL: `http://vestaboard.local:7000/local-api/message`.
- Local API transition: `row`, 2,000 ms per step, step size 1.
- Codex: enabled, `app-server` source, 60-second polling, pacing on, auto-start off, automatic duration labels.
- Water Heater: disabled, Fahrenheit, `HW` remaining label, `MV` EMV label, blue code `67` remaining bar, and code `62` heating character.
- Pause overlay: a sparse white pause icon; transparent cells preserve the board frame underneath.

The saved pause state is in `pause.json` beside `config.json`. Manual and Home Assistant pauses combine and survive restart. Collection continues during a pause. Delivery composes the saved overlay over the last successful raw frame: numeric overlay cells draw over it, including code `0` as an opaque blank, while transparent cells preserve it. Pause, resume, Home Assistant pause changes, and overlay saves follow the normal delivery cadence. Other successful settings saves request one immediate attempt for the latest frame when delivery is eligible; unchanged frames are skipped and failed attempts consume the interval. A paused startup waits for initial collection, and the startup banner is held for 30 seconds after a successful live send.

## Layout and plugin display

The editor supports Note (3 × 15) and Flagship (6 × 22). Elements have fixed heights and may occupy rectangular board ranges. The editor rejects overlapping, undersized, and out-of-bounds placements. A `null` saved layout selects the enabled Codex default layout for the detected board. The preview uses the same character-code renderer as delivery.

Codex window labels are calculated from each reset duration by default; window 1 is the longest known duration and window 2 the next longest. A custom label may be one or two uppercase Vestaboard characters. Water Heater exposes `HW` and `MV` labels, a configurable remaining-bar character, and a configurable heating divider character. Code `62` displays as a red heart on Note and a degree glyph on Flagship; code `67` is blue. Water temperature, target, remaining water, capacity, and EMV position can each be configured as a constant or a Home Assistant reading. Missing readings show `N/A`, and temperatures round to whole degrees. A heating entity selects the divider when it reports an accepted binary state; unknown states keep `/` and show a diagnostic.

## Codex plugin

The plugin reads the aggregate rate-limit windows from Codex and renders up to two duration-labeled quota rows. Note uses two quota rows and a status row. Flagship uses its six-row layout with centered 20-cell bars and reset timing in the quota rows.

| Display | Screenshot | Meaning |
| --- | --- | --- |
| Pacing on | ![Codex quota with pacing colors](docs/images/codex-pacing-on.png) | Green means quota is at or ahead of the time-remaining pace; yellow, orange, and red indicate progressively larger deficits. The white time marker takes precedence over a quota block. |
| Pacing off | ![Codex quota without pacing colors](docs/images/codex-pacing-off.png) | Only green quota blocks and blanks remain. |
| Auto-start ping | ![Codex full quota ping status](docs/images/codex-ping.png) | When enabled, a full watched window can trigger one minimal read-only Codex turn to start a real reset window. |
| Flagship | ![Codex quota on Vestaboard Flagship](docs/images/codex-flagship.png) | The same quota data rendered for the 6 × 22 board. |

Codex device login is managed from **Plugins → Codex**. The page checks mounted credentials, can start or cancel device sign-in, and exposes the verification URL when a code is pending. A stale managed token gets one explicit refresh and one retry of the failed quota read. If recovery fails, the plugin keeps a complete last successful snapshot when available, shows an authentication status on the board, and records safe diagnostics; it does not add another polling loop.

Auto-start is off by default. When enabled for the 5-hour or weekly window, a window that is still full at 100% can receive one ephemeral prompt per reset timestamp, with a 30-minute cooldown. The plugin skips `-spark` models, preferring the last visible `-nano`, then `-mini`, then another available model. Reset-credit availability is displayed as status only; vbmux does not redeem a reset.
