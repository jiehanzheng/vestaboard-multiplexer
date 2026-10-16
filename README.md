# vbmux

A small service and web interface for arranging Home Assistant and Codex content on a Vestaboard.

## Install

```sh
git clone https://github.com/jiehanzheng/vestaboard-multiplexer.git
cd vestaboard-multiplexer
cp .env.example .env
docker compose up --build
```

Open [the web interface](http://localhost:3000). Keep it on a trusted network or behind your reverse proxy; it has no application login.

## Web interface

| Screenshot | Description |
| --- | --- |
| ![Board preview and layout editor](docs/images/web-board.jpg) | Preview your board and arrange its content. |
| ![Bar and text row editor](docs/images/web-row-editor.jpg) | Configure generic rows with fixed label and text areas. |
| ![Home Assistant connection settings](docs/images/web-settings.jpg) | Connect Home Assistant from the web interface. |

## Home Assistant

In Home Assistant, open **User profile → Security → Long-lived access tokens → Create token** ([token documentation](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token)). In vbmux, open **Settings → Home Assistant**, enter **Home Assistant URL** and **Long-lived access token**, then choose **Test connection** and **Save Home Assistant**. Add entity-backed content under **Plugins**.
