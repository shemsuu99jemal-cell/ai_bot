# Quick Setup & Testing Guide

## Make Bot Work Fully - Local Testing (Before Deployment)

### Step 1: Complete Environment Setup

Create `.env` file in project root with **all** these variables:

```env
# REQUIRED: Telegram
BOT_TOKEN=<paste_your_bot_token_here>
BOT_MODE=polling
SELLER_TELEGRAM_ID=<your_telegram_id>
SELLER_PHONE_NUMBER=+251911223344
SELLER_PAYMENT_INFO=Bank: Commercial Bank of Ethiopia
Account Name: Your Business Name
Account Number: 1234567890

# REQUIRED: Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# REQUIRED: AI Models
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIzaSy...

# OPTIONAL: Delivery fees
DELIVERY_FEE_OUTSIDE_ADDIS=150
```

### Step 2: Verify Supabase Setup

**In Supabase Dashboard:**

1. Go to **SQL Editor**
2. Run these commands:

```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public';

-- Check products exist
SELECT COUNT(*) FROM products;

-- Check columns in orders table
SELECT column_name FROM information_schema.columns
WHERE table_name = 'orders' ORDER BY ordinal_position;
```

**Expected output:**

- Tables: `products`, `orders`, `order_items`, `conversations`
- Products count: 25+ products
- Orders columns: Should include `rejection_reason`, `customer_phone`, etc.

**If columns missing, run:**

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_location text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee numeric DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal numeric;
```

### Step 3: Verify Storage Bucket

**In Supabase Dashboard → Storage:**

1. Check bucket named `payment-screenshots` exists
2. Click bucket → **Policies tab**
3. Should allow public READ access
4. For new bucket, set policy:
   ```sql
   CREATE POLICY "Public Access"
   ON storage.objects FOR SELECT
   USING (bucket_id = 'payment-screenshots');
   ```

### Step 4: Build & Start Bot

```bash
# Clean build
rm -rf dist node_modules
npm install
npm run build

# Verify build succeeds
echo "Build status: $?"  # Should print 0

# Start bot
npm run dev
```

**Expected output:**

```
✅ Bot running in polling mode
🔄 Polling for updates...
Bot listening for messages...
```

---

## Full Testing Checklist (Local)

### A. Test Bot Startup

```bash
# In terminal where bot runs, send this from another terminal:
curl http://localhost:3000  # Should get error (not deployed to web)

# Check bot is listening:
npm run dev  # Should show "Bot running in polling mode"
```

### B. Test Customer Flow

**Open Telegram, find your bot, and test:**

1. **Start Bot**
   - Send: `/start`
   - Expected: Greeting + Main menu with buttons

2. **Browse Categories**
   - Click: 🛍️ Browse
   - Expected: List of categories (Phones, Tablets, Computers, etc.)

3. **View Products**
   - Click: Phones
   - Expected: List with products (iPhone 13, Samsung A54, etc.)

4. **View Product Details**
   - Click: iPhone 13 128GB
   - Expected:
     - Name, description, price (22000 ETB)
     - Stock count (should be 3, NOT "out of stock")
     - Available colors
     - Buttons: Add to cart, My Cart, Back

5. **Add to Cart**
   - Click: 🛒 Add to cart
   - Choose color: Black
   - Expected: "Added to cart ✅"

6. **View Cart**
   - Click: 🛒 View Cart
   - Expected: List of items with total, buttons to checkout

7. **Checkout Flow**
   - Click: ✅ Checkout
   - Enter: Your phone number (when prompted)
   - Expected: Delivery options
   - Choose: Addis Ababa
   - Expected: Payment info displayed

8. **Send Payment Screenshot**
   - Click: Upload photo
   - Send: Any image
   - Expected: "Order confirmed! We'll verify shortly."

9. **Check Order Status**
   - Send: `/orders`
   - Expected: Order shows with "🔍 Verifying payment" status

### C. Test Seller (Admin) Flow

**You are the seller - use your Telegram account:**

1. **Get Order Notification**
   - After customer sends payment screenshot
   - You should receive a photo in Telegram with:
     - Order details
     - ✅ Confirm button
     - ❌ Reject button

2. **Test Confirm**
   - Click: ✅ Confirm
   - Expected:
     - "Confirmed ✓" message
     - Customer receives: "Your order is confirmed! 🎉"

3. **Test Admin Panel**
   - Send: `/admin`
   - Expected: List of all pending orders with quick action buttons

4. **Test Rejection - Without Reason**
   - Click: ❌ Reject now
   - Expected:
     - "Rejected ✓" message
     - Seller receives: "❌ Order #12345678 rejected."
     - Customer receives: "Your payment was not approved. Please share phone..."

5. **Test Rejection - With Reason**
   - From another order, click: 📝 Add reason and reject
   - Expected: Bot asks for reason
   - Type: `Item out of stock`
   - Expected:
     - Seller receives: "❌ Order #12345678 rejected\nReason: Item out of stock"
     - Customer receives: "Your payment was not approved. Reason: Item out of stock"
     - Customer's order shows reason in `/orders`

### D. Test Language Support

1. **Switch to Amharic**
   - Send: `/language`
   - Choose: አማርኛ
   - Expected: All text becomes Amharic

2. **Type in Amharic**
   - Send: `ሰላም` (hello)
   - Expected: Bot responds in Amharic

3. **Switch back to English**
   - Send: `/language`
   - Choose: English

### E. Test Search (Natural Language)

1. **Search products**
   - Type: `i need iphone`
   - Expected: iPhone products listed

2. **Search specific**
   - Type: `show me tablets under 20000`
   - Expected: Relevant tablets shown (or handled gracefully)

3. **Ask seller**
   - Type: `do you have macbook in stock?`
   - Expected: Either shows MacBook or says "ask seller"

---

## Verification Commands

**Check everything is working:**

```bash
# 1. Check env variables are loaded
node -r dotenv/config -e "console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'SET ✓' : 'MISSING ✗')"

# 2. Check TypeScript compiles
npm run build

# 3. Check Supabase connection
node -r dotenv/config -e "
import('./dist/src/db.js').then(db => {
  db.getCategories().then(cats => console.log('DB Connected ✓', cats)).catch(e => console.log('DB Error:', e.message))
}).catch(e => console.log('Module Error:', e.message))
"

# 4. Check AI models respond (quick test)
npm run dev  # Then send a message to bot
```

---

## Common Issues & Fixes

| Issue                              | Solution                                             |
| ---------------------------------- | ---------------------------------------------------- |
| "Missing env variables"            | Add all to `.env`, run `npm run dev` again           |
| "Out of stock" showing for stock 4 | ✅ Already fixed in code, just redeploy              |
| Bot doesn't respond                | Check: `BOT_TOKEN` is correct, bot not running twice |
| "BUTTON_DATA_INVALID" errors       | Automatically fixed by payload tokenization          |
| Can't upload screenshot            | Check Supabase storage bucket is public              |
| Rejection doesn't work             | Verify `rejection_reason` column exists in DB        |
| Cron jobs not working              | Only works on Vercel, not in polling mode            |

---

## Before Deploying to Vercel

Make sure all tests pass:

```bash
# Final check
npm run build          # Should succeed
npm run dev           # Should start without errors

# In Telegram:
/start                # Works ✓
/admin                # Shows orders ✓
/language             # Switches languages ✓
Upload screenshot     # Creates order ✓
Click Reject + Reason # Shows reason ✓
```

If all above work → **Ready to deploy to Vercel!**

See `DEPLOYMENT_GUIDE.md` for step-by-step Vercel deployment.
