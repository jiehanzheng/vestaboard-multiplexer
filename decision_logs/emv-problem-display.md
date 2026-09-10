# Optional EMV problem display

- User decision: an optional problem-entity selection replaces the EMV position digits with a red tile followed by `MFO` while the condition is active. Preserve the configured EMV label; leaving the binding unset preserves the ordinary position display.

- User decision: the problem condition is a string-equality check, not a choice of specialized modes.
