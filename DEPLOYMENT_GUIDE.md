# Complete Deployment Guide: Telegram Seller Bot on Vercel

## Overview

This bot has two deployment modes:

1. **Local Development** (Polling mode) - for testing
2. **Production on Vercel** (Webhook mode) - serverless with scheduled tasks

---

## Prerequisites

### 1. GitHub Account & Repository

- Push your code to GitHub
- Create a new repository: `github.com/YOUR_USERNAME/ai-seller-bot-ts`
- Push the code:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git branch -M main
  git remote add origin https://github.com/YOUR_USERNAME/ai-seller-bot-ts.git
  git push -u origin main
  ```

### 2. Supabase Project (Already Set Up)

- ✅ Database created with schema
- ✅ Tables: `products`, `orders`, `order_items`, `conversations`
- ✅ Run SQL commands to add missing columns (see below)
- ✅ Storage bucket: `payment-screenshots` (public access)

### 3. Telegram Bot Token

- ✅ Already have `BOT_TOKEN` from @BotFather
- ✅ Already have `SELLER_TELEGRAM_ID` (your Telegram ID)

### 4. Vercel Account

- Create free account at https://vercel.com
- Allows unlimited deployments

---

## Step 1: Update Supabase Schema

Run these SQL commands in **Supabase → SQL Editor** to add missing columns:

```sql
-- Add missing columns to orders table
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS customer_phone text;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS delivery_location text;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS delivery_fee numeric DEFAULT 0;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS subtotal numeric;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Add to conversations table
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS customer_phone text;

ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS pending_step text;
```

**Verify in Supabase:**

- Go to **Table Editor**
- Click `orders` table
- Scroll right to see new columns

---

## Step 2: Prepare Environment Variables

Create a `.env.production` file (or use Vercel secrets):

```env
# Telegram
BOT_TOKEN=<your_bot_token_from_botfather>
BOT_MODE=webhook
SELLER_TELEGRAM_ID=<your_telegram_id>
SELLER_PHONE_NUMBER=<seller_phone>
SELLER_PAYMENT_INFO=<bank_account_or_payment_method>

# Supabase
SUPABASE_URL=<your_supabase_url>
SUPABASE_SERVICE_KEY=<your_service_key>

# AI Models
GROQ_API_KEY=<your_groq_key>
GEMINI_API_KEY=<your_gemini_key>

# Security
TELEGRAM_WEBHOOK_SECRET=<random_secret_key>
CRON_SECRET=<random_secret_for_escalation>

# Optional
DELIVERY_FEE_OUTSIDE_ADDIS=150
```

### Where to find values:

| Variable                  | Where to Get                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- |
| `BOT_TOKEN`               | @BotFather on Telegram → /mybots → Select bot → API Token                        |
| `SELLER_TELEGRAM_ID`      | Forward any message to @userinfobot, it shows your ID                            |
| `SUPABASE_URL`            | Supabase Dashboard → Project Settings → API → Project URL                        |
| `SUPABASE_SERVICE_KEY`    | Supabase Dashboard → Project Settings → API → service_role (anon key won't work) |
| `GROQ_API_KEY`            | https://console.groq.com → API Keys                                              |
| `GEMINI_API_KEY`          | https://makersuite.google.com/app/apikey                                         |
| `TELEGRAM_WEBHOOK_SECRET` | Generate any random string (e.g., `openssl rand -hex 16`)                        |
| `CRON_SECRET`             | Generate any random string for cron job security                                 |

---

## Step 3: Deploy to Vercel

### Option A: Deploy via Vercel Dashboard (Easiest)

1. **Go to https://vercel.com/dashboard**
2. Click **Add New → Project**
3. Click **Import Git Repository**
4. Paste your GitHub repo URL and click Import
5. **Project Settings:**
   - Framework: `Other`
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Install Command: `npm install`

6. **Add Environment Variables:**
   - Click **Environment Variables**
   - Add each variable from `.env.production`
   - Deploy to: Production, Preview, Development

7. Click **Deploy** (wait 2-3 minutes)

### Option B: Deploy via CLI

```bash
npm install -g vercel
vercel login  # Login with GitHub
vercel        # Deploy to production
vercel env add BOT_TOKEN    # Add each env variable
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_KEY
# ... add all other variables
vercel --prod  # Deploy to production
```

---

## Step 4: Get Your Vercel URL

After deployment:

1. Go to https://vercel.com/dashboard
2. Click your project
3. Copy **Production URL** (e.g., `https://ai-seller-bot-ts.vercel.app`)

---

## Step 5: Set Telegram Webhook

**Set your webhook URL with Telegram:**

Replace `YOUR_URL` with your Vercel URL:

```bash
curl -X POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_URL/api/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

**Example:**

```bash
curl -X POST https://api.telegram.org/bot123456789:ABCDefghijklmnopqrstuvwxyz/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://ai-seller-bot-ts.vercel.app/api/telegram",
    "secret_token": "my-super-secret-webhook-key"
  }'
```

**Verify webhook is set:**

```bash
curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

Should return:

```json
{
  "ok": true,
  "result": {
    "url": "https://ai-seller-bot-ts.vercel.app/api/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0
  }
}
```

---

## Step 6: Test the Bot

### Test in Telegram:

1. **Find your bot** on Telegram (search for bot name)
2. Click **Start**
3. Try commands:
   - `/start` → Should show main menu
   - `/menu` → Browse categories
   - Type `iphone` → Search products
   - Click product → Add to cart
   - `/cart` → View cart
   - Click **Checkout** → Follow payment flow

### Test Rejection Flow:

1. **Customer:** Send payment screenshot
2. **You (as seller):** Open `/admin` to see pending orders
3. **You:** Click order → Choose "Reject now" or "Add reason & reject"
4. **Customer:** Receives rejection message with reason
5. **Customer:** `/orders` shows rejected status with reason

---

## Step 7: Enable Cron Jobs (Escalation Reminders)

Vercel automatically runs cron jobs defined in `vercel.json` every 5 minutes:

```json
{
  "crons": [
    {
      "path": "/api/escalation",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

**What it does:**

- Checks orders pending verification > 15 min
- Sends seller Telegram reminders
- After 3 reminders, sends SMS to seller

---

## Step 8: Full Bot Workflow (Testing Checklist)

### Customer Flow:

- [ ] `/start` displays greeting + main menu
- [ ] "Browse" → Lists categories
- [ ] Category → Shows products with prices
- [ ] Product → Shows details, colors, stock count
- [ ] "Add to cart" → Updates cart
- [ ] `/cart` → Shows items with total
- [ ] "Checkout" → Prompts for phone number
- [ ] Phone shared → Shows delivery options
- [ ] Delivery selected → Shows payment details
- [ ] Screenshot sent → Shows confirmation
- [ ] `/orders` → Shows "Verifying payment" status

### Seller Flow:

- [ ] Bot sends order photo to seller with ✅/❌ buttons
- [ ] `/admin` → Lists all pending orders
- [ ] Tap order → Shows full details
- [ ] "Confirm" → Customer gets order confirmed message
- [ ] "Reject now" → Customer gets rejection message
- [ ] "Add reason & reject" → Seller types reason → Customer sees reason

### Amharic Support:

- [ ] `/language` → Choose language
- [ ] Select Amharic → All text switches to Amharic
- [ ] Type in Amharic → Bot understands and responds

---

## Step 9: Production Monitoring

### View Logs:

```bash
vercel logs <project-name>
```

### Check Webhook Status:

```bash
curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

### Monitor Supabase:

- Go to Supabase Dashboard → **Logs**
- See all database queries
- Check for errors

---

## Troubleshooting

### Bot doesn't respond

1. Check webhook is set: `curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`
2. Check Vercel logs: `vercel logs <project>`
3. Check environment variables in Vercel dashboard
4. Verify `TELEGRAM_WEBHOOK_SECRET` matches in webhook URL

### Products show "out of stock" even with stock 4

1. ✅ Already fixed by normalizing stock values
2. Rebuild & redeploy: `git push` → Vercel auto-deploys

### Rejection doesn't work

1. Verify `rejection_reason` column exists: Check Supabase table editor
2. Run SQL commands from Step 1 if missing
3. Redeploy: `git push`

### Seller doesn't receive order notifications

1. Verify `SELLER_TELEGRAM_ID` is correct (9-10 digit number)
2. Test: `curl https://api.telegram.org/bot<TOKEN>/sendMessage -d "chat_id=<ID>&text=test"`
3. Check Vercel logs for errors

### Cron jobs not running

1. Verify `vercel.json` exists with correct format
2. Redeploy: `git push`
3. Check Vercel Cron logs after 5 minutes

---

## Summary: Quick Start Checklist

- [ ] 1. Push code to GitHub
- [ ] 2. Run SQL commands in Supabase
- [ ] 3. Create Vercel account & import project
- [ ] 4. Add all environment variables
- [ ] 5. Deploy (Vercel auto-builds)
- [ ] 6. Copy Vercel URL
- [ ] 7. Set Telegram webhook with `setWebhook`
- [ ] 8. Test bot in Telegram
- [ ] 9. Test rejection flow
- [ ] 10. Monitor logs

---

## Support Commands

**If something breaks:**

```bash
# View recent logs
vercel logs ai-seller-bot-ts --tail

# Redeploy
git push origin main

# View deployment status
vercel status

# Check bot health
curl https://YOUR_URL/api/telegram  # Should return 200 OK
```

---

## Cost Estimate (Monthly)

| Service          | Free Tier              | Cost   |
| ---------------- | ---------------------- | ------ |
| Vercel           | ✅ Unlimited           | $0     |
| Supabase         | ✅ 500MB DB            | $0     |
| Telegram Bot API | ✅ Unlimited           | $0     |
| Groq API         | ✅ ~10k requests/month | $0     |
| Gemini API       | ✅ Free tier           | $0     |
| **Total**        |                        | **$0** |

All services have generous free tiers for this bot size!

---

## Next Steps After Deployment

1. **Customize bot name & description** in @BotFather
2. **Add bot to group chats** (optional)
3. **Set up backup strategy** (export Supabase regularly)
4. **Monitor performance** (check logs weekly)
5. **Update products** via Supabase table editor or API

Enjoy your deployed bot! 🚀
