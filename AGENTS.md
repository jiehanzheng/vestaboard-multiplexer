## README and assets updates

When a change affects Vestaboard rendering output, always update README as appropriate, but do not increase the level of detail unless the user explicitly requests it.

You MUST proactively OFFER to update visuals using the `vestaboard-safari-screenshots` skill, but you MUST NOT perform those visual updates until you have the user's approval.
## Shared local resources

Always use `pfm` before starting local servers, previews, tests that bind ports, or containers that publish host ports. Reserve a port for the current checkout and service; pass the assigned port through `VBMUX_PORT`. Never assume port 3000 or probe for an arbitrary free port outside `pfm`.

Use `pfm status` to inspect allocations. Keep processes attached and owned; stop the process before releasing its reservation with `pfm port release <role>`.

Use the relevant `pfm` command for other shared local resources as well. See README for the local preview and Docker commands.
