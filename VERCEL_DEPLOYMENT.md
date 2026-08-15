# Deploy to Vercel from GitHub - Step by Step

## Prerequisites
✅ Code pushed to GitHub (you've already done this!)
✅ Vercel account (free or paid)
✅ All environment variables ready

---

## Step 1: Go to Vercel Dashboard

1. Open https://vercel.com
2. Click **Sign In** (or create a free account)
3. You should see the **Dashboard**

---

## Step 2: Import Project from GitHub

1. Click **"Add New..."** button (top right)
2. Select **"Project"**
3. Click **"Import Git Repository"**
4. Paste your GitHub repo URL:
   ```
   https://github.com/shemsuu99jemal-cell/ai_bot.git
   ```
5. Click **"Continue"**

> Vercel will connect to your GitHub and ask for permission

---

## Step 3: Configure Project

You'll see a form with:

### Project Name
- Change to: `ai-seller-bot` (or your preferred name)

### Framework Preset
- **Keep as:** `Other` (for Node.js/TypeScript)

### Root Directory
- **Keep as:** `./` (root)

### Build Command
- **Set to:** `npm run build`

### Output Directory
- **Set to:** `dist` (where compiled files go)

### Environment Variables
**This is CRITICAL - add all your secrets here:**

Click **"Add Environment Variables"** and paste each one:

```
BOT_TOKEN = your_telegram_bot_token
GROQ_API_KEY = your_groq_api_key
GEMINI_API_KEY = your_gemini_api_key
SUPABASE_URL = your_supabase_url
SUPABASE_SERVICE_KEY = your_supabase_service_key
SELLER_TELEGRAM_ID = your_seller_telegram_id
SELLER_PHONE_NUMBER = your_phone_number
SELLER_PAYMENT_INFO = your_payment_info
BOT_MODE = webhook
TELEGRAM_WEBHOOK_SECRET = generate_a_random_secret_token
CRON_SECRET = generate_another_random_secret_token
DELIVERY_FEE_OUTSIDE_ADDIS = 150
```

**To generate random secrets in PowerShell:**
```powershell
[guid]::NewGuid().ToString()
```

---

## Step 4: Deploy

1. Click **"Deploy"** button
2. Wait for build to complete (2-5 minutes)
3. You'll see a success message with your deployment URL:
   ```
   🎉 Your project is live!
   https://your-project-name.vercel.app
   ```

---

## Step 5: Update Telegram Webhook

After deployment, configure Telegram to use your webhook:

### Option A: Using curl (PowerShell)

```powershell
$botToken = "YOUR_BOT_TOKEN"
$webhookUrl = "https://your-project-name.vercel.app/api/telegram"
$secret = "YOUR_TELEGRAM_WEBHOOK_SECRET"

$body = @{
    url = $webhookUrl
    secret_token = $secret
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### Option B: Manual Setup

1. Open browser and go to:
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://your-project-name.vercel.app/api/telegram&secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET
   ```
   Replace:
   - `YOUR_BOT_TOKEN` with your actual token
   - `your-project-name` with your Vercel project name
   - `YOUR_TELEGRAM_WEBHOOK_SECRET` with your secret

2. You should get response:
   ```json
   {"ok":true,"result":true,"description":"Webhook was set"}
   ```

---

## Step 6: Test the Bot

1. Open Telegram
2. Search for your bot
3. Type `/start`
4. You should see:
   ```
   Welcome to the shop. Choose what you want next.
   ```

---

## Step 7: Setup Database

**Important:** Run the SQL schema in Supabase FIRST (before bot traffic comes in):

1. Go to your Supabase project
2. Click **SQL Editor**
3. Paste content from `schema.sql` in your project
4. Click **Run**

Then add the missing columns (if needed):
```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_location text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee numeric DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason text;
```

---

## Step 8: Configure Cron Job (Order Escalation)

The `vercel.json` already has:
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

This runs every 5 minutes. Vercel will automatically call `/api/escalation` with:
```
Authorization: Bearer YOUR_CRON_SECRET
```

✅ **No extra setup needed** - Vercel handles this automatically!

---

## Troubleshooting

### Bot not responding?
1. Check logs in Vercel: **Deployments > Your deployment > Logs**
2. Verify webhook is set:
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo
   ```
   Should show your Vercel URL

### "Connection refused" error?
- Make sure `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correct
- Test connection: Add a test endpoint in `api/test.ts`

### Environment variables not loading?
1. Go to Vercel > Project Settings > Environment Variables
2. Verify all 11 variables are added
3. Redeploy: **Deployments > Current > Redeploy**

### Cron job not running?
1. Verify `vercel.json` is in root directory
2. Check Vercel > Cron Jobs tab
3. Verify `CRON_SECRET` is set in Environment Variables

---

## Key URLs After Deployment

| Purpose | URL |
|---------|-----|
| Telegram Webhook | `https://your-project-name.vercel.app/api/telegram` |
| Escalation Cron | `https://your-project-name.vercel.app/api/escalation` |
| Dashboard | `https://vercel.com/dashboard` |
| Project Settings | `https://vercel.com/projects/your-project-name/settings` |

---

## Verification Checklist

- [ ] Code pushed to GitHub
- [ ] Vercel project created and deployed
- [ ] All 11 environment variables set in Vercel
- [ ] Telegram webhook configured
- [ ] Database schema created in Supabase
- [ ] Bot responds to `/start` in Telegram
- [ ] Seller can access `/admin` command
- [ ] Cron job showing in Vercel dashboard

---

## Next Steps

After successful deployment:

1. **Test in Telegram:**
   - `/start` - Main menu
   - `/menu` - Shop menu
   - `/orders` - View orders
   - `/admin` - Seller panel (for your seller ID)

2. **Test full flow:**
   - Browse products → Add to cart → Checkout
   - Upload payment screenshot
   - Check `/admin` panel
   - Confirm or reject order

3. **Monitor logs:**
   - Go to Vercel dashboard
   - Click **Deployments > Recent > Logs**
   - Watch for errors in real-time

4. **Scale up:**
   - Add more products in Supabase
   - Configure payment info
   - Set delivery areas and fees

---

## Support Resources

- **Vercel Docs:** https://vercel.com/docs
- **Telegram Bot API:** https://core.telegram.org/bots/api
- **Supabase Docs:** https://supabase.com/docs
- **Telegraf.js:** https://telegraf.js.org
