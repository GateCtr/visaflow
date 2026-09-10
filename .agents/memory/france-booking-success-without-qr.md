---
name: France booking success without QR
description: Live-confirmed success semantics for consulat.gouv.fr reservations/family responses without qrCodes.
---

Treat an HTTP 2xx response from `reservations/family` as an accepted booking
even when the response body has no non-empty `data.qrCodes`. QR codes are
optional confirmation data, not the success condition.

**Why:** On 2026-09-10, a controlled real ADF booking returned HTTP 2xx without
usable `qrCodes`; the booking was nevertheless created and its confirmation
email was received. Classifying this as failure risks booking a second slot.

**How to apply:** Keep HTTP errors, session errors, and network failures as
failures. After an HTTP 2xx final response, report success; distinguish
`acceptedWithoutQr` for observability and never retry automatically.