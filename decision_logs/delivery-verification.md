# Delivery verification

- After the physical board retained a pause overlay while vbmux reported the normal frame sent, the owner chose option 2: verify each delivery and allow one bounded corrective send through the normal scheduler. HTTP acceptance and readback confirmation must remain distinct; a manual resend alone is not the permanent repair.
- The owner requires race conditions to be addressed through coherent delivery ownership and architecture rather than special-case patches. Preserve the existing pause, animation, and update-limit decisions in [vbmux](vbmux.md) and [animation settings](animation-settings.md).
