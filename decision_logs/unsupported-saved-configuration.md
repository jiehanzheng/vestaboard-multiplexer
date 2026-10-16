# Unsupported saved configuration

- User correction (2026-10-15): tolerate any unsupported top-level saved configuration key, not just known retired plugins. Ignore and warn with exact key names and unsupported layout element IDs; expose no ignored values. This supersedes the ownership-limited policy in [water plugin retirement](water-plugin-retirement.md).
- Normalize supported legacy migrations (`haBlock` and `updateIntervalMinutes`) before classifying unsupported keys. Supported nested schemas and API patches remain strict; malformed supported values still report errors.
- Pure reads do not rewrite saved configuration. Ordinary saves preserve ignored data privately in a versioned archive with generic key and placement records. Warnings persist until explicit cleanup; cleanup removes only ignored data and preserves unrelated saved settings and drafts.
- Show the expandable warning on every screen with an actionable cleanup button. Supported generic plugins provide replacement content; no automatic domain-specific conversion is performed.
