# Home Assistant character block

- The user requires arbitrary independent block instances, with Add/Edit/Remove controls and per-instance source, geometry, fallback, staleness, and placement. Stable IDs preserve placements when names change; all instances share the existing HA connection. Legacy singleton settings migrate to the `characters` instance without moving its placement.

- The user chose a generic HA-fed character block: Home Assistant owns Sonos/favorite matching and supplies supported numeric Vestaboard codes; VBMux validates and renders them.
- The user required configurable width and height, row-major flat payloads, blank padding, and no silent truncation. Geometry and placement save together and must fit the board. The later shared-space priority requirement allows overlapping alternatives.
- The user chose configurable blank or `N/A` for unavailable, invalid, and stale data; `N/A` requires three horizontal cells. Healthy blank data stays blank and healthy unchanged paused content does not expire.
- The approved plan uses the configured fallback immediately on failure, with configurable staleness diagnostics measured from failure onset. It does not retain playback badges during outages. This specializes the earlier [plugin staleness](plugin-staleness.md) convention; the generic default remains `N/A` and the initial music binding uses blank.

- The user requires configurable placement priority across all content, including HA, water, and Codex blocks.
- The user requires recognized playing and paused favorites to show JZ/YM initials, then the color block, then the song title, with no spaces on either side of the color block. Paused favorites retain the row with a white badge; unrelated favorites yield the row to water temperature. Home Assistant owns playback and favorite recognition.
