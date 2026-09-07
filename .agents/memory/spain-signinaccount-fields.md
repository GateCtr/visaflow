---
name: Spain signin account fields
description: The history/cancellation login exposes the portal's accepted login types through a dynamic fields endpoint.
---

The history/cancellation route opens `#signinaccount`, which calls `getsigninaccountfields/`. The response's `CustomFields.Clients` entries are the authoritative selector options: `input_text` is the exact `logintype`, while `field_text` is its human label.

Live checks on 2026-09-07 returned one validated option for each tested portal: São Paulo (`document`, label `Nº de Matrícula`) and Cuba/LMD (`document`, label `CI`). Neither returned `passport` or `email`.

**Why:** The static JavaScript does not enumerate the accepted login types, while the dynamic account-login fields do. Guessing fallback names could send unsupported authentication requests.

**How to apply:** Query this endpoint with the same portal session before selecting a login type. Prefer only entries with `show_widget=1` and `validate=1`; use the returned `input_text` values for `signin/` only after confirming the booking flow accepts the same contract.