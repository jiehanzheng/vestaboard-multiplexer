# Generic bar and text rows

- The user chose an independent generic row with stable instance IDs, an HA-supplied display name, current value, maximum and display text. Support both one entity supplying attributes and individual state/attribute bindings; calculations and domain meaning belong in Home Assistant.
- Label and text areas have configurable fixed widths and align left; the remaining allocated placement width forms the bar. Text changes must not resize it. Preserve ceiling-based fill and use the configured fallback on overflow rather than truncating text.
- The approved household setup reserves two label cells and three text cells with blue character `67`: `HW`, ten bar cells, then `3S ` on a 15-cell Note placement. Replace only its existing water-remaining placement; preserve water temperature/EMV, music priorities, Codex and delivery limits. Existing water and character-block configurations remain compatible; do not migrate them automatically.
- Invalid inputs use immediate fallback without mixing retained and fresh fields. Healthy unchanged values do not become stale. These choices were confirmed in the coordinated hot-water implementation approval (2026-10-15).
