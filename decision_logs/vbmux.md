# vbmux

- Plugins collect independently of board delivery and contribute separately placeable elements. Each size is a distinct element with a fixed height; rendering receives available width.
- Keep the design simple: use fixed row placement, without rotation or whole-screen priority takeover.
- The web interface is a React app with live updates where useful. Serve plain HTTP without application authentication; the operator manages access.
- Environment variables continue to override saved settings and appear locked in the interface.
- Board updates have a configurable rate limit independent of plugin collection. The startup banner displays for 30 seconds outside the normal limit, which starts with real data.
- Platform pause can come from Home Assistant. Retain its last known result when unavailable, including across restarts.
- Every PR in this change's stack must be independently usable when merged into main in order.
- HA connection and raw entity subscriptions belong to the shared foundation. Water entity selection, units, validation, readings and settings belong to the water-heater plugin. Application wiring may know the plugins, but must not interpret their settings or readings. Plugins must not depend on one another.

Remember the HA pause binding identity alongside its boolean so a different entity configured while the service is stopped cannot inherit an old unpaused value. Late events from a replaced connection must not resume the new binding. This is persistence metadata, not a separate pause mode.
