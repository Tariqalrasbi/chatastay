# ChatStay Architecture Rules

ChatStay contains two subsystems:

1. WhatsApp Booking Engine
2. Admin Dashboard

The WhatsApp booking engine is the highest priority.

Cursor must NEVER modify these modules unless specifically requested:

src/core/availability.ts
src/core/pricing.ts
src/core/bookingService.ts
src/core/stateMachine.ts

These modules are considered STABLE CORE.

Cursor may only modify:

src/routes/
src/whatsapp/
UI templates

unless explicitly instructed.

The goal is stability and reliability of booking logic.