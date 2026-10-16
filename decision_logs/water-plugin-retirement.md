# Water plugin retirement

- User decision (2026-10-15): retire the dedicated water plugin entirely. Home Assistant owns water calculations and formatting; generic bar and text rows render remaining-water values, and HA character blocks render temperature and EMV displays.
- Keep generic rendering free of water-specific calculations and behavior. Preserve existing HA character blocks and Codex behavior.
- The initial compatibility policy covered only known retired ownership. The user subsequently broadened it to all unsupported top-level saved keys and layout references; see [unsupported saved configuration](unsupported-saved-configuration.md). The water plugin remains removed.
- This supersedes dedicated-water guidance in [plugin display labels](plugin-display-labels.md), [EMV problem display](emv-problem-display.md), and [plugin staleness](plugin-staleness.md). Those files record the earlier decisions; equivalent water behavior now belongs in Home Assistant.
