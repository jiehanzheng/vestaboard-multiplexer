# Generic bar and text rows

- The user chose an independent generic row with stable instance IDs, an HA-supplied display name, current value, maximum and display text. Support both one entity supplying attributes and individual state/attribute bindings; calculations and domain meaning belong in Home Assistant.
- Label and text areas have configurable fixed widths; the label aligns left and display text aligns right (user correction, 2026-10-15); the remaining allocated placement width forms the bar. Text changes must not resize it. Preserve ceiling-based fill and use the configured fallback on overflow rather than truncating text.
- Preserve music priorities, Codex, delivery limits and existing character-block configurations. The earlier decision to retain dedicated water temperature/EMV and water-config compatibility is superseded by [water plugin retirement](water-plugin-retirement.md); the generic fixed label/text design remains in force.
- Invalid inputs use immediate fallback without mixing retained and fresh fields. Healthy unchanged values do not become stale. These choices were confirmed in the coordinated hot-water implementation approval (2026-10-15).
