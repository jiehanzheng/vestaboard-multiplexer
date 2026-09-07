# Runtime diagnostics

- User decision: the UI shows current-run recent logs from a bounded in-memory buffer while Docker owns retained and rotated history; the application does not create duplicate log files.
- Plugin diagnostics remain plugin-owned. Water status describes each configured input and retains safe last-good values during Home Assistant outages; core runtime only transports the status and log events.

# Water temperature display

- User decision: the water temperature divider becomes the Vestaboard heart only when the optional Home Assistant heating entity reports a recognized on state; unknown or unavailable states use `/` and report a diagnostic. The temperature bar and baseline setting are retired, while legacy saved layouts discard only the retired bar placement during load.

# Water display characters

- User decision: Water Heater owns the heating-divider and remaining-bar character settings as numeric local Vestaboard codes, defaulting to `62` and `67`. Codes are sent directly in message matrices so valid letters, symbols, and colors remain available; code `71` and invalid gaps are excluded according to the [Vestaboard character code reference](https://docs.vestaboard.com/docs/charactercodes/).

# Board preview rendering

- User decision (2026-09-07): the main board preview, compact element preview, and pause overlay editor share one board cell renderer. This keeps official character glyphs, color classes, and square row heights aligned across surfaces; pause transparency and painting remain editor states layered on the shared cells.

# vbmux

- Plugins collect independently of board delivery and contribute separately placeable elements. Each size is a distinct element with a fixed height; rendering receives available width.
- Keep the design simple: use fixed rectangular placement, without rotation or whole-screen priority takeover.
- The web interface is a React app with live updates where useful. Serve plain HTTP without application authentication; the operator manages access.
- A missing config file imports supported legacy environment settings once into saved defaults. Existing saved configuration is authoritative; detected legacy names are shown as a non-blocking warning, and obsolete names are ignored.
- Board updates have a configurable rate limit independent of plugin collection. The startup banner displays for 30 seconds outside the normal limit, which starts with real data.
- User decision (2026-09-07): a successful explicit settings Save/Apply requests one immediate delivery attempt so an applied frame does not wait for the normal rate interval. The one attempt still respects pause, unchanged-frame checks, and the existing startup hold; a real send success or failure records the normal attempt time, while failed, no-op, or paused saves do not queue a later bypass. An in-flight physical write completes first, then the latest saved frame is considered. This preserves the normal cadence and avoids stale or delayed bypasses; delivery and application tests cover the behavior.
- User decision (2026-09-07): an effective manual or Home Assistant pause freezes the last successful raw board frame under a saved per-board overlay. `null` cells are transparent and numeric local character codes are opaque, including code `0` for an intentional blank; collection continues while paused, overlay edits remain on that same raw base, pause-related writes use the normal cadence, and resume requests the latest live frame. If startup has no sent frame, initialize the remembered pause from a bounded first collection; a board-size change rebuilds the frozen base for the new dimensions.
- Platform pause can come from Home Assistant. Retain its last known result when unavailable, including across restarts.
- Every PR in this change's stack must be independently usable when merged into main in order.
- Plugins is a compact index of Codex and Water heater rows; each plugin detail page owns its settings and scoped Save/Discard controls. Shared Home Assistant connection and pause automation live together on the direct Settings page, with independent section saves so unrelated drafts survive navigation and acknowledgement.
- The app shell keeps a compact expandable legacy-environment warning visible on Board, Plugins, and Settings. Board owns preview, output status, and layout editing; Settings owns board output configuration.
- HA connection and raw entity subscriptions belong to the shared foundation. Water entity selection, units, validation, readings and settings belong to the water-heater plugin. Application wiring may know the plugins, but must not interpret their settings or readings. Plugins must not depend on one another.
- Board layout entries support rectangular placement with optional starting column and width; omitted values preserve legacy full-row placement. Element metadata may require a minimum width, and each plugin remains responsible for rendering its allocated width. Water Heater exposes EMV position as its own compact element and setting.

Remember the HA pause binding identity alongside its boolean so a different entity configured while the service is stopped cannot inherit an old unpaused value. Late events from a replaced connection must not resume the new binding. This is persistence metadata, not a separate pause mode.
