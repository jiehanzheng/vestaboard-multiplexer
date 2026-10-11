# Home Assistant character block

- The user chose a generic HA-fed character block: Home Assistant owns Sonos/favorite matching and supplies supported numeric Vestaboard codes; VBMux validates and renders them.
- The user required configurable width and height, row-major flat payloads, blank padding, and no silent truncation. Geometry and placement save together and must fit without overlaps.
- The user chose configurable blank or `N/A` for unavailable, invalid, and stale data; `N/A` requires three horizontal cells. Healthy blank data stays blank and healthy unchanged paused content does not expire.
- The approved plan uses the configured fallback immediately on failure, with configurable staleness diagnostics measured from failure onset. It does not retain playback badges during outages. This specializes the earlier [plugin staleness](plugin-staleness.md) convention; the generic default remains `N/A` and the initial music binding uses blank.
