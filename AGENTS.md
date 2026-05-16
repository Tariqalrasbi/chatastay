# ChatStay Agent Instructions

You are working on ChatStay, a WhatsApp-first PMS and booking SaaS.

Rules:
- Do not rewrite the whole app.
- Do not change unrelated files.
- Do not redesign architecture unless explicitly asked.
- Preserve Prisma/database logic.
- Preserve WhatsApp routing unless the task is specifically about WhatsApp.
- Preserve payment logic unless the task is specifically about payments.
- Patch only the requested issue.
- Inspect relevant files before editing.
- Prefer small, safe, reversible changes.
- After editing, explain root cause, files changed, and how to test.

Product standard:
- PMS-grade workflows.
- OTA-grade booking, checkout, cancellation, payment, and guest-service behavior.
- UI should be simple, clean, mobile-friendly, and suitable for hotel partners.