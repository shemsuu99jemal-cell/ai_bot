# AI Seller Bot (TypeScript, cart-enabled)

Full flow, matching what you described:

1. Customer taps your Telegram bot link (`t.me/YourBotName`) → lands directly in the bot. No extra code needed for this — it's just your bot's own link, share it anywhere.
2. Picks a language (English / Amharic)
3. Asks about products, prices, discounts, anything — AI answers from live catalog data, and forwards anything it's not sure about (discounts, policy, complaints) to you instead of guessing
4. Says "I want that" → AI adds it to cart, asks if they want anything else
5. Customer keeps browsing/adding, or says "that's all" / "checkout" → AI finalizes the cart
6. Bot creates the order, shows your payment account details
7. Customer sends a payment screenshot → bot uploads it, gives the customer a reassuring "we're verifying" message
8. **You get notified instantly** in Telegram: full itemized order + the screenshot + Confirm/Reject buttons
9. You tap Confirm or Reject → customer automatically gets a confirmation or a "please contact us" message
10. If you don't respond in time, the bot reminds you (and eventually SMS's you — see `src/sms.ts`)

Reject flow upgrade:

- Seller can now reject immediately, or tap "Add reason and reject" and send a custom reason to the customer.

---

## Setup

**1. Supabase**

- SQL Editor → run `schema.sql` (creates `products`, `orders`, `order_items`, `conversations`)
- Storage → new bucket `payment-screenshots`, set Public
- If you're also using the admin dashboard, also run `schema-admin.sql`
- Settings → API → copy URL + `service_role` key into `.env`

**2. Telegram + OpenAI**

- @BotFather → `/newbot` → token into `.env`
- @userinfobot → your numeric ID into `.env` as `SELLER_TELEGRAM_ID`
- platform.openai.com → API key into `.env`

**3. Install & run**

```bash
npm install
cp .env.example .env   # fill in all values
npm run dev             # ts-node-dev, auto-restarts on changes
```

For production: `npm run build` (compiles to `dist/`) then `npm start`.

---

## Deploy on Vercel (Webhook mode)

This project now supports webhook mode for serverless hosting.

**1. Set environment variables in Vercel**

- Use all keys from `.env.example`
- Set `BOT_MODE=webhook`
- Set strong random values for:
  - `TELEGRAM_WEBHOOK_SECRET`
  - `CRON_SECRET`

**2. Deploy**

- Push this repo to GitHub
- Import into Vercel
- Deploy

**3. Register Telegram webhook**

- After deploy, run this (replace values):

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
	-d "url=https://<your-app>.vercel.app/api/telegram" \
	-d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

**4. Verify**

- Open: `https://<your-app>.vercel.app/api/telegram` -> should return ok JSON
- Open: `https://<your-app>.vercel.app/api/escalation` with header `Authorization: Bearer <CRON_SECRET>` to test reminders
- `vercel.json` already schedules `/api/escalation` every 5 minutes

Notes:

- In webhook mode, polling is disabled automatically.
- Reminders run via Vercel cron endpoint, not `node-cron` background loop.

---

## Testing the cart flow

1. Message your bot, pick a language
2. "do you have a charger?" → should find the seeded 20W charger
3. "I'll take one" → adds to cart, bot asks if you want anything else
4. "also an iphone 13" → adds a second item
5. "that's everything, checkout" → bot totals the cart, shows payment info
6. Send any photo as a test screenshot
7. Check your own Telegram — you should get the itemized order + screenshot + buttons
8. Tap Confirm → customer side gets the confirmation message

---

## Files

- `src/index.ts` — bot entrypoint: language, conversation routing, checkout, screenshot handling, seller confirm/reject
- `src/ai.ts` — the AI layer: `search_products`, `add_to_cart`, `view_cart`, `checkout`, `ask_seller` tools
- `src/db.ts` — all typed Supabase queries
- `src/cron.ts` / `src/sms.ts` — reminder escalation if the seller doesn't respond
- `src/types.ts` — shared types (Product, Order, CartItem, Session)

## Known gaps (same honesty as before)

- SMS escalation (`src/sms.ts`) is a placeholder until you wire in a real Ethiopia-covering provider (SMSEthiopia recommended, sign up for their key/docs)
- Single seller only — no multi-tenant scoping yet
- In-memory cache in `index.ts` is just a speed optimization; the real session lives in Supabase (`conversations` table), so a restart is safe
