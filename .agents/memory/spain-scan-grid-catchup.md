---
name: Spain scan grid catch-up
description: Cadence rule for Kinshasa workers whose mandatory PHP session refresh can exceed the wall-clock hunt tick.
---

## Rule

Kinshasa workers recreate the PHP session and run the full portal cycle on every scan. Use a 10-second hunt grid rather than a 6-second grid, launch known-portal `getservices/` and `getagendas/` in parallel with only a 0–200 ms desynchronizing jitter, and allow at most one bounded out-of-grid catch-up after a no-slot scan when more than half the next tick remains. The worker must then rejoin the next absolute grid front.

**Why:** A 6-second grid systematically caused 7–8 second scans to miss every other front. Waiting for a later front wasted the opportunity to observe a slot that appeared between the scan and that front, while unrestricted immediate retries could create a tight loop and a portal burst.

**How to apply:** Keep catch-up limited to the hunt phase, require a no-slot result, add only a small deterministic jitter, and reset the catch-up allowance after the worker sleeps to a grid front. A found slot proceeds directly to booking; recovery errors do not use catch-up.