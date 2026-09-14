---
name: Slot Hunter operational logging
description: Keep scanner logs focused on failures, bookings, slots, locks, and meaningful state changes.
---

Startup, configuration-default, proxy-pool, and successful-restoration messages should stay silent unless they indicate an actionable problem. Keep warnings, errors, booking outcomes, slot discoveries, lock changes, and other state transitions.

**Why:** Repeated startup and per-account diagnostics obscured the booking and scanner events needed to operate Spain and the other portal loops.

**How to apply:** When adding or changing scanner logs, prefer one compact startup line and emit details only for actionable failures or state changes.