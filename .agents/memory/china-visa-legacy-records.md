---
name: China visa legacy records
description: Compatibility rule for historical China applications after correcting the Kinshasa visa flow.
---

Treat every China application as a paper-visa route, even if an older record stores `successModel: "evisa"` or a visa type naming an e-Visa or VFS. Keep historical records intact; normalize their display labels and effective processing model instead of rewriting or deleting application data.

**Why:** Existing applications must remain usable while client, admin, payment, and public surfaces stop making false e-Visa claims.

**How to apply:** For changes to China visa types, documents, payment, status, or display, resolve the route from the destination and map legacy labels at read time. Do not migrate old records unless explicitly requested.