# [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT) Multiplexer

vbmux is a small service and web interface for arranging Home Assistant and Codex content on a [Vestaboard](https://web.vestaboard.com/referral?vbref=NZJHOT). It supports Note (3 × 15) and Flagship (6 × 22), with a live board preview and configurable update limits.

![Codex quota, a Home Assistant bar row, and custom temperature characters on Vestaboard Note](docs/images/board-hero.png)

## Features

- **Local or Cloud API:** Send content directly to your Vestaboard over the local network or through Vestaboard’s cloud.
- **Home Assistant integration:** Build bar and text rows from entity states and attributes, or let Home Assistant supply character-code arrays for custom displays.
- **Codex quota integration:** Display usage limits, reset timing, and quota pacing alongside your Home Assistant content.
- **Flexible layouts:** Preview and arrange content on Note or Flagship, with shared-space priorities and configurable automatic update limits.

## Install (Docker recommended)

Install Git and Docker with the Docker Compose plugin on the computer that will run vbmux. Docker includes the application runtime and Codex CLI; you do not need to install Node.js separately.

```sh
git clone https://github.com/jiehanzheng/vestaboard-multiplexer.git
cd vestaboard-multiplexer
cp .env.example .env
docker compose up --build
```

Open `http://<server-host>:3000`, replacing `<server-host>` with the hostname or IP address of the computer running Docker. Use `http://localhost:3000` only when browsing on that same computer. To change the published port, set `VBMUX_PORT` in `.env` before starting Compose and use that port in the URL. If you use a reverse proxy, open its configured URL instead. The web interface has no application login; keep it on a trusted network or protect access through your reverse proxy.

Compose keeps application settings in the `vbmux-data` volume. It mounts `${HOME}/.codex` for Codex credentials; set `CODEX_HOST_DIR` in `.env` if they live elsewhere. That directory must be writable so Codex can save and refresh credentials. Configure connections through the web interface after startup, as described below.

Stop with Ctrl-C; `docker compose down` removes the containers while retaining saved settings. Do not add `--volumes` unless you intend to delete those settings. View logs with `docker compose logs --tail 200 --follow vestaboard-orchestrator`. Keep the same checkout directory or preserve the Compose project name when moving an installation so Compose continues using its existing data volume.

## Connect your Vestaboard

Open **Settings → Board output**. Choose **Auto detect**, **Note**, or **Flagship**, then configure one of the supported connections:

| Connection | Setup |
| --- | --- |
| **Local API** | Follow [Vestaboard’s Local API setup](https://docs.vestaboard.com/docs/local-api/authentication/) to request an enablement token and exchange it for the board’s API key. Enter the returned key in **Local API key**, not the enablement token. Set **Local API URL** to the board’s message endpoint (default `http://vestaboard.local:7000/local-api/message`). The vbmux container must be able to reach the board; if the `.local` hostname does not resolve there, replace it with the board’s LAN IP address. |
| **Cloud API** | Create a board-specific token in the API tab on [Vestaboard’s web app](https://web.vestaboard.com/) or the mobile app’s **Settings → Advanced Settings**, following the [Cloud API instructions](https://docs.vestaboard.com/docs/read-write-api/authentication/). Enable **Write** permission for delivery and **Read** for automatic board detection. Enter it in **Cloud token** and keep **Cloud API URL** at `https://cloud.vestaboard.com/`. This connection requires internet access. |

Choose **Save board settings**. A saved local key takes precedence over the cloud token; to switch to Cloud API, clear the local key and save. Cloud is not automatic failover for a failed local connection. Local API animation settings apply only to local delivery.

Then configure content under **Plugins**, arrange it on **Board**, and choose **Apply layout**. Board shows the preview, delivery status, and connection errors. For Codex content, open **Plugins → Codex** to check the mounted account or start device sign-in.

## Web interface

| Screenshot | Description |
| --- | --- |
| ![Board preview and layout editor](docs/images/web-board.jpg) | Preview your board and arrange its content. |
| ![Bar and text row editor](docs/images/web-row-editor.jpg) | Configure generic rows with fixed label and text areas. |
| ![Home Assistant connection settings](docs/images/web-settings.jpg) | Connect Home Assistant from the web interface. |

## Home Assistant

In Home Assistant, open **User profile → Security → Long-lived access tokens → Create token** ([token documentation](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token)). In vbmux, open **Settings → Home Assistant**, enter **Home Assistant URL** and **Long-lived access token**, then choose **Test connection** and **Save Home Assistant**. Use a URL reachable from the vbmux container; `localhost` inside the container refers to the container itself.

Add entity-backed content under **Plugins → Bar and text rows** or **HA character blocks**. Home Assistant supplies values and formatting; vbmux composes the resulting content on your board.

## Plugins

These examples use synthetic data rendered by the current plugins and captured from the official Vestaboard website in Safari.

### Codex

Show up to two quota windows with remaining percentages, reset times, and optional pacing colors that compare quota remaining with time remaining. Configure window labels and device sign-in under **Plugins → Codex**; optional auto-start can start a reset window when a watched quota is full.

![Codex weekly and five-hour quota bars with reset times on Vestaboard Note](docs/images/plugin-codex.png)

### Bar and text rows

Combine a label, colored bar, and right-aligned text in fixed-width areas. Bind all values to attributes of one Home Assistant entity, or choose constants and entity states or attributes separately for each field. Home Assistant owns calculations such as remaining showers; vbmux renders the supplied values. Each row has its own color, widths, placement, and unavailable fallback.

![Home Assistant hot-water, battery, and solar bar rows on Vestaboard Note](docs/images/plugin-bar-rows.png)

### HA character blocks

Let Home Assistant supply a flat array of Vestaboard character codes in an attribute of an entity whose state is `ready`. Use independent rectangular blocks for custom symbols, temperature displays, music, or status messages. Optionally append text from the same or another entity, or use a boolean activity attribute to yield space when inactive. Configure block size, placement, priority, and blank or `N/A` fallback in **Plugins → HA character blocks**.

![Home Assistant character blocks showing temperature, music, and garage status on Vestaboard Note](docs/images/plugin-ha-characters.png)

## Saved settings

Application settings are saved in `config.json` inside the data directory (`/app/data` in Docker). They remain authoritative across restarts. On first startup only, a missing configuration imports supported legacy environment settings; later environment changes do not override saved application settings. Use the web interface for board credentials, plugins, layout, and update limits; `.env` controls deployment settings such as the published port and Codex credential mount.
