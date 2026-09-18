---
name: Spain history ticket payload
description: Bookitit confirmation printing and local PDF rendering behavior for the Spain portal
---

Bookitit does not return a PDF from the print action. The live history flow calls `geteventhistory/`, receives `Events.Customer` and `Events.Appointment`, renders the ticket in the client, then invokes browser printing. The appointment locator may legitimately be null in this response.

**Why:** The live bundle's ticket view formats the appointment in JavaScript; assuming a downloadable PDF or a flat `Event` object loses the actual ticket fields.

**How to apply:** For HTTP-only diagnostics and production retrieval, persist the raw `geteventhistory/` payload, map Customer/Appointment fields, and generate or render the document locally. Treat `deleteeventhistory/` as a separate destructive action requiring explicit confirmation. In this Replit environment, Playwright's managed browser may be absent; the installed Puppeteer Chrome needs the workflow's Mesa/libudev `LD_LIBRARY_PATH`.