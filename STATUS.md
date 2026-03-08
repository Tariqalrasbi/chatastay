# WhatsStay System Status

## Current Stable Behavior

### Greeting and Menu
- Greeting inputs such as `hi`, `hello`, `hey`, `start`, `السلام عليكم`, and `مرحبا` return a welcome/menu response.
- Menu response is structured to guide users toward:
  - asking about rooms/facilities
  - asking about prices/policies
  - starting a booking
- Greeting/menu behavior is currently stable.

### Knowledge-Base Hotel Questions
- Hotel information questions are answered from `src/data/al_ashkhara_knowledge.json`.
- Covered categories include:
  - room types and room details
  - amenities
  - restaurant and coffee shop
  - activities
  - policies and cancellation
  - contacts
- If details are not found, the bot falls back with a graceful informational message.

### Booking Flow UX
- Booking intent (e.g. `i want to book`) returns a polished booking prompt with examples.
- Natural language booking input supported, including:
  - `2026-04-10 to 2026-04-12 for 2 guests`
  - `2 guests from 10 April to 12 April`
- Incomplete booking details trigger missing-part prompts.
- Quote response includes:
  - room type
  - check-in/check-out
  - guests
  - nights
  - total price
  - simple YES/EDIT/NO continuation prompt
- Confirmation path:
  - `yes` continues confirmation
  - `no`/`edit` asks what to change

## Known Limitations
- WhatsApp Cloud test environment only sends to allowed recipient numbers.
- Public callback URL depends on active temporary tunnel uptime.
- Knowledge answers are keyword/FAQ-match based, not full semantic search.
- Some non-booking ambiguous text may still route to fallback menu instead of a direct answer.

## Required Environment Variables
- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `WHATSAPP_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

## Current Webhook Entry
- Application route mount: `src/index.ts`
- WhatsApp webhook router file: `src/whatsapp/webhookRouter.ts`
- Incoming flow path:
  - `webhookRouter.ts`
  - `conversationController.ts`
  - `send.ts`

## Technical Debt / Operational Risks
- Temporary public tunnel dependency (e.g. localhost.run):
  - callback URL expires/disconnects
  - requires frequent manual updates in Meta webhook config
- Multiple local dev processes can cause stale runtime behavior if not managed.
- Runtime-created `messages` SQL table exists outside Prisma migration flow.
- Legacy `src/whatsapp/webhook.ts` remains excluded in `tsconfig.json` due to prior duplication issue; active webhook is `webhookRouter.ts`.

