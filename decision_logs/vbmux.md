# Runtime diagnostics

- User decision: the UI shows current-run recent logs from a bounded in-memory buffer while Docker owns retained and rotated history; the application does not create duplicate log files.
- Plugin diagnostics remain plugin-owned. Water status describes each configured input and retains safe last-good values during Home Assistant outages; core runtime only transports the status and log events.

# Water temperature display

- User decision: the water temperature divider becomes the Vestaboard heart only when the optional Home Assistant heating entity reports a recognized on state; unknown or unavailable states use `/` and report a diagnostic. The temperature bar and baseline setting are retired, while legacy saved layouts discard only the retired bar placement during load.
