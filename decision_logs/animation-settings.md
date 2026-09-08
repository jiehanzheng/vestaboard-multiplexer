# Animation settings

- User decision (2026-09-08): expose the existing Local API transition strategy, delay, and step size in Board output settings. Pause settings may save one optional Local API transition override shared by the pause and resume writes; the default inherits the normal transition. Cloud API connections explain and disable these controls while retaining saved values for a later Local API connection. Pause and resume continue to use the normal delivery cadence and unchanged-frame checks.
