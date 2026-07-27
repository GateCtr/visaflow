---
name: Spain Bookitit dossier session isolation
description: Rule for booking multiple Spain dossiers through one Decodo IP without sharing Bookitit PHP sessions
---

## Rule
Reuse the same Cloudflare clearance and Decodo proxy across dossiers, but never reuse the Bookitit `PHPSESSID`. Before each dossier booking, clone the CF session without `PHPSESSID`, call `main/`, capture its `Set-Cookie: PHPSESSID`, and keep that cookie local through `datetime/`, `signin/`, OTP confirmation, and `summary/`.

**Why:** Bookitit can associate `bktToken` and appointment state with the server-side PHP session. A second dossier using the same `PHPSESSID` can overwrite the first dossier's state, while a booking also consumes the unique slot.

**How to apply:** Keep the shared `SpainCfSession` immutable during dossier booking. Use a deep-enough cookie-array copy per dossier, require a fresh `PHPSESSID` from `main/`, and serialize booking attempts unless a separate slot/session reservation mechanism is added.