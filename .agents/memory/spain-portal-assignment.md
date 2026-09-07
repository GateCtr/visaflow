---
name: Spain portal assignment
description: Per-dossier Spain portal routing and the global pricing fallback.
---

The Spain worker must resolve a dossier's portal as `hunterConfig.scheduleUrl` first, then the top-level pricing `portalUrl` only as a fallback.

**Why:** The Spain pricing record currently carries Kinshasa as its global portal URL. Using that value first silently sends every Spain dossier to Kinshasa, even when the admin assigned Saopolo or another Bookitit widget in the dossier configuration.

**How to apply:** Keep the per-dossier schedule URL as the authoritative routing value, and use the pricing portal only when no dossier-specific URL exists. Log the selected widget key when diagnosing routing.