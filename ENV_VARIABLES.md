# Environment Variables Reference

Copy these into Vercel > Environment Variables

## Required Variables (11 total)

### 1. Telegram Bot
```
BOT_TOKEN = your_telegram_bot_token_here
```
Get from: [@BotFather](https://t.me/botfather) on Telegram

### 2. Seller Settings
```
SELLER_TELEGRAM_ID = your_telegram_id_number
SELLER_PHONE_NUMBER = +251912345678
SELLER_PAYMENT_INFO = Bank: XYZ, Account: 123456789
```

### 3. AI APIs
```
GROQ_API_KEY = gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY = AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Get from:
- Groq: https://console.groq.com
- Gemini: https://ai.google.dev

### 4. Supabase Database
```
SUPABASE_URL = https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.....
```

Get from: Supabase > Project Settings > API Keys

### 5. Security Tokens (generate new random ones)
```
TELEGRAM_WEBHOOK_SECRET = 550e8400-e29b-41d4-a716-446655440000
CRON_SECRET = 6ba7b810-9dad-11d1-80b4-00c04fd430c8
```

**Generate in PowerShell:**
```powershell
[guid]::NewGuid().ToString()  # Run twice for both secrets
```

### 6. Optional Settings
```
BOT_MODE = webhook
DELIVERY_FEE_OUTSIDE_ADDIS = 150
```

---

## How to Add to Vercel

1. Go to Vercel Dashboard
2. Click on your project
3. Go to **Settings > Environment Variables**
4. Click **"Add"** for each variable
5. Paste key and value
6. Click **Save**
7. Click **Redeploy** to apply changes

---

## Where to Find Each Variable

| Variable | Where to Get |
|----------|-------------|
| `BOT_TOKEN` | [@BotFather](https://t.me/botfather) → `/mybots` → Select bot → API Token |
| `SELLER_TELEGRAM_ID` | Message [@userinfobot](https://t.me/userinfobot) to get your ID |
| `SELLER_PHONE_NUMBER` | Your phone number (for customer contact) |
| `SELLER_PAYMENT_INFO` | Your bank/payment details |
| `GROQ_API_KEY` | https://console.groq.com/keys |
| `GEMINI_API_KEY` | https://ai.google.dev/tutorials/setup |
| `SUPABASE_URL` | Project > Settings > Configuration > URL |
| `SUPABASE_SERVICE_KEY` | Project > Settings > API > Service role key |
| `TELEGRAM_WEBHOOK_SECRET` | Generate random UUID |
| `CRON_SECRET` | Generate random UUID |

---

## Verification

After adding all variables, test connection:

### 1. Check Telegram Bot is Alive
```
https://api.telegram.org/botYOUR_TOKEN/getMe
```

Should return:
```json
{"ok":true,"result":{"id":123456789,"is_bot":true,"first_name":"YourBot"}}
```

### 2. Check Webhook is Set
```
https://api.telegram.org/botYOUR_TOKEN/getWebhookInfo
```

Should show your Vercel URL

### 3. Test Supabase Connection
After deployment, check Vercel logs for database errors

---

## Quick Copy-Paste Template

```
BOT_TOKEN=
SELLER_TELEGRAM_ID=
SELLER_PHONE_NUMBER=
SELLER_PAYMENT_INFO=
GROQ_API_KEY=
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
TELEGRAM_WEBHOOK_SECRET=
CRON_SECRET=
BOT_MODE=webhook
DELIVERY_FEE_OUTSIDE_ADDIS=150
```

Fill in each value, then add to Vercel one by one.
