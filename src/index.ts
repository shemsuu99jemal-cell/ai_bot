import "dotenv/config";
import { Telegraf, Markup, Input } from "telegraf";
import sharp from "sharp";
import { handleMessage } from "./ai";
import {
  supabase,
  createOrderFromCart,
  deleteUnpaidOrder,
  attachScreenshot,
  setOrderStatus,
  getCategories,
  getProductsByCategory,
  getProduct,
  getOrder,
  getRelatedProducts,
  searchProducts,
  getCustomerOrders,
  createProduct,
  updateProduct,
  deleteProduct,
  listAllProducts,
  listRecentOrders,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  getStoreAddress,
  saveStoreAddress,
  deleteStoreAddress,
} from "./db";
import { loadSession, saveSession } from "./db";
import { runEscalationCycle, startEscalationJob } from "./cron";
import type {
  Session,
  OrderStatus,
  Product,
  PaymentMethod,
  StoreAddress,
} from "./types";

const REQUIRED_ENV = [
  "BOT_TOKEN",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SELLER_TELEGRAM_ID",
  "SELLER_PHONE_NUMBER",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const OUTSIDE_ADDIS_FEE = Number(process.env.DELIVERY_FEE_OUTSIDE_ADDIS || 150);
const BOT_MODE = (process.env.BOT_MODE || "polling").toLowerCase();

const bot = new Telegraf(process.env.BOT_TOKEN!);
const cache = new Map<number, Session>();
const pendingRejectReasonBySeller = new Map<number, string>();
// customer chatId -> orderId, set when we asked a customer (after their
// order was rejected) to share a phone number because the order didn't
// have one on file yet. Cleared once they share it (or never used).
const pendingPhoneRequestByCustomer = new Map<number, string>();

function isSeller(userId: number): boolean {
  return String(userId) === String(process.env.SELLER_TELEGRAM_ID);
}

async function answerCallbackSafely(ctx: any, text?: string): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    console.warn("Could not acknowledge Telegram callback query:", err);
  }
}

bot.use(async (ctx: any, next) => {
  const answerCallback = ctx.answerCbQuery.bind(ctx);
  ctx.answerCbQuery = (...args: any[]) =>
    answerCallback(...args).catch((err: unknown) => {
      console.warn("Could not acknowledge Telegram callback query:", err);
      return true;
    });
  await next();
});

async function getSession(chatId: number): Promise<Session> {
  if (cache.has(chatId)) return cache.get(chatId)!;
  const session = await loadSession(chatId);
  cache.set(chatId, session);
  return session;
}

async function persist(chatId: number, session: Session): Promise<void> {
  cache.set(chatId, session);
  try {
    await saveSession(chatId, session);
  } catch (err) {
    console.error(`Failed to persist session for chat ${chatId}:`, err);
  }
}

// ==========================================================================
// ---- admin: product CRUD (seller only, gated by isSeller everywhere) ----
// ==========================================================================

type AdminDraftField = "name" | "price" | "category" | "description" | "image";

interface AdminDraft {
  mode: "create" | "edit";
  productId?: string;
  step: AdminDraftField | null;
  name?: string;
  price?: number;
  category?: string | null;
  description?: string | null;
  image_url?: string | null;
}

const adminDrafts = new Map<number, AdminDraft>();
type PaymentDraft = {
  mode: "create" | "edit";
  id?: string;
  step: "name" | "account_number" | "account_name";
  name?: string;
  account_number?: string;
  account_name?: string | null;
};
const paymentDrafts = new Map<number, PaymentDraft>();
type AddressDraft = {
  mode: "create" | "edit";
  step: "address" | "description" | "image";
  address?: string;
  description?: string | null;
  image_url?: string | null;
};
const addressDrafts = new Map<number, AddressDraft>();
const PRODUCTS_PAGE_SIZE = 8;

function compactProductToken(value: string): string {
  return value.replace(/-/g, "");
}

function restoreProductId(value: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(value)) return value;
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function sellerReplyKeyboard(): any {
  return Markup.keyboard([
    ["🏠 Start", "📦 Products"],
    ["🧾 Orders", "💳 Payments"],
    ["➕ Add Product", "📘 Help"],
    ["📍 Address", "📋 Menu"],
  ])
    .resize()
    .oneTime(false);
}

async function showSellerDashboard(ctx: any): Promise<void> {
  await ctx.reply(
    "Seller Dashboard\n\nManage products, payment accounts, inventory, and orders.",
    sellerReplyKeyboard(),
  );
}

async function buildSellerHelpCard(): Promise<
  ReturnType<typeof Input.fromBuffer>
> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
      <defs>
        <linearGradient id="bg" x1="0" x2="1">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="100%" stop-color="#111827"/>
        </linearGradient>
        <marker id="arrow" markerWidth="12" markerHeight="12" refX="9" refY="6" orient="auto">
          <path d="M0 0 L12 6 L0 12 Z" fill="#f8fafc"/>
        </marker>
      </defs>
      <rect width="1200" height="800" fill="url(#bg)"/>
      <rect x="80" y="60" width="1040" height="120" rx="24" fill="#1f2937" stroke="#3b82f6" stroke-width="2"/>
      <text x="600" y="118" text-anchor="middle" fill="#f8fafc" font-size="42" font-weight="700" font-family="Arial, Helvetica, sans-serif">Seller Help</text>
      <text x="600" y="152" text-anchor="middle" fill="#cbd5e1" font-size="20" font-family="Arial, Helvetica, sans-serif">Follow this flow from left to right</text>

      <g>
        <rect x="110" y="240" width="220" height="160" rx="22" fill="#0b1220" stroke="#22c55e" stroke-width="3"/>
        <circle cx="150" cy="276" r="18" fill="#22c55e"/>
        <text x="185" y="284" fill="#f8fafc" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">1</text>
        <text x="130" y="330" fill="#f8fafc" font-size="28" font-weight="700" font-family="Arial, Helvetica, sans-serif">Add</text>
        <text x="130" y="362" fill="#cbd5e1" font-size="22" font-family="Arial, Helvetica, sans-serif">Product</text>
      </g>

      <g>
        <rect x="350" y="240" width="220" height="160" rx="22" fill="#0b1220" stroke="#f59e0b" stroke-width="3"/>
        <circle cx="390" cy="276" r="18" fill="#f59e0b"/>
        <text x="425" y="284" fill="#111827" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">2</text>
        <text x="370" y="332" fill="#f8fafc" font-size="28" font-weight="700" font-family="Arial, Helvetica, sans-serif">Edit</text>
        <text x="370" y="364" fill="#cbd5e1" font-size="22" font-family="Arial, Helvetica, sans-serif">Details</text>
      </g>

      <g>
        <rect x="590" y="240" width="220" height="160" rx="22" fill="#0b1220" stroke="#60a5fa" stroke-width="3"/>
        <circle cx="630" cy="276" r="18" fill="#60a5fa"/>
        <text x="665" y="284" fill="#0f172a" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">3</text>
        <text x="610" y="332" fill="#f8fafc" font-size="28" font-weight="700" font-family="Arial, Helvetica, sans-serif">Orders</text>
        <text x="610" y="364" fill="#cbd5e1" font-size="22" font-family="Arial, Helvetica, sans-serif">Review</text>
      </g>

      <g>
        <rect x="830" y="240" width="220" height="160" rx="22" fill="#0b1220" stroke="#f472b6" stroke-width="3"/>
        <circle cx="870" cy="276" r="18" fill="#f472b6"/>
        <text x="905" y="284" fill="#0f172a" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">4</text>
        <text x="850" y="332" fill="#f8fafc" font-size="28" font-weight="700" font-family="Arial, Helvetica, sans-serif">Payments</text>
        <text x="850" y="364" fill="#cbd5e1" font-size="22" font-family="Arial, Helvetica, sans-serif">Accounts</text>
      </g>

      <g>
        <text x="340" y="230" text-anchor="middle" fill="#94a3b8" font-size="14" font-weight="700" font-family="Arial, Helvetica, sans-serif">NEXT</text>
        <text x="580" y="230" text-anchor="middle" fill="#94a3b8" font-size="14" font-weight="700" font-family="Arial, Helvetica, sans-serif">NEXT</text>
        <text x="820" y="230" text-anchor="middle" fill="#94a3b8" font-size="14" font-weight="700" font-family="Arial, Helvetica, sans-serif">NEXT</text>
        <path d="M330 320 L350 320" stroke="#f8fafc" stroke-width="5" marker-end="url(#arrow)"/>
        <path d="M570 320 L590 320" stroke="#f8fafc" stroke-width="5" marker-end="url(#arrow)"/>
        <path d="M810 320 L830 320" stroke="#f8fafc" stroke-width="5" marker-end="url(#arrow)"/>
      </g>

      <rect x="180" y="470" width="840" height="180" rx="24" fill="#111827" stroke="#334155" stroke-width="2"/>
      <text x="210" y="520" fill="#f8fafc" font-size="26" font-weight="700" font-family="Arial, Helvetica, sans-serif">What to do next</text>
      <text x="210" y="565" fill="#cbd5e1" font-size="22" font-family="Arial, Helvetica, sans-serif">Add product → edit details → review orders → manage payments</text>
      <text x="210" y="610" fill="#94a3b8" font-size="18" font-family="Arial, Helvetica, sans-serif">Use /menu or tap the dashboard any time to go back</text>
    </svg>
  `;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return Input.fromBuffer(png, "seller-help.png");
}

async function showSellerFlowHelp(ctx: any): Promise<void> {
  const helpImage = await buildSellerHelpCard();
  const caption = [
    "🗺️ Seller Help / የሻጭ እርዳታ",
    "",
    "ENGLISH: Follow the arrows from left to right.",
    "1. Add product → 2. Edit details → 3. Review orders → 4. Manage payments",
    "",
    "አማርኛ፦ ቀስቶቹን ከግራ ወደ ቀኝ ይከተሉ።",
    "1. ምርት ይጨምሩ → 2. ያስተካክሉ → 3. ትዕዛዝ ይገምግሙ → 4. ክፍያ ያስተዳድሩ",
    "",
    "Tap the buttons below or use /menu for the dashboard.",
  ].join("\n");

  await ctx.replyWithPhoto(helpImage, {
    caption,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("📦 Products", "seller_products")],
      [Markup.button.callback("🧾 Orders", "seller_orders")],
      [Markup.button.callback("💳 Payments", "seller_payments")],
      [Markup.button.callback("🏠 Dashboard", "seller_dashboard")],
    ]).reply_markup,
  });

  const fullGuide = [
    "📚 Complete Seller Workflow / የሻጭ ሙሉ የስራ ሂደት",
    "",
    "━━━━━━━━━━━━━━━━",
    "1. OPEN THE DASHBOARD / ዳሽቦርዱን ይክፈቱ",
    "ENGLISH: Tap Dashboard or type /menu. This is your main control screen.",
    "አማርኛ፦ ዳሽቦርድን ይጫኑ ወይም /menu ይጻፉ። ይህ ዋናው የመቆጣጠሪያ ገጽ ነው።",
    "",
    "━━━━━━━━━━━━━━━━",
    "2. ADD A PRODUCT / ምርት ይጨምሩ",
    "ENGLISH:",
    "• Tap Products, then Add Product.",
    "• Enter the product name and price.",
    "• Choose a category and write a clear description.",
    "• Send a product image, or skip the image when you do not have one.",
    "• Check the final summary and save the product.",
    "አማርኛ፦",
    "• ምርቶችን ከዚያ ምርት ጨምርን ይጫኑ።",
    "• የምርቱን ስምና ዋጋ ያስገቡ።",
    "• ምድብ ይምረጡና ግልጽ መግለጫ ይጻፉ።",
    "• የምርቱን ምስል ይላኩ፤ ምስል ከሌለዎት /skip ይጻፉ።",
    "• የመጨረሻውን ማጠቃለያ ይመልከቱና ምርቱን ያስቀምጡ።",
    "",
    "━━━━━━━━━━━━━━━━",
    "3. EDIT OR DELETE A PRODUCT / ምርት ያስተካክሉ ወይም ይሰርዙ",
    "ENGLISH:",
    "• Open Products and select the product.",
    "• Choose Name, Price, Category, Description, or Image to update one detail.",
    "• Save the change and return to the product list.",
    "• To remove it, choose Delete Product and confirm.",
    "አማርኛ፦",
    "• ምርቶችን ክፍተው ምርቱን ይምረጡ።",
    "• ስም፣ ዋጋ፣ ምድብ፣ መግለጫ ወይም ምስል በመምረጥ አንዱን መረጃ ያስተካክሉ።",
    "• ለውጡን ያስቀምጡና ወደ ምርት ዝርዝር ይመለሱ።",
    "• ለመሰረዝ ምርት ሰርዝን ይምረጡና ያረጋግጡ።",
    "",
    "━━━━━━━━━━━━━━━━",
    "4. MANAGE ORDERS / ትዕዛዞችን ያስተዳድሩ",
    "ENGLISH:",
    "• Tap Orders to see the latest customer requests.",
    "• Open each order and check the customer name, phone, items, total, and status.",
    "• Confirm an order when the products are available and you can deliver.",
    "• Reject an order when you cannot fulfill it, then contact the customer if needed.",
    "• After payment is confirmed, prepare and deliver the order.",
    "አማርኛ፦",
    "• አዲስ የደንበኞችን ጥያቄ ለማየት ትዕዛዞችን ይጫኑ።",
    "• እያንዳንዱን ትዕዛዝ ክፍተው የደንበኛውን ስም፣ ስልክ፣ እቃዎች፣ ጠቅላላ ዋጋ እና ሁኔታ ያረጋግጡ።",
    "• ምርቱ ካለና ማቅረብ ከቻሉ ትዕዛዙን ያረጋግጡ።",
    "• ማቅረብ ካልቻሉ ትዕዛዙን ይከልክሉና ካስፈለገ ደንበኛውን ያነጋግሩ።",
    "• ክፍያው ከተረጋገጠ በኋላ ትዕዛዙን ያዘጋጁና ያቅርቡ።",
    "",
    "━━━━━━━━━━━━━━━━",
    "5. SET UP PAYMENTS / የክፍያ አማራጭ ያዘጋጁ",
    "ENGLISH:",
    "• Tap Payments and choose Add payment option.",
    "• Enter the payment method, account name, and account number.",
    "• Edit incorrect details or deactivate an account you no longer use.",
    "• Keep at least one active payment option so customers can pay.",
    "አማርኛ፦",
    "• ክፍያን ይጫኑና የክፍያ አማራጭ ጨምርን ይምረጡ።",
    "• የክፍያ አይነት፣ የመለያ ስምና የመለያ ቁጥር ያስገቡ።",
    "• የተሳሳተ መረጃ ያስተካክሉ ወይም የማይጠቀሙበትን መለያ ያቦዝኑ።",
    "• ደንበኞች እንዲከፍሉ ቢያንስ አንድ ንቁ የክፍያ አማራጭ ያስቀምጡ።",
    "",
    "━━━━━━━━━━━━━━━━",
    "6. DAILY ROUTINE / የዕለት ተዕለት ስራ",
    "ENGLISH: Check Products for correct prices and stock, Orders for new requests, and Payments for active account details.",
    "አማርኛ፦ በየቀኑ ዋጋና እቃ ትክክል መሆኑን በምርቶች፣ አዲስ ጥያቄ መኖሩን በትዕዛዞች፣ እና ንቁ የክፍያ መለያ መኖሩን በክፍያ ይመልከቱ።",
    "",
    "ENGLISH: Use Dashboard or /menu to return home. Use Help whenever you need this guide again.",
    "አማርኛ፦ ወደ መነሻ ለመመለስ ዳሽቦርድን ወይም /menu ይጠቀሙ። ይህን መመሪያ እንደገና ለማየት እርዳታን ይጫኑ።",
  ].join("\n");
  const guideKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📘 Choose another help / ሌላ እርዳታ", "seller_help")],
    [Markup.button.callback("🏠 Dashboard / ዳሽቦርድ", "seller_dashboard")],
  ]);
  let remaining = fullGuide;
  while (remaining.length > 3900) {
    const breakAt = remaining.lastIndexOf("\n", 3900);
    await ctx.reply(remaining.slice(0, breakAt > 0 ? breakAt : 3900));
    remaining = remaining.slice(breakAt > 0 ? breakAt + 1 : 3900);
  }
  await ctx.reply(remaining, guideKeyboard);
}

async function showSellerHelp(ctx: any): Promise<void> {
  await ctx.reply(
    [
      "📘 Seller Help / የሻጭ እርዳታ",
      "",
      "What do you need help with? Select one topic below.",
      "በምን ነገር እርዳታ ያስፈልግዎታል? ከታች አንዱን ይምረጡ።",
    ].join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("📦 Products / ምርቶች", "seller_help_products")],
      [Markup.button.callback("🧾 Orders / ትዕዛዞች", "seller_help_orders")],
      [Markup.button.callback("💳 Payments / ክፍያ", "seller_help_payments")],
      [Markup.button.callback("🗺️ Full Flow / ሙሉ ሂደት", "seller_help_flow")],
      [Markup.button.callback("🏠 Dashboard / ዳሽቦርድ", "seller_dashboard")],
    ]),
  );
}

async function showSellerHelpTopic(
  ctx: any,
  topic: "products" | "orders" | "payments",
): Promise<void> {
  const guides = {
    products: [
      "📦 Products / ምርቶች",
      "",
      "ENGLISH",
      "1. Tap Products.",
      "2. Tap Add Product and enter the name, price, category, description, and image.",
      "3. Tap a product to edit its details or delete it.",
      "4. Check the product list to confirm the changes.",
      "",
      "አማርኛ",
      "1. የምርቶች ቁልፍን ይጫኑ።",
      "2. ምርት ጨምርን ይጫኑ፤ ስም፣ ዋጋ፣ ምድብ፣ መግለጫ እና ምስል ያስገቡ።",
      "3. ለማስተካከል ወይም ለመሰረዝ ምርቱን ይምረጡ።",
      "4. ለውጡ መቀመጡን በምርት ዝርዝሩ ያረጋግጡ።",
    ],
    orders: [
      "🧾 Orders / ትዕዛዞች",
      "",
      "ENGLISH",
      "1. Tap Orders to see recent customer orders.",
      "2. Open an order and check the customer, items, total, and contact details.",
      "3. Confirm the order when you can fulfill it, or reject it when necessary.",
      "4. Contact the customer and deliver after payment is confirmed.",
      "",
      "አማርኛ",
      "1. የቅርብ ጊዜ የደንበኞችን ትዕዛዝ ለማየት ትዕዛዞችን ይጫኑ።",
      "2. ትዕዛዙን ከፍተው ደንበኛውን፣ እቃዎችን፣ ጠቅላላ ዋጋን እና ስልክ ያረጋግጡ።",
      "3. ማቅረብ ከቻሉ ትዕዛዙን ያረጋግጡ፤ ካልቻሉ ይከልክሉ።",
      "4. ክፍያው ከተረጋገጠ በኋላ ደንበኛውን ያነጋግሩና እቃውን ያቅርቡ።",
    ],
    payments: [
      "💳 Payments / ክፍያ",
      "",
      "ENGLISH",
      "1. Tap Payments.",
      "2. Add a payment account with the correct name and account number.",
      "3. Edit or deactivate an old account when details change.",
      "4. Keep at least one active payment option for customers.",
      "",
      "አማርኛ",
      "1. የክፍያ ቁልፍን ይጫኑ።",
      "2. ትክክለኛ የመለያ ስምና ቁጥር ያለው የክፍያ መለያ ይጨምሩ።",
      "3. መረጃው ከተቀየረ የቆየውን መለያ ያስተካክሉ ወይም ያቦዝኑ።",
      "4. ለደንበኞች ቢያንስ አንድ ንቁ የክፍያ አማራጭ ያስቀምጡ።",
    ],
  };

  await ctx.reply(
    guides[topic].join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "📘 Choose another help / ሌላ እርዳታ",
          "seller_help",
        ),
      ],
      [Markup.button.callback("🏠 Dashboard / ዳሽቦርድ", "seller_dashboard")],
    ]),
  );
}

async function showPaymentMethods(ctx: any): Promise<void> {
  const methods = await listPaymentMethods(true);
  const rows = methods.flatMap((method) => [
    [
      Markup.button.callback(
        `✅ ${method.name} — ${method.account_number}`,
        `payment_edit_${method.id}`,
      ),
    ],
    [Markup.button.callback("🗑 Remove", `payment_delete_${method.id}`)],
  ]);
  rows.push([Markup.button.callback("➕ Add payment option", "payment_add")]);
  rows.push([Markup.button.callback("⬅️ Dashboard", "seller_dashboard")]);
  await ctx.reply(
    methods.length
      ? "💳 Payment options"
      : "No payment options configured yet.",
    Markup.inlineKeyboard(rows),
  );
}

async function showStoreAddress(ctx: any, session?: Session): Promise<void> {
  const address = await getStoreAddress();
  if (!address) {
    if (session) {
      return ctx.reply(
        t(
          session,
          "The store address has not been added yet.",
          "የሱቁ አድራሻ እስካሁን አልተጨመረም።",
        ),
        mainMenuKeyboard(session),
      );
    }
    return ctx.reply(
      "No store address configured.",
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Address", "address_add")],
        [Markup.button.callback("⬅️ Dashboard", "seller_dashboard")],
      ]),
    );
  }
  const caption = [
    "📍 STORE LOCATION",
    "",
    `📌 ${address.address}`,
    address.description ? `📝 ${address.description}` : "",
    "",
    "We look forward to seeing you!",
  ]
    .filter(Boolean)
    .join("\n");
  if (address.image_url) {
    await ctx.replyWithPhoto(address.image_url, { caption });
  } else {
    await ctx.reply(caption);
  }
  if (!session) {
    await ctx.reply(
      "Manage store location",
      Markup.inlineKeyboard([
        [Markup.button.callback("✏️ Edit Address", "address_edit")],
        [Markup.button.callback("🗑 Remove Address", "address_delete")],
      ]),
    );
  }
}

async function beginAddressDraft(ctx: any): Promise<void> {
  adminDrafts.delete(ctx.chat.id);
  paymentDrafts.delete(ctx.chat.id);
  addressDrafts.set(ctx.chat.id, { mode: "create", step: "address" });
  await ctx.reply("Send the store address:", sellerReplyKeyboard());
}

async function beginAddressEdit(ctx: any): Promise<void> {
  adminDrafts.delete(ctx.chat.id);
  paymentDrafts.delete(ctx.chat.id);
  addressDrafts.delete(ctx.chat.id);
  await ctx.reply(
    "What do you want to update?",
    Markup.inlineKeyboard([
      [Markup.button.callback("📍 Address", "address_field_address")],
      [Markup.button.callback("📝 Description", "address_field_description")],
      [Markup.button.callback("🖼 Place Image", "address_field_image")],
      [Markup.button.callback("⬅️ Cancel", "seller_address")],
    ]),
  );
}

function paymentMethodText(method: PaymentMethod): string {
  return `${method.name}\nAccount: ${method.account_number}\nName: ${method.account_name || "—"}\nStatus: ${method.is_active ? "Active" : "Inactive"}`;
}

async function showAdminProductList(ctx: any, page = 1): Promise<void> {
  const { products, total } = await listAllProducts(page, PRODUCTS_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE));

  if (products.length === 0) {
    return ctx.reply(
      "No products yet. Tap below to add your first one.",
      sellerReplyKeyboard(),
    );
  }

  const rows = products.map((p) => [
    Markup.button.callback(
      `${p.name} — ${p.price} ETB`,
      `admin_edit_${compactProductToken(p.id)}`,
    ),
  ]);

  const navRow: any[] = [];
  if (page > 1)
    navRow.push(Markup.button.callback("⬅️ Prev", `admin_page_${page - 1}`));
  navRow.push(Markup.button.callback(`${page}/${totalPages}`, "noop"));
  if (page < totalPages)
    navRow.push(Markup.button.callback("Next ➡️", `admin_page_${page + 1}`));
  if (navRow.length) rows.push(navRow);

  rows.push([
    Markup.button.callback("➕ Add Product", "admin_add"),
    Markup.button.callback("⬅️ Dashboard", "seller_dashboard"),
  ]);

  await ctx.reply(
    `📦 Products (${total} total) — tap one to manage it`,
    Markup.inlineKeyboard(rows),
  );
}

async function showSellerOrders(ctx: any): Promise<void> {
  const orders = await listRecentOrders(10);

  if (orders.length === 0) {
    return ctx.reply("No orders yet.", sellerReplyKeyboard());
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const groups = new Map<string, string[]>();
  for (const order of orders) {
    const createdAt = order.created_at ? new Date(order.created_at) : null;
    const group =
      createdAt && createdAt >= startOfToday
        ? "Today"
        : createdAt && createdAt >= startOfYesterday
          ? "Yesterday"
          : "Older orders";
    const created = createdAt
      ? createdAt.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "Date unavailable";
    const details = [
      `#${String(order.id).slice(0, 8)} — ${order.customer_name || "Customer"}`,
      `📞 ${order.customer_phone || "Phone not shared"}`,
      `💰 ${order.total} ETB • ${order.status}`,
      `📍 ${order.delivery_location || "Addis Ababa"} • ${created}`,
    ].join("\n");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(details);
  }

  const sections = Array.from(groups.entries()).map(
    ([header, groupOrders]) => `📅 ${header}\n\n${groupOrders.join("\n\n")}`,
  );

  await ctx.reply(
    "🧾 Recent Orders\n\n" + sections.join("\n\n"),
    sellerReplyKeyboard(),
  );
}

function normalizeSellerActionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\uFE0F/g, "")
    .replace(/[^a-z0-9\s+]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function handleSellerKeyboardText(
  ctx: any,
  text: string,
): Promise<boolean> {
  const value = normalizeSellerActionText(text);
  if (!value) return false;

  const actions: Record<string, () => Promise<void>> = {
    start: () => showSellerDashboard(ctx),
    menu: () => showSellerDashboard(ctx),
    products: () => showAdminProductList(ctx, 1),
    orders: () => showSellerOrders(ctx),
    payments: () => showPaymentMethods(ctx),
    help: () => showSellerHelp(ctx),
    address: () => showStoreAddress(ctx),
    "add address": () => beginAddressDraft(ctx),
    "add product": async () => {
      paymentDrafts.delete(ctx.chat.id);
      addressDrafts.delete(ctx.chat.id);
      adminDrafts.set(ctx.chat.id, { mode: "create", step: "name" });
      await ctx.reply(
        "Let's add a new product. What's the product name?",
        sellerReplyKeyboard(),
      );
    },
  };

  const handler = actions[value];
  if (!handler) return false;
  await handler();
  return true;
}

function truncateText(
  value: string | null | undefined,
  maxLength = 120,
): string {
  const clean = (value || "").replace(/\s+/g, " ").trim();
  if (!clean) return "—";
  return clean.length > maxLength
    ? `${clean.slice(0, maxLength - 1).trim()}…`
    : clean;
}

function adminEditMenuText(draft: AdminDraft): string {
  return (
    `${draft.name}\n\n` +
    `💰 ${draft.price} ETB\n` +
    `🏷 Category: ${draft.category || "—"}\n` +
    `📝 Description: ${truncateText(draft.description, 120)}\n` +
    `🖼 Image: ${draft.image_url ? "Attached" : "—"}`
  );
}

function adminEditMenuKeyboard(productId: string): any {
  const safeId = compactProductToken(productId);
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Name", `admin_field_name_${safeId}`)],
    [
      Markup.button.callback("💰 Price", `admin_field_price_${safeId}`),
      Markup.button.callback("🏷 Category", `admin_field_category_${safeId}`),
      Markup.button.callback(
        "📝 Description",
        `admin_field_description_${safeId}`,
      ),
      Markup.button.callback("🖼 Image", `admin_field_image_${safeId}`),
    ],
    [Markup.button.callback("🗑 Delete Product", `admin_delete_${safeId}`)],
    [Markup.button.callback("✅ Done", "admin_done")],
  ]);
}

async function finalizeNewProduct(ctx: any, draft: AdminDraft): Promise<void> {
  const chatId = ctx.chat.id;
  try {
    const product = await createProduct({
      name: draft.name!,
      description: draft.description || null,
      price: draft.price!,
      category: draft.category || "General",
      image_url: draft.image_url,
    });
    adminDrafts.delete(chatId);
    await ctx.reply(
      `✅ Added "${product.name}"`,
      adminEditMenuKeyboard(product.id),
    );
  } catch (err) {
    console.error("Failed to create product:", err);
    await ctx.reply(
      "Something went wrong creating that product — please try /addproduct again.",
    );
    adminDrafts.delete(chatId);
  }
}

function refreshDraftFromProduct(product: Product): AdminDraft {
  return {
    mode: "edit",
    productId: product.id,
    step: null,
    name: product.name,
    price: product.price,
    category: product.category || null,
    description: product.description || null,
    image_url: product.image_url || null,
  };
}

async function handlePaymentDraftText(
  ctx: any,
  draft: PaymentDraft,
  text: string,
): Promise<void> {
  const value = text.trim();
  if (draft.step === "name") {
    if (!value) return ctx.reply("Payment name is required. Please enter it.");
    draft.name = value;
    draft.step = "account_number";
    paymentDrafts.set(ctx.chat.id, draft);
    return ctx.reply("Give me the account number:");
  }
  if (draft.step === "account_number") {
    if (!value)
      return ctx.reply("Account number is required. Please enter it.");
    draft.account_number = value;
    draft.step = "account_name";
    paymentDrafts.set(ctx.chat.id, draft);
    return ctx.reply("Give me the account holder name:");
  }

  if (!value)
    return ctx.reply("Account holder name is required. Please enter it.");
  draft.account_name = value;
  try {
    if (draft.mode === "create") {
      await createPaymentMethod({
        name: draft.name!,
        account_number: draft.account_number!,
        account_name: draft.account_name || null,
      });
    } else {
      await updatePaymentMethod(draft.id!, {
        name: draft.name!,
        account_number: draft.account_number!,
        account_name: draft.account_name || null,
      });
    }
    paymentDrafts.delete(ctx.chat.id);
    await ctx.reply("Payment option saved ✅", Markup.removeKeyboard());
    await showPaymentMethods(ctx);
  } catch (err) {
    console.error("Failed to save payment option:", err);
    await ctx.reply("Could not save that payment option.");
  }
}

async function handleAdminDraftText(
  ctx: any,
  draft: AdminDraft,
  text: string,
): Promise<void> {
  const chatId = ctx.chat.id;
  const skip = text.toLowerCase() === "/skip";

  if (draft.mode === "create") {
    switch (draft.step) {
      case "name":
        if (!text || skip)
          return ctx.reply("Please send a product name (required).");
        draft.name = text;
        draft.step = "price";
        adminDrafts.set(chatId, draft);
        return ctx.reply("Price in ETB? (numbers only)");
      case "price": {
        const price = Number(text.replace(/[^\d.]/g, ""));
        if (!price || Number.isNaN(price))
          return ctx.reply("Please send a valid price, e.g. 15000");
        draft.price = price;
        draft.step = "category";
        adminDrafts.set(chatId, draft);
        return ctx.reply(
          "Category? Send one short name, for example protein or vitamins.",
        );
      }
      case "category": {
        const category = text.trim().toLowerCase().replace(/\s+/g, " ");
        if (!category || skip)
          return ctx.reply("Please send a category, for example protein.");
        draft.category = category;
        draft.step = "description";
        adminDrafts.set(chatId, draft);
        return ctx.reply(
          "Write a short product description, or /skip to leave it blank.",
        );
      }
      case "description": {
        draft.description = skip ? null : text.trim();
        draft.step = "image";
        adminDrafts.set(chatId, draft);
        return ctx.reply("Send the product image as a photo, or /skip.");
      }
      case "image":
        if (skip) {
          await finalizeNewProduct(ctx, draft);
          return;
        }
        return ctx.reply("Please send the product image as a photo, or /skip.");
    }
    return;
  }

  // edit mode — one field at a time, saved immediately
  if (draft.mode === "edit" && draft.productId) {
    const updates: Record<string, any> = {};
    switch (draft.step) {
      case "name":
        if (!text || skip) return ctx.reply("Name can't be empty.");
        updates.name = text;
        break;
      case "price": {
        const price = Number(text.replace(/[^\d.]/g, ""));
        if (!price || Number.isNaN(price))
          return ctx.reply("Please send a valid price.");
        updates.price = price;
        break;
      }
      case "category":
        updates.category = skip
          ? null
          : text.trim().toLowerCase().replace(/\s+/g, " ");
        break;
      case "description":
        updates.description = skip ? null : text.trim();
        break;
      case "image":
        return ctx.reply("Please send the new product image as a photo.");
      default:
        return;
    }

    try {
      const updated = await updateProduct(draft.productId, updates);
      const refreshed = refreshDraftFromProduct(updated);
      adminDrafts.set(chatId, refreshed);
      await ctx.reply("Updated ✅");
      await ctx.reply(
        adminEditMenuText(refreshed),
        adminEditMenuKeyboard(updated.id),
      );
    } catch (err) {
      console.error("Failed to update product:", err);
      await ctx.reply("Something went wrong saving that change.");
    }
  }
}

// ==========================================================================

function t(session: Session, en: string, am: string): string {
  return session.language === "am" ? am : en;
}

function mainMenuKeyboard(session: Session): any {
  return Markup.keyboard([
    [t(session, "🛍️ Browse", "🛍️ ካታሎግ"), t(session, "🛒 My Cart", "🛒 ጋሪዬ")],
    [
      t(session, "📦 My Orders", "📦 ትዕዛዜቼ"),
      t(session, "📍 Store Address", "📍 የሱቅ አድራሻ"),
    ],
    [t(session, "🏠 Start", "🏠 መነሻ"), t(session, "🌐 Language", "🌐 ቋንቋ")],
  ])
    .resize()
    .oneTime(false);
}

async function sendMainMenu(
  ctx: any,
  session: Session,
  message?: string,
): Promise<void> {
  await ctx.reply(
    message ||
      t(
        session,
        "Welcome to pixelSupplements! Choose a category to get started.",
        "ወደ pixelSupplements እንኳን ደህና መጡ! ለመጀመር ምድብ ይምረጡ።",
      ),
    mainMenuKeyboard(session),
  );
}

async function sendWelcomeAndBrowse(ctx: any, session: Session): Promise<void> {
  await sendMainMenu(
    ctx,
    session,
    t(
      session,
      "Welcome to Afrosupplements 😊 What can I help you with today?",
      "እንኳን ወደ Afrosupplements በደህና መጡ 😊 ዛሬ እንዴት ልርዳዎት?",
    ),
  );
  await showCategoryMenu(ctx, session);
}

async function showCartText(ctx: any, session: Session): Promise<void> {
  if (session.cart.length === 0) {
    return ctx.reply(
      t(session, "Your cart is empty.", "ጋሪዎ ባዶ ነው።"),
      mainMenuKeyboard(session),
    );
  }

  const total = session.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const lines = session.cart.map(
    (i) =>
      `${i.name}${i.color ? ` (${i.color})` : ""} x${i.quantity} = ${i.price * i.quantity} ETB`,
  );

  await ctx.reply(
    `${lines.join("\n")}\n\n${t(session, "Total", "ጠቅላላ")}: ${total} ETB`,
    Markup.inlineKeyboard([
      [Markup.button.callback(t(session, "💳 Pay", "💳 ይክፈሉ"), "do_checkout")],
      [
        Markup.button.callback(
          t(session, "🗑️ Clear Cart", "🗑️ ጋሪ ያፅዱ"),
          "clear_cart",
        ),
      ],
      [
        Markup.button.callback(
          t(session, "🔙 Continue shopping", "🔙 ማስሻሻ ይቀጥል"),
          "back_categories",
        ),
      ],
    ]),
  );
}

async function showCustomerOrders(ctx: any, session: Session): Promise<void> {
  try {
    const orders = await getCustomerOrders(ctx.chat.id, 10);
    if (orders.length === 0) {
      return ctx.reply(
        t(session, "You don't have any orders yet.", "እስካሁን ምንም ትዕዛዝ የለዎትም።"),
        mainMenuKeyboard(session),
      );
    }

    const lines = orders.map((o) => {
      const date = o.created_at
        ? new Date(o.created_at).toLocaleDateString()
        : "";
      return `#${o.id.slice(0, 8)} — ${o.total} ETB — ${statusLabel(session, o.status)} (${date})`;
    });

    const actionRows = orders
      .filter((order) => order.status === "awaiting_payment")
      .map((order) => [
        Markup.button.callback(
          `💳 Pay #${order.id.slice(0, 8)}`,
          `order_pay_${order.id}`,
        ),
        Markup.button.callback(
          `❌ Cancel #${order.id.slice(0, 8)}`,
          `order_cancel_${order.id}`,
        ),
      ]);

    await ctx.reply(
      lines.join("\n\n"),
      actionRows.length
        ? Markup.inlineKeyboard(actionRows)
        : mainMenuKeyboard(session),
    );
  } catch (err) {
    console.error(`Failed to fetch orders for chat ${ctx.chat.id}:`, err);
    await ctx.reply(friendlyErrorText(session), mainMenuKeyboard(session));
  }
}

bot.action(/^order_pay_([0-9a-f-]+)$/i, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const order = await getOrder(ctx.match[1]).catch(() => null);
  if (!order || order.customer_telegram_id !== chatId) {
    return ctx.reply(t(session, "That order was not found.", "ያ ትዕዛዝ አልተገኘም።"));
  }
  if (order.status !== "awaiting_payment") {
    return ctx.reply(
      t(
        session,
        "This order is no longer awaiting payment.",
        "ይህ ትዕዛዝ ከእንግዲህ ክፍያ አይጠብቅም።",
      ),
    );
  }

  session.pendingOrderId = order.id;
  await persist(chatId, session);
  const paymentInfo = order.payment_method_name
    ? `${order.payment_method_name}\nAccount: ${order.payment_account_number}${order.payment_account_name ? `\nAccount name: ${order.payment_account_name}` : ""}`
    : "Please contact the seller for the current payment account.";
  await ctx.reply(
    t(
      session,
      `Order #${order.id.slice(0, 8)} — Total: ${order.total} ETB\n\nPlease pay using:\n${paymentInfo}\n\nThen send your payment screenshot here. It will be sent to the admin for verification.`,
      `ትዕዛዝ #${order.id.slice(0, 8)} — ጠቅላላ፦ ${order.total} ብር\n\nክፍያ ይፈጽሙ፦\n${paymentInfo}\n\nከዚያ የክፍያ ስክሪንሾትዎን እዚህ ይላኩ። ለአስተዳዳሪ ማረጋገጫ ይላካል።`,
    ),
  );
});

bot.action(/^order_cancel_([0-9a-f-]+)$/i, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const order = await getOrder(ctx.match[1]).catch(() => null);
  if (!order || order.customer_telegram_id !== chatId) {
    return ctx.reply(t(session, "That order was not found.", "ያ ትዕዛዝ አልተገኘም።"));
  }
  if (order.status !== "awaiting_payment") {
    return ctx.reply(
      t(
        session,
        "This order can no longer be canceled.",
        "ይህ ትዕዛዝ ከእንግዲህ ሊሰረዝ አይችልም።",
      ),
    );
  }

  try {
    await deleteUnpaidOrder(order.id);
    if (session.pendingOrderId === order.id) session.pendingOrderId = null;
    await persist(chatId, session);
    await ctx.reply(
      t(session, "Order canceled and removed.", "ትዕዛዙ ተሰርዞ ከሰንጠረዥ ተወግዷል።"),
    );
    await showCustomerOrders(ctx, session);
  } catch (err) {
    console.error(`Failed to cancel order ${order.id}:`, err);
    await ctx.reply(friendlyErrorText(session));
  }
});

async function showLanguagePicker(ctx: any, session: Session): Promise<void> {
  await ctx.reply(
    "Choose language / ቋንቋ ይምረጡ:",
    Markup.inlineKeyboard([
      Markup.button.callback("English", "lang_en"),
      Markup.button.callback("አማርኛ", "lang_am"),
    ]),
  );
}

async function handleQuickAction(
  ctx: any,
  session: Session,
  text: string,
): Promise<boolean> {
  const value = text.trim().toLowerCase();
  const menuLabels = [
    "browse",
    "browse products",
    "catalog",
    "categories",
    "menu",
    "🛍️ browse",
    "🛍️ ካታሎግ",
    "ካታሎግ",
  ];
  const cartLabels = [
    "my cart",
    "🛒 my cart",
    "🛒 ጋሪዬ",
    "ጋሪዬ",
    "show my cart",
    "show cart",
    "view cart",
    "check my cart",
    "what about my cart",
    "what about the cart",
    "cart please",
  ];
  const orderLabels = [
    "my orders",
    "📦 my orders",
    "📦 ትዕዛዜቼ",
    "orders",
    "ትዕዛዜቼ",
    "where is my order",
    "check my order",
    "order status",
    "track my order",
  ];
  const sellerLabels = [
    "ask seller",
    "💬 ask seller",
    "💬 ሻጭ ይጠይቁ",
    "ask the seller",
    "seller",
    "ሻጭ",
  ];
  const addressLabels = [
    "store address",
    "📍 store address",
    "📍 የሱቅ አድራሻ",
    "የሱቅ አድራሻ",
  ];
  const languageLabels = [
    "language",
    "change language",
    "🌐 language",
    "🌐 ቋንቋ",
    "ቋንቋ",
  ];
  const homeLabels = ["start", "home", "🏠 start", "🏠 መነሻ", "መነሻ"];
  const greetingLabels = [
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "hey there",
    "hello there",
    "how are you",
    "how are you doing",
    "what's up",
    "whats up",
    "what bout my cart",
    "what about my cart",
    "thanks",
    "thank you",
    "help",
    "can you help",
    "yo",
  ];

  if (greetingLabels.includes(value)) {
    await ctx.reply(
      t(
        session,
        "Hi! I’m here to help with shopping, your cart, or orders. 😊",
        "ሰላም! በግብይት፣ ጋሪዎ ወይም ትዕዛዜዎ ላይ እርዳዎታለሁ 😊",
      ),
      mainMenuKeyboard(session),
    );
    return true;
  }

  if (menuLabels.includes(value)) {
    await showCategoryMenu(ctx, session);
    return true;
  }
  if (cartLabels.includes(value)) {
    await showCartText(ctx, session);
    return true;
  }
  if (orderLabels.includes(value)) {
    await showCustomerOrders(ctx, session);
    return true;
  }
  if (addressLabels.includes(value)) {
    await showStoreAddress(ctx, session);
    return true;
  }
  if (sellerLabels.includes(value)) {
    await ctx.reply(
      t(
        session,
        "Send your question and I’ll forward it to the seller.",
        "ጥያቄዎን ይላኩ እኔ ለሻጭ እልካለሁ።",
      ),
      mainMenuKeyboard(session),
    );
    return true;
  }
  if (languageLabels.includes(value)) {
    await showLanguagePicker(ctx, session);
    return true;
  }
  if (homeLabels.includes(value)) {
    await sendWelcomeAndBrowse(ctx, session);
    return true;
  }

  return false;
}

const ORDER_STATUS_RE_EN =
  /(?:where(?:'s| is)?\s+(?:my|the)?\s*order|check\s+(?:my\s+)?order|order\s+status|track\s+my\s+order|status\s+of\s+my\s+order|what'?s\s+the\s+status\s+of\s+my\s+order|where\s+is\s+my\s+order|my\s+orders?)/i;
const ORDER_STATUS_RE_AM =
  /(የእኔ\s*ትዕዛዝ|ትዕዛዜ\s*የት\s*ነው|ትዕዛዝ\s*እንዴት\s*ነው|የእኔ\s*እዚህ\s*ነው|እቅዴ\s*እንዴት\s*ነው|ስለ\s*ትዕዛዜ|ትዕዛዜ\s*አለ)/i;

function isOrderStatusIntent(text: string): boolean {
  const value = text.trim();
  return ORDER_STATUS_RE_EN.test(value) || ORDER_STATUS_RE_AM.test(value);
}

function friendlyErrorText(session: Session): string {
  return t(
    session,
    "Sorry, something went wrong on our end 🙏 Please try again in a moment.",
    "ይቅርታ፣ የሆነ ችግር ተከስቷል 🙏 እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።",
  );
}

function statusLabel(session: Session, status: OrderStatus): string {
  const map: Record<OrderStatus, [string, string, string]> = {
    awaiting_payment: ["⏳", "Awaiting payment", "ክፍያ በመጠበቅ ላይ"],
    pending_verification: ["🔍", "Verifying payment", "ክፍያ በማረጋገጥ ላይ"],
    confirmed: ["✅", "Confirmed", "ተረጋግጧል"],
    rejected: ["❌", "Rejected", "ውድቅ ተደርጓል"],
  };
  const [emoji, en, am] = map[status];
  return `${emoji} ${t(session, en, am)}`;
}

// ---- category / product browsing ----

async function resolveProductImage(
  ctx: any,
  product: Product,
): Promise<any | null> {
  if (!product.image_url) return null;
  if (/^https?:\/\//i.test(product.image_url)) return product.image_url;

  // Legacy Telegram file IDs are not durable product image storage. New
  // uploads are saved as public Supabase URLs below, so skip old IDs instead
  // of calling Telegram on every catalog view and logging a 400 error.
  return null;
}

let productImageBucketReady: Promise<void> | null = null;

async function uploadProductImage(
  ctx: any,
  fileId: string,
  objectName: string,
): Promise<string> {
  if (!productImageBucketReady) {
    productImageBucketReady = (async () => {
      const { error } = await supabase.storage.createBucket("product-images", {
        public: true,
      });
      if (error && !/already exists/i.test(error.message)) throw error;
    })();
  }
  await productImageBucketReady;

  const fileLink = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  if (!response.ok)
    throw new Error(`Product image download failed: ${response.status}`);

  const { error } = await supabase.storage
    .from("product-images")
    .upload(objectName, Buffer.from(await response.arrayBuffer()), {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (error) throw error;

  return supabase.storage.from("product-images").getPublicUrl(objectName).data
    .publicUrl;
}

function storagePathFromPublicUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const marker = "/storage/v1/object/public/product-images/";
  const index = url.indexOf(marker);
  return index >= 0
    ? decodeURIComponent(url.slice(index + marker.length))
    : null;
}

async function showCategoryMenu(ctx: any, session: Session): Promise<void> {
  const categories = await getCategories();
  if (categories.length === 0) {
    return ctx.reply(
      t(
        session,
        "Nothing in the catalog yet — check back soon!",
        "እስካሁን ካታሎግ ውስጥ ምንም የለም — በቅርቡ ይመልከቱ!",
      ),
    );
  }
  const buttons = categories.map((c, i) =>
    Markup.button.callback(c, `cat_${i}_1`),
  );
  const rows: any[] = [];
  for (let i = 0; i < buttons.length; i += 2)
    rows.push(buttons.slice(i, i + 2));

  await ctx.reply(
    t(session, "What are you looking for? 🛍️", "ምን ይፈልጋሉ? 🛍️"),
    Markup.inlineKeyboard(rows),
  );
}

bot.command("menu", async (ctx) => {
  if (isSeller(ctx.from.id)) {
    await showSellerDashboard(ctx);
    return;
  }

  const session = await getSession(ctx.chat.id);
  await sendMainMenu(ctx, session, t(session, "Shop menu", "የሱቅ ሜኑ"));
});

bot.command("start", async (ctx) => {
  if (isSeller(ctx.from.id)) {
    await showSellerDashboard(ctx);
    return;
  }

  const session = await getSession(ctx.chat.id);
  await sendWelcomeAndBrowse(ctx, session);
});

bot.command("cart", async (ctx) => {
  const session = await getSession(ctx.chat.id);
  await ctx.answerCbQuery?.().catch(() => undefined);
  return ctx.reply(
    session.cart.length === 0
      ? t(session, "Your cart is empty.", "ጋሪዎ ባዶ ነው።")
      : `${session.cart
          .map(
            (i) =>
              `${i.name}${i.color ? ` (${i.color})` : ""} x${i.quantity} = ${i.price * i.quantity} ETB`,
          )
          .join(
            "\n",
          )}\n\n${t(session, "Total", "ጠቅላላ")}: ${session.cart.reduce((s, i) => s + i.price * i.quantity, 0)} ETB`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          t(session, "🛍️ Continue shopping", "🛍️ ማስሻሻ ይቀጥል"),
          "back_categories",
        ),
      ],
      [Markup.button.callback(t(session, "💳 Pay", "💳 ይክፈሉ"), "do_checkout")],
    ]),
  );
});

// ---- admin: product CRUD commands (seller only) ----

bot.command("admin", async (ctx) => {
  if (!isSeller(ctx.from.id)) return;
  await showAdminProductList(ctx, 1);
});

bot.command("help", async (ctx) => {
  if (!isSeller(ctx.from.id)) return;
  await showSellerHelp(ctx);
});

bot.action("seller_help", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerHelp(ctx);
});

bot.action("seller_help_products", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerHelpTopic(ctx, "products");
});

bot.action("seller_help_orders", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerHelpTopic(ctx, "orders");
});

bot.action("seller_help_payments", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerHelpTopic(ctx, "payments");
});

bot.action("seller_help_flow", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerFlowHelp(ctx);
});

bot.command("addproduct", async (ctx) => {
  if (!isSeller(ctx.from.id)) return;
  paymentDrafts.delete(ctx.chat.id);
  addressDrafts.delete(ctx.chat.id);
  adminDrafts.set(ctx.chat.id, { mode: "create", step: "name" });
  await ctx.reply("Let's add a new product. What's the product name?");
});

function productSummaryText(product: Product): string {
  const description = (product.description || "").replace(/\s+/g, " ").trim();
  const lines = [`${product.name}`];
  if (description)
    lines.push(
      `\n📝 ${description.length > 120 ? `${description.slice(0, 119).trim()}…` : description}`,
    );
  lines.push(`🏷 ${product.category || "General"}`);
  lines.push(`💰 ${product.price} ETB`);
  return lines.join("\n");
}

async function showProductResults(
  ctx: any,
  session: Session,
  query: string,
  title?: string,
): Promise<void> {
  const products = await searchProducts(query);
  if (products.length === 0) {
    return ctx.reply(
      t(
        session,
        `I couldn't find anything matching “${query}”. Try a model name or browse categories.`,
        `ለ “${query}” የሚመሳሰል ምርት አልተገኘም። ሞዴል ይሞክሩ ወይም ምድቦችን ይዘርዝሩ።`,
      ),
    );
  }

  if (title) await ctx.reply(title);
  for (const product of products) {
    const imageUrl = await resolveProductImage(ctx, product);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `View ${product.name} — ${product.price} ETB`,
          `prod_${compactProductToken(product.id)}`,
        ),
      ],
    ]);
    const caption = productSummaryText(product);
    if (imageUrl) {
      await ctx.replyWithPhoto(imageUrl, {
        caption,
        ...keyboard,
      });
    } else {
      await ctx.reply(caption, keyboard);
    }
  }
  const rows: any[] = [];
  rows.push([
    Markup.button.callback(
      t(session, "🔙 Categories", "🔙 ምድቦች"),
      "back_categories",
    ),
  ]);

  await ctx.reply(
    title
      ? t(session, "More options", "ተጨማሪ አማራጮች")
      : t(session, `Results for “${query}” 🔎`, `ለ “${query}” ውጤቶች 🔎`),
    Markup.inlineKeyboard(rows),
  );
}

async function showProductDetail(
  ctx: any,
  session: Session,
  productId: string,
): Promise<void> {
  const product = await getProduct(productId).catch(() => null);
  if (!product) {
    return ctx.reply(
      t(
        session,
        "Sorry, that's out of stock right now.",
        "ይቅርታ፣ አሁን ክምችት የለውም።",
      ),
    );
  }

  const buttons: any[] = [
    [Markup.button.callback(t(session, "🛒 My Cart", "🛒 ጋሪዬ"), "view_cart")],
  ];
  buttons.push([
    Markup.button.callback(
      t(session, "🛒 Add to cart", "🛒 ወደ ጋሪ ጨምር"),
      `choose_qty_${compactProductToken(product.id)}_0`,
    ),
  ]);
  buttons.push([
    Markup.button.callback(t(session, "🔙 Back", "🔙 ተመለስ"), "back_categories"),
  ]);

  const description = (product.description || "").replace(/\s+/g, " ").trim();
  const detailText = [
    product.name,
    "",
    description
      ? `📝 ${description.length > 180 ? `${description.slice(0, 179).trim()}…` : description}`
      : "📝 No description yet.",
    "",
    `${t(session, "Price", "ዋጋ")}: ${product.price} ETB`,
    `🏷 ${product.category || "General"}`,
  ].join("\n");
  const imageUrl = await resolveProductImage(ctx, product);
  if (imageUrl) {
    await ctx.replyWithPhoto(imageUrl, {
      caption: detailText,
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } else {
    await ctx.reply(detailText, Markup.inlineKeyboard(buttons));
  }
}

bot.action(/^cat_(\d+)(?:_(\d+))?$/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();

  const categories = await getCategories();
  const idx = Number(ctx.match[1]);
  const page = Math.max(1, Number(ctx.match[2] || 1));
  const category = categories[idx];
  if (!category)
    return ctx.reply(
      t(
        session,
        "That category isn't available anymore — try /menu again.",
        "ይህ ምድብ አሁን አይገኝም — /menu እንደገና ይሞክሩ።",
      ),
    );

  const products = await getProductsByCategory(category);
  if (products.length === 0) {
    return ctx.reply(
      t(
        session,
        "Nothing in this category right now.",
        "በዚህ ምድብ ውስጥ አሁን ምንም ምርት የለም።",
      ),
    );
  }

  const pageSize = 5;
  const totalPages = Math.ceil(products.length / pageSize);
  const pageProducts = products.slice((page - 1) * pageSize, page * pageSize);

  await ctx.reply(`📦 ${category} (${page}/${totalPages})`);
  for (const product of pageProducts) {
    const imageUrl = await resolveProductImage(ctx, product);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `🛒 Add ${product.name} — ${product.price} ETB`,
          `choose_qty_${compactProductToken(product.id)}_0`,
        ),
      ],
    ]);
    if (imageUrl) {
      await ctx.replyWithPhoto(imageUrl, {
        caption: `${product.name}\n🏷 ${product.category}\n💰 ${product.price} ETB`,
        ...keyboard,
      });
    } else {
      await ctx.reply(`${product.name}\n💰 ${product.price} ETB`, keyboard);
    }
  }
  const navigation: any[] = [];
  if (page > 1) {
    navigation.push(
      Markup.button.callback("⬅️ Previous", `cat_${idx}_${page - 1}`),
    );
  }
  if (page < totalPages) {
    navigation.push(
      Markup.button.callback("Next ➡️", `cat_${idx}_${page + 1}`),
    );
  }
  const footer: any[] = [];
  if (navigation.length) footer.push(navigation);
  footer.push([
    Markup.button.callback(
      t(session, "Back to categories", "ወደ ምድቦች"),
      "back_categories",
    ),
    Markup.button.callback(t(session, "View cart", "ጋሪዬን ይመልከቱ"), "view_cart"),
  ]);
  await ctx.reply(
    t(
      session,
      "Choose an item or browse the next page.",
      "ምርት ይምረጡ ወይም ቀጣዩን ገጽ ይመልከቱ።",
    ),
    Markup.inlineKeyboard(footer),
  );
});

bot.action("back_categories", async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  if (session.pendingOrderId) {
    return ctx.reply(
      t(
        session,
        "You have an unpaid order. What would you like to do?",
        "ያልተከፈለ ትዕዛዝ አለዎት። ምን ማድረግ ይፈልጋሉ?",
      ),
      pendingOrderDecisionKeyboard(session),
    );
  }
  await showCategoryMenu(ctx, session);
});

function pendingOrderDecisionKeyboard(session: Session): any {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t(session, "➕ Add more items", "➕ ተጨማሪ ምርቶች ጨምር"),
        "keep_order_browse",
      ),
    ],
    [
      Markup.button.callback(
        t(session, "❌ Cancel current order", "❌ የአሁኑን ትዕዛዝ ሰርዝ"),
        "cancel_pending_order",
      ),
    ],
  ]);
}

bot.action("keep_order_browse", async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  await showCategoryMenu(ctx, session);
});

bot.action("cancel_pending_order", async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  if (session.pendingOrderId) {
    try {
      await deleteUnpaidOrder(session.pendingOrderId);
    } catch (err) {
      console.error(
        `Failed to cancel unpaid order ${session.pendingOrderId}:`,
        err,
      );
      return ctx.reply(friendlyErrorText(session));
    }
    session.pendingOrderId = null;
  }
  session.cart = [];
  session.pendingStep = null;
  await persist(chatId, session);
  await ctx.reply(
    t(
      session,
      "Order canceled. You can start a new order below.",
      "ትዕዛዙ ተሰርዟል። ከታች አዲስ ትዕዛዝ መጀመር ይችላሉ።",
    ),
  );
  await showCategoryMenu(ctx, session);
});

bot.action(/prod_(.+)/, async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  return showProductDetail(ctx, session, restoreProductId(ctx.match[1]));
});

bot.action(/choose_qty_(.+)_(\d+)/, async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  const productId = restoreProductId(ctx.match[1]);
  const product = await getProduct(productId).catch(() => null);
  if (!product)
    return ctx.reply(t(session, "Product not found.", "ምርቱ አልተገኘም።"));

  const maxQuantity = 10;
  const quantityButtons: any[] = [];
  for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
    quantityButtons.push(
      Markup.button.callback(
        `${quantity}`,
        `add_selected_${compactProductToken(product.id)}_${ctx.match[2]}_${quantity}`,
      ),
    );
  }
  const rows: any[][] = [];
  for (let index = 0; index < quantityButtons.length; index += 5) {
    rows.push(quantityButtons.slice(index, index + 5));
  }
  rows.push([
    Markup.button.callback(
      t(session, "🔙 Back", "🔙 ተመለስ"),
      `prod_${compactProductToken(product.id)}`,
    ),
  ]);
  return ctx.reply(
    t(
      session,
      `How many ${product.name} would you like?`,
      `${product.name} ስንት ይፈልጋሉ?`,
    ),
    Markup.inlineKeyboard(rows),
  );
});

bot.action(/add_selected_([^_]+)_(\d+)(?:_(\d+))?/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();

  const productId = restoreProductId(ctx.match[1]);
  const product = await getProduct(productId).catch(() => null);
  if (!product) {
    return ctx.reply(t(session, "Product not found.", "ምርቱ አልተገኘም።"));
  }
  const requestedQuantity = Math.max(1, Number(ctx.match[3]) || 1);
  const existing = session.cart.find((c) => c.product_id === product.id);
  if (existing) existing.quantity += requestedQuantity;
  else
    session.cart.push({
      product_id: product.id,
      name: product.name,
      price: product.price,
      quantity: requestedQuantity,
    });
  await persist(chatId, session);

  const buttons: any[] = [
    [
      Markup.button.callback(
        t(session, "🛒 View Cart", "🛒 ጋሪ ይመልከቱ"),
        "view_cart",
      ),
    ],
    [
      Markup.button.callback(
        t(session, "🔍 More Categories", "🔍 ተጨማሪ ምድቦች"),
        "back_categories",
      ),
    ],
    [Markup.button.callback(t(session, "💳 Pay", "💳 ይክፈሉ"), "do_checkout")],
  ];

  await ctx.reply(
    t(session, `Added ${product.name} ✅`, `${product.name} ታክሏል ✅`),
    Markup.inlineKeyboard(buttons),
  );
});

bot.action("view_cart", async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  if (session.cart.length === 0) {
    return ctx.reply(t(session, "Your cart is empty.", "ጋሪዎ ባዶ ነው።"));
  }
  const lines = session.cart.map(
    (i) =>
      `${i.name}${i.color ? ` (${i.color})` : ""} x${i.quantity} = ${i.price * i.quantity} ETB`,
  );
  const total = session.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const buttons: any[] = [
    [Markup.button.callback(t(session, "💳 Pay", "💳 ይክፈሉ"), "do_checkout")],
  ];
  buttons.push([
    Markup.button.callback(
      t(session, "🗑️ Clear Cart", "🗑️ ጋሪ ያፅዱ"),
      "clear_cart",
    ),
  ]);
  session.cart.forEach((item) => {
    buttons.push([
      Markup.button.callback(
        t(session, `Remove ${item.name}`, `አስወግድ ${item.name}`),
        `remove_cart_${compactProductToken(item.product_id)}`,
      ),
    ]);
  });
  await ctx.reply(
    `${lines.join("\n")}\n\n${t(session, "Total", "ጠቅላላ")}: ${total} ETB`,
    Markup.inlineKeyboard(buttons),
  );
});

bot.action("clear_cart", async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  session.cart = [];
  await persist(chatId, session);
  return ctx.reply(t(session, "Cart cleared.", "ጋሪዎ ተጸድቋል።"));
});

bot.action(/remove_cart_(.+)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const productId = restoreProductId(ctx.match[1]);
  const before = session.cart.length;
  session.cart = session.cart.filter((item) => item.product_id !== productId);
  await persist(chatId, session);
  if (before === session.cart.length) {
    return ctx.reply(
      t(session, "That item is not in your cart.", "ይህ እቃ በጋሪዎ ውስጥ አይገኝም።"),
    );
  }

  if (session.cart.length === 0) {
    return ctx.reply(
      t(
        session,
        "Item removed from cart. Want to keep shopping?",
        "እቃው ከጋሪ ተወግዷል። ሌላ ምርት ልገዛ?",
      ),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            t(session, "🛍️ Browse categories", "🛍️ ምድቦችን ይዘርዝሩ"),
            "back_categories",
          ),
        ],
        [
          Markup.button.callback(
            t(session, "💳 Pay later", "💳 በኋላ ክፍያ ያድርጉ"),
            "do_checkout",
          ),
        ],
      ]),
    );
  }

  return ctx.reply(
    t(
      session,
      "Item removed from cart. Keep shopping?",
      "እቃው ከጋሪ ተወግዷል። መጨረሻ እንቀጥል?",
    ),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          t(session, "🛍️ Continue shopping", "🛍️ ማስሻሻ ይቀጥል"),
          "back_categories",
        ),
      ],
      [Markup.button.callback(t(session, "💳 Pay", "💳 ይክፈሉ"), "do_checkout")],
    ]),
  );
});

bot.action(/seller_q_(.+)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const productId = restoreProductId(ctx.match[1]);
  const product = await getProduct(productId).catch(() => null);
  const productName = product ? product.name : "this item";

  await bot.telegram.sendMessage(
    process.env.SELLER_TELEGRAM_ID!,
    `💬 Customer asked about ${productName} (chat ${chatId})\n\nPlease reply directly in Telegram with pricing, availability, or a deal.`,
  );

  return ctx.reply(
    t(
      session,
      `I’ve forwarded this to the seller for a quick answer on ${productName}.`,
      `${productName} ለሻጭ ተልኮ መልስ እንዲያገኝ አድርጓል።`,
    ),
  );
});

// ---- admin: product CRUD button handlers (seller only) ----

bot.action("seller_dashboard", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerDashboard(ctx);
});

bot.action("seller_products", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showAdminProductList(ctx, 1);
});

bot.action("seller_orders", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showSellerOrders(ctx);
});

bot.action("seller_payments", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showPaymentMethods(ctx);
});

bot.action("seller_address", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showStoreAddress(ctx);
});

bot.action("address_edit", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await beginAddressEdit(ctx);
});

bot.action("address_add", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await beginAddressDraft(ctx);
});

bot.action(/^address_field_(address|description|image)$/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  const existing = await getStoreAddress();
  if (!existing) return beginAddressDraft(ctx);

  adminDrafts.delete(ctx.chat!.id);
  paymentDrafts.delete(ctx.chat!.id);
  const step = ctx.match[1] as AddressDraft["step"];
  addressDrafts.set(ctx.chat!.id, {
    mode: "edit",
    step,
    address: existing.address,
    description: existing.description,
    image_url: existing.image_url,
  });
  const prompts = {
    address: "Send the new store address:",
    description: "Send the new description, or /skip to clear it:",
    image: "Send the new place photo:",
  };
  await ctx.reply(prompts[step], sellerReplyKeyboard());
});

bot.action("address_delete", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  try {
    const address = await getStoreAddress();
    if (!address) return ctx.reply("No store address is configured.");

    await deleteStoreAddress(address.id);
    const imagePath = storagePathFromPublicUrl(address.image_url);
    if (imagePath) {
      const { error } = await supabase.storage
        .from("product-images")
        .remove([imagePath]);
      if (error) console.warn("Could not remove deleted address image:", error);
    }
    await ctx.reply("Store address removed ✅", sellerReplyKeyboard());
  } catch (err) {
    console.error("Failed to remove store address:", err);
    await ctx.reply(
      "Could not remove the address. Please check that the store_addresses table migration has been run, then try again.",
    );
  }
});

bot.action("payment_add", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  adminDrafts.delete(ctx.chat!.id);
  addressDrafts.delete(ctx.chat!.id);
  paymentDrafts.set(ctx.chat!.id, { mode: "create", step: "name" });
  await ctx.reply("Payment name (for example Telebirr or CBE):");
});

bot.action(/payment_edit_(.+)/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  adminDrafts.delete(ctx.chat!.id);
  addressDrafts.delete(ctx.chat!.id);
  const method = (await listPaymentMethods(false)).find(
    (item) => item.id === ctx.match[1],
  );
  if (!method) return ctx.reply("Payment option not found.");
  paymentDrafts.set(ctx.chat!.id, {
    mode: "edit",
    id: method.id,
    step: "name",
    name: method.name,
    account_number: method.account_number,
    account_name: method.account_name,
  });
  await ctx.reply(`${paymentMethodText(method)}\n\nSend the new payment name:`);
});

bot.action(/payment_delete_(.+)/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await deletePaymentMethod(ctx.match[1]);
  await ctx.reply("Payment option removed from customer payment choices ✅");
  await showPaymentMethods(ctx);
});

bot.action("admin_add", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  paymentDrafts.delete(ctx.chat!.id);
  addressDrafts.delete(ctx.chat!.id);
  adminDrafts.set(ctx.chat!.id, { mode: "create", step: "name" });
  await ctx.reply("Let's add a new product. What's the product name?");
});

bot.action(/admin_page_(\d+)/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  await showAdminProductList(ctx, Number(ctx.match[1]));
});

bot.action(/admin_edit_(.+)/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  const productId = restoreProductId(ctx.match[1]);
  const product = await getProduct(productId).catch(() => null);
  if (!product) return ctx.reply("That product no longer exists.");

  const draft = refreshDraftFromProduct(product);
  adminDrafts.set(ctx.chat!.id, draft);
  await ctx.reply(adminEditMenuText(draft), adminEditMenuKeyboard(product.id));
});

bot.action(
  /admin_field_(name|price|category|description|image)_(.+)/,
  async (ctx) => {
    if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
    await ctx.answerCbQuery();
    const field = ctx.match[1] as AdminDraftField;
    const productId = restoreProductId(ctx.match[2]);
    const draft = adminDrafts.get(ctx.chat!.id);
    if (!draft || draft.productId !== productId)
      return ctx.reply("Session expired — tap /menu to start again.");

    draft.step = field;
    adminDrafts.set(ctx.chat!.id, draft);

    const prompts: Record<AdminDraftField, string> = {
      name: "Send the new product name.",
      price: "Send the new price (numbers only, in ETB).",
      category: "Send the new category in lowercase.",
      description: "Send the new product description.",
      image: "Send the new product image as a photo.",
    };
    await ctx.reply(prompts[field]);
  },
);

bot.action(/^admin_delete_confirm_(.+)$/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  const productId = restoreProductId(ctx.match[1]);
  try {
    await deleteProduct(productId);
    adminDrafts.delete(ctx.chat!.id);
    await ctx.reply("Product deleted ✅");
    await showAdminProductList(ctx, 1);
  } catch (err) {
    console.error("Failed to delete product:", err);
    await ctx.reply("Something went wrong deleting that product.");
  }
});

bot.action(/admin_delete_(.+)/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  if (ctx.match[1].startsWith("confirm_")) return;
  await ctx.answerCbQuery();
  const productId = restoreProductId(ctx.match[1]);
  await ctx.reply(
    "Delete this product? This can't be undone.",
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "❌ Yes, delete",
          `admin_delete_confirm_${compactProductToken(productId)}`,
        ),
      ],
      [
        Markup.button.callback(
          "Cancel",
          `admin_edit_${compactProductToken(productId)}`,
        ),
      ],
    ]),
  );
});

bot.action("admin_done", async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  await ctx.answerCbQuery();
  adminDrafts.delete(ctx.chat!.id);
  await ctx.reply("Done ✅");
});

bot.action("noop", async (ctx) => ctx.answerCbQuery());

bot.action("do_checkout", async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const customerName = ctx.from.first_name || ctx.from.username || "Customer";
  return proceedToCheckout(ctx, session, customerName);
});

// ---- shared checkout flow (used by both the AI's checkout tool and the buttons above) ----

async function proceedToCheckout(
  ctx: any,
  session: Session,
  customerName: string,
): Promise<void> {
  const chatId = ctx.chat.id;
  if (session.cart.length === 0) {
    return ctx.reply(
      t(
        session,
        "Your cart is empty — add something first!",
        "ጋሪዎ ባዶ ነው — መጀመሪያ ነገር ይጨምሩ!",
      ),
    );
  }
  session.customerPhone = null;
  session.deliveryLocation = null;
  session.deliveryFee = 0;
  await persist(chatId, session);
  return askPhone(ctx, session);
}

async function askPaymentMethod(
  ctx: any,
  session: Session,
  customerName: string,
): Promise<void> {
  const methods = await listPaymentMethods(true);
  if (methods.length === 0) {
    return ctx.reply(
      t(
        session,
        "Payment is temporarily unavailable. Please contact the seller.",
        "ክፍያ ለጊዜው አይገኝም። እባክዎ ሻጩን ያነጋግሩ።",
      ),
    );
  }
  session.pendingStep = "awaiting_payment_method";
  await persist(ctx.chat.id, session);
  await ctx.reply(
    t(session, "Choose a payment method:", "የክፍያ ዘዴ ይምረጡ፦"),
    Markup.inlineKeyboard(
      methods.map((method) => [
        Markup.button.callback(
          `${method.name} (${method.account_number})`,
          `payment_choose_${method.id}`,
        ),
      ]),
    ),
  );
}

bot.action(/payment_choose_(.+)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const method = (await listPaymentMethods(true)).find(
    (item) => item.id === ctx.match[1],
  );
  if (!method) {
    return ctx.reply(
      t(
        session,
        "That payment method is unavailable. Please choose again.",
        "ያ የክፍያ ዘዴ አይገኝም። እባክዎ እንደገና ይምረጡ።",
      ),
    );
  }
  session.pendingStep = null;
  await persist(chatId, session);
  const customerName = ctx.from.first_name || ctx.from.username || "Customer";
  return finalizeOrder(chatId, session, customerName, method);
});

async function askDeliveryChoice(ctx: any, session: Session): Promise<void> {
  session.pendingStep = "awaiting_delivery_choice";
  await persist(ctx.chat.id, session);
  await ctx.reply(
    t(session, "Where should we deliver to? 🚚", "ማድረሻዎ የት ነው? 🚚"),
    Markup.inlineKeyboard([
      Markup.button.callback(
        t(session, "🏙️ Addis Ababa", "🏙️ አዲስ አበባ"),
        "delivery_addis",
      ),
      Markup.button.callback(
        t(session, "🚚 Outside Addis Ababa", "🚚 ከአዲስ አበባ ውጭ"),
        "delivery_outside",
      ),
    ]),
  );
}

async function askPhone(ctx: any, session: Session): Promise<void> {
  session.pendingStep = "awaiting_phone";
  await persist(ctx.chat.id, session);
  await ctx.reply(
    t(
      session,
      "Before we finish up, please share your phone number 📱 (so we can reach you about your order)",
      "ትዕዛዝዎን ከመጨረሳችን በፊት፣ ስልክ ቁጥርዎን ያጋሩ 📱 (ስለ ትዕዛዝዎ ልናገኝዎት እንድንችል)",
    ),
    Markup.keyboard([
      Markup.button.contactRequest(
        t(session, "📱 Share phone number", "📱 ስልክ ቁጥር አጋራ"),
      ),
    ])
      .resize()
      .oneTime(),
  );
}

async function finalizeOrder(
  chatId: number,
  session: Session,
  customerName: string,
  paymentMethod: PaymentMethod,
): Promise<void> {
  const subtotal = session.cart.reduce(
    (sum, i) => sum + i.price * i.quantity,
    0,
  );
  const deliveryFee = session.deliveryFee || 0;

  const order = await createOrderFromCart(chatId, customerName, session.cart, {
    customerPhone: session.customerPhone,
    deliveryLocation: session.deliveryLocation,
    deliveryFee,
    paymentMethod,
  });

  session.pendingOrderId = order.id;
  session.cart = [];
  session.pendingStep = null;
  const deliveryLocationForMsg = session.deliveryLocation;
  session.deliveryLocation = null;
  session.deliveryFee = 0;
  await persist(chatId, session);

  const total = subtotal + deliveryFee;
  const breakdown =
    deliveryFee > 0
      ? t(
          session,
          `Subtotal: ${subtotal} ETB\nDelivery (${deliveryLocationForMsg}): ${deliveryFee} ETB\nTotal: ${total} ETB`,
          `ንዑስ ድምር፦ ${subtotal} ብር\nየመላኪያ ክፍያ (${deliveryLocationForMsg})፦ ${deliveryFee} ብር\nጠቅላላ፦ ${total} ብር`,
        )
      : t(session, `Total: ${total} ETB`, `ጠቅላላ፦ ${total} ብር`);

  const payMsg = t(
    session,
    `Order created ✅\n\n${breakdown}\n\nPay using ${paymentMethod.name}:\nAccount: ${paymentMethod.account_number}${paymentMethod.account_name ? `\nAccount name: ${paymentMethod.account_name}` : ""}${paymentMethod.instructions ? `\n${paymentMethod.instructions}` : ""}\n\nThen send a screenshot of the payment right here to confirm your order.\n\nCheck status anytime with /orders. Questions? Call: ${process.env.SELLER_PHONE_NUMBER}`,
    `ትዕዛዝዎ ተፈጥሯል ✅\n\n${breakdown}\n\nበ ${paymentMethod.name} ይክፈሉ፦\nየሂሳብ ቁጥር፦ ${paymentMethod.account_number}${paymentMethod.account_name ? `\nየሂሳቡ ባለቤት፦ ${paymentMethod.account_name}` : ""}${paymentMethod.instructions ? `\n${paymentMethod.instructions}` : ""}\n\nከዚያ የክፍያ ደረሰኝዎን ስክሪንሾት እዚህ ይላኩ።\n\nደረጃውን በማንኛውም ጊዜ /orders ይመልከቱ። ጥያቄ ካለዎት ይደውሉ፦ ${process.env.SELLER_PHONE_NUMBER}`,
  );

  await bot.telegram.sendMessage(chatId, payMsg, Markup.removeKeyboard());
}

bot.action(/lang_(en|am)/, async (ctx) => {
  const language = ctx.match[1] as "en" | "am";
  const session = await getSession(ctx.chat!.id);
  session.language = language;
  await persist(ctx.chat!.id, session);
  await ctx.answerCbQuery();

  const greeting =
    language === "am"
      ? `እንኳን ደህና መጡ${ctx.from.first_name ? " " + ctx.from.first_name : ""}! 👋 ስለ ማንኛውም ምርት ዋጋ ወይም ክምችት ይጠይቁኝ፣ ወይም /menu ይንኩ ካታሎግ ለማየት።`
      : `Hi${ctx.from.first_name ? " " + ctx.from.first_name : ""}! 👋 Ask me about anything in the shop, or tap /menu to browse the catalog.`;
  await ctx.reply(greeting, mainMenuKeyboard(session));
});

bot.command("language", async (ctx) => {
  const session = await getSession(ctx.chat.id);
  await showLanguagePicker(ctx, session);
});

// ---- /orders: customer order history & status ----
bot.command("orders", async (ctx) => {
  const session = await getSession(ctx.chat.id);
  await showCustomerOrders(ctx, session);
});

// ---- contact share: phone number (checkout, or a post-rejection request) ----
bot.on("contact", async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);

  // Case 1: we asked for a phone number after rejecting an order that had
  // none on file, so the seller can follow up with the customer directly.
  if (session.pendingStep === "awaiting_reject_phone") {
    if (ctx.message.contact.user_id !== ctx.from.id) {
      return ctx.reply(
        t(
          session,
          "Please share your own phone number 🙏",
          "የራስዎን ስልክ ቁጥር ብቻ ያጋሩ 🙏",
        ),
      );
    }

    session.customerPhone = ctx.message.contact.phone_number;
    session.pendingStep = null;
    await persist(chatId, session);

    await ctx.reply(
      t(
        session,
        "Thank you! We'll be in touch shortly. 🙏",
        "አመሰግናለሁ! በቅርቡ እናገኝዎታለን። 🙏",
      ),
      Markup.removeKeyboard(),
    );

    const orderId = pendingPhoneRequestByCustomer.get(chatId);
    pendingPhoneRequestByCustomer.delete(chatId);

    if (orderId) {
      try {
        await supabase
          .from("orders")
          .update({ customer_phone: session.customerPhone })
          .eq("id", orderId);
      } catch (err) {
        console.error(`Failed to save phone on order ${orderId}:`, err);
      }
      try {
        await bot.telegram.sendMessage(
          process.env.SELLER_TELEGRAM_ID!,
          `📞 Customer for rejected order #${orderId.slice(0, 8)} shared their phone number: ${session.customerPhone}\n\nPlease reach out to them.`,
        );
      } catch (err) {
        console.error("Failed to notify seller of shared phone:", err);
      }
    }
    return;
  }

  // Case 2: normal checkout flow.
  if (session.pendingStep !== "awaiting_phone") return;

  if (ctx.message.contact.user_id !== ctx.from.id) {
    return ctx.reply(
      t(
        session,
        "Please share your own phone number 🙏",
        "የራስዎን ስልክ ቁጥር ብቻ ያጋሩ 🙏",
      ),
    );
  }

  session.customerPhone = ctx.message.contact.phone_number;
  await persist(chatId, session);
  await ctx.reply(
    t(session, "Thank you! 🙏", "አመሰግናለሁ! 🙏"),
    Markup.removeKeyboard(),
  );
  await askDeliveryChoice(ctx, session);
});

// ---- delivery zone choice ----
bot.action(/delivery_(addis|outside)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();

  if (ctx.match[1] === "addis") {
    session.deliveryLocation = "Addis Ababa";
    session.deliveryFee = 0;
    session.pendingStep = null;
    await persist(chatId, session);
    const customerName = ctx.from.first_name || ctx.from.username || "Customer";
    return askPaymentMethod(ctx, session, customerName);
  }

  session.pendingStep = "awaiting_delivery_area";
  await persist(chatId, session);
  return ctx.reply(
    t(
      session,
      "Please type your city/area (e.g. Adama)",
      "እባክዎ ከተማ/አካባቢዎን ይጻፉ (ለምሳሌ፦ አዳማ)",
    ),
  );
});

// ---- text messages ----
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  let session: Session;

  try {
    session = await getSession(chatId);
  } catch (err) {
    console.error(`Failed to load session for chat ${chatId}:`, err);
    return ctx.reply(
      "Sorry, I'm having trouble loading your session 🙏 Please try again shortly.",
    );
  }

  const customerName = ctx.from.first_name || ctx.from.username || "Customer";
  const text = ctx.message.text;

  if (isSeller(ctx.from.id)) {
    const sellerHandled = await handleSellerKeyboardText(ctx, text);
    if (sellerHandled) return;

    const addressDraft = addressDrafts.get(chatId);
    if (addressDraft) {
      if (addressDraft.mode === "edit") {
        if (addressDraft.step === "address") {
          if (!text.trim()) return ctx.reply("Address is required.");
          try {
            await saveStoreAddress({
              address: text.trim(),
              description: addressDraft.description,
              image_url: addressDraft.image_url,
            });
            addressDrafts.delete(chatId);
            return ctx.reply("Store address updated ✅", sellerReplyKeyboard());
          } catch (err) {
            console.error("Failed to update store address:", err);
            return ctx.reply(
              "Could not save the address. Please check that the store_addresses table migration has been run, then try again.",
            );
          }
        }
        if (addressDraft.step === "description") {
          try {
            await saveStoreAddress({
              address: addressDraft.address!,
              description:
                text.trim().toLowerCase() === "/skip" ? null : text.trim(),
              image_url: addressDraft.image_url,
            });
            addressDrafts.delete(chatId);
            return ctx.reply(
              "Address description updated ✅",
              sellerReplyKeyboard(),
            );
          } catch (err) {
            console.error("Failed to update address description:", err);
            return ctx.reply(
              "Could not save the address description. Please try again.",
            );
          }
        }
        return ctx.reply("Please send the new place photo.");
      }
      if (addressDraft.step === "address") {
        if (!text.trim()) return ctx.reply("Address is required.");
        addressDraft.address = text.trim();
        addressDraft.step = "description";
        addressDrafts.set(chatId, addressDraft);
        return ctx.reply("Send a short description or /skip:");
      }
      if (addressDraft.step === "description") {
        addressDraft.description =
          text.trim().toLowerCase() === "/skip" ? null : text.trim();
        addressDraft.step = "image";
        addressDrafts.set(chatId, addressDraft);
        return ctx.reply("Send a photo of the place, or type /skip:");
      }
      if (text.trim().toLowerCase() === "/skip") {
        try {
          await saveStoreAddress({
            address: addressDraft.address!,
            description: addressDraft.description,
            image_url: addressDraft.image_url,
          });
          addressDrafts.delete(chatId);
          return ctx.reply("Store address saved ✅", sellerReplyKeyboard());
        } catch (err) {
          console.error("Failed to save store address:", err);
          return ctx.reply(
            "Could not save the address. Please check that the store_addresses table migration has been run, then try again.",
          );
        }
      }
      return ctx.reply("Please send the place photo or type /skip.");
    }

    const paymentDraft = paymentDrafts.get(chatId);
    if (paymentDraft) {
      await handlePaymentDraftText(ctx, paymentDraft, text);
      return;
    }

    const draft = adminDrafts.get(chatId);
    if (draft && draft.step) {
      await handleAdminDraftText(ctx, draft, text.trim());
      return;
    }

    const pendingOrderId = pendingRejectReasonBySeller.get(ctx.from.id);
    if (pendingOrderId) {
      if (text.trim().toLowerCase() === "/cancel_reject") {
        pendingRejectReasonBySeller.delete(ctx.from.id);
        return ctx.reply("Canceled pending reject reason.");
      }

      pendingRejectReasonBySeller.delete(ctx.from.id);
      await rejectOrderWithOptionalReason(ctx, pendingOrderId, text.trim());
      return;
    }
  }

  if (!session.language) {
    return ctx.reply("Please tap /start first to choose a language.");
  }

  if (isOrderStatusIntent(text)) {
    try {
      await showCustomerOrders(ctx, session);
    } catch (err) {
      console.error(`Failed to show order status for chat ${chatId}:`, err);
      return ctx.reply(friendlyErrorText(session));
    }
    return;
  }

  if (isOrderStatusIntent(text)) {
    try {
      await showCustomerOrders(ctx, session);
    } catch (err) {
      console.error(`Failed to show order status for chat ${chatId}:`, err);
      return ctx.reply(friendlyErrorText(session));
    }
    return;
  }

  if (await handleQuickAction(ctx, session, text)) {
    return;
  }

  // deterministic steps — never routed through the AI
  if (session.pendingStep === "awaiting_delivery_area") {
    session.deliveryLocation = text.trim();
    session.deliveryFee = OUTSIDE_ADDIS_FEE;
    session.pendingStep = null;
    await persist(chatId, session);
    try {
      await askPaymentMethod(ctx, session, customerName);
    } catch (err) {
      console.error(`Failed to finalize order for chat ${chatId}:`, err);
      return ctx.reply(friendlyErrorText(session));
    }
    return;
  }

  if (session.pendingStep === "awaiting_phone") {
    const digits = text.replace(/[^\d+]/g, "");
    if (digits.length < 9) {
      return ctx.reply(
        t(
          session,
          "Please enter a valid phone number, or tap the button below to share it 📱",
          "እባክዎ ትክክለኛ ስልክ ቁጥር ያስገቡ ወይም ከታች ያለውን አዝራር ይጠቀሙ 📱",
        ),
      );
    }
    session.customerPhone = digits;
    await persist(chatId, session);
    return askDeliveryChoice(ctx, session);
  }

  if (session.pendingStep === "awaiting_reject_phone") {
    const digits = text.replace(/[^\d+]/g, "");
    if (digits.length < 9) {
      return ctx.reply(
        t(
          session,
          "Please enter a valid phone number, or tap the button below to share it 📱",
          "እባክዎ ትክክለኛ ስልክ ቁጥር ያስገቡ ወይም ከታች ያለውን አዝራር ይጠቀሙ 📱",
        ),
      );
    }
    session.customerPhone = digits;
    session.pendingStep = null;
    await persist(chatId, session);

    await ctx.reply(
      t(
        session,
        "Thank you! We'll be in touch shortly. 🙏",
        "አመሰግናለሁ! በቅርቡ እናገኝዎታለን። 🙏",
      ),
      Markup.removeKeyboard(),
    );

    const orderId = pendingPhoneRequestByCustomer.get(chatId);
    pendingPhoneRequestByCustomer.delete(chatId);
    if (orderId) {
      try {
        await supabase
          .from("orders")
          .update({ customer_phone: session.customerPhone })
          .eq("id", orderId);
      } catch (err) {
        console.error(`Failed to save phone on order ${orderId}:`, err);
      }
      try {
        await bot.telegram.sendMessage(
          process.env.SELLER_TELEGRAM_ID!,
          `📞 Customer for rejected order #${orderId.slice(0, 8)} shared their phone number: ${session.customerPhone}\n\nPlease reach out to them.`,
        );
      } catch (err) {
        console.error("Failed to notify seller of shared phone:", err);
      }
    }
    return;
  }

  const normalized = text.trim();

  if (!normalized) return;

  const languageChange = normalized
    .toLowerCase()
    .match(
      /^(?:switch to|change to|set language)\s+(english|amharic)|^(?:english|amharic)$/i,
    );
  if (languageChange) {
    const newLang =
      languageChange[1]?.toLowerCase() === "amharic" ? "am" : "en";
    session.language = newLang;
    await persist(chatId, session);
    return ctx.reply(
      newLang === "am"
        ? "ቋንቋ ወደ አማርኛ ተቀየረ። ምን ይፈልጋሉ? 😊"
        : "Language switched to English. What are you looking for? 😊",
    );
  }

  const casualGreeting =
    /^(hi|hello|hey|good\s+(morning|afternoon|evening)|how\s+are\s+you|how\s+are\s+you\s+doing|what'?s\s+up|what\s+bout\s+my\s+cart|what\s+about\s+my\s+cart|thanks|thank\s+you|help|can\s+you\s+help|yo)\b/i;
  if (casualGreeting.test(normalized)) {
    await ctx.reply(
      t(
        session,
        "Hi! I can help with products, your cart, or your orders. 😊 What are you looking for?",
        "ሰላም! ምርቶችን፣ ጋሪዎን ወይም ትዕዛዜዎን ማርዶ እችላለሁ 😊 ምን ይፈልጋሉ?",
      ),
      mainMenuKeyboard(session),
    );
    return;
  }

  const cartLookUp =
    /(?:what\s+bout\s+my\s+cart|what\s+about\s+my\s+cart|show\s+my\s+cart|view\s+cart|check\s+my\s+cart|my\s+cart|cart\s+please)/i;
  if (cartLookUp.test(normalized)) {
    try {
      await showCartText(ctx, session);
    } catch (err) {
      console.error(`Failed to show cart for chat ${chatId}:`, err);
      return ctx.reply(friendlyErrorText(session));
    }
    return;
  }

  // Important: free-form customer text must be interpreted by the AI tool-calling
  // layer. We intentionally avoid regex-driven guesses here so responses are based
  // on the actual message and the tool schema instead of a hard-coded shortcut.
  try {
    await ctx.sendChatAction("typing");
  } catch {}

  try {
    const result = await handleMessage(session, text, customerName);
    await persist(chatId, session);

    if (result.action === "reply") {
      const cleanText = (result.text || "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!cleanText) {
        return ctx.reply(
          t(
            session,
            "Hi! I can help with products, your cart, or your orders. 😊 What are you looking for?",
            "ሰላም! ምርቶችን፣ ጋሪዎን ወይም ትዕዛዜዎን ማርዶ እችላለሁ 😊 ምን ይፈልጋሉ?",
          ),
          mainMenuKeyboard(session),
        );
      }

      return ctx.reply(cleanText);
    }

    if (result.action === "show_categories") {
      return showCategoryMenu(ctx, session);
    }

    if (result.action === "show_customer_orders") {
      return showCustomerOrders(ctx, session);
    }

    if (result.action === "ask_seller") {
      try {
        await bot.telegram.sendMessage(
          process.env.SELLER_TELEGRAM_ID!,
          `❓ Customer question I couldn't answer (chat ${chatId}, ${customerName}${session.customerPhone ? `, 📞 ${session.customerPhone}` : ""}):\n"${result.question}"\n\nReply to them directly in Telegram${session.customerPhone ? " or by phone" : ""}.`,
        );
      } catch (err) {
        console.error("Failed to notify seller:", err);
      }
      return ctx.reply(
        t(
          session,
          "Good question — let me check with the seller and get back to you shortly. 😊",
          "ጥሩ ጥያቄ ነው — ላረጋግጥልዎ እና በቅርቡ እመልስልዎታለሁ። 😊",
        ),
      );
    }

    if (result.action === "checkout") {
      return proceedToCheckout(ctx, session, customerName);
    }
  } catch (err) {
    console.error(`Error handling message for chat ${chatId}:`, err);
    return ctx.reply(friendlyErrorText(session));
  }
});

// ---- photo messages: payment screenshot flow ----
bot.on("photo", async (ctx) => {
  const chatId = ctx.chat.id;

  let session: Session;

  try {
    session = await getSession(chatId);
  } catch (err) {
    console.error(`Failed to load session for chat ${chatId}:`, err);
    return ctx.reply(
      "Sorry, I'm having trouble right now 🙏 Please try again shortly.",
    );
  }

  const adminDraft = adminDrafts.get(chatId);
  const addressDraft = addressDrafts.get(chatId);
  if (isSeller(ctx.from.id) && addressDraft?.step === "image") {
    try {
      const photos = ctx.message.photo;
      const fileId = photos[photos.length - 1].file_id;
      const previousAddress = await getStoreAddress();
      addressDraft.image_url = await uploadProductImage(
        ctx,
        fileId,
        `address-${chatId}-${Date.now()}.jpg`,
      );
      await saveStoreAddress({
        address: addressDraft.address!,
        description: addressDraft.description,
        image_url: addressDraft.image_url,
      });
      const previousImagePath = storagePathFromPublicUrl(
        previousAddress?.image_url,
      );
      if (previousImagePath) {
        const { error: removeError } = await supabase.storage
          .from("product-images")
          .remove([previousImagePath]);
        if (removeError)
          console.warn("Could not remove old address image:", removeError);
      }
      addressDrafts.delete(chatId);
      await ctx.reply(
        "Store address and photo saved ✅",
        sellerReplyKeyboard(),
      );
    } catch (err) {
      console.error("Failed to save store address photo:", err);
      await ctx.reply("Could not save that address photo.");
    }
    return;
  }
  if (isSeller(ctx.from.id) && adminDraft?.step === "image") {
    try {
      const photos = ctx.message.photo;
      const fileId = photos[photos.length - 1].file_id;
      const imageUrl = await uploadProductImage(
        ctx,
        fileId,
        `product-${chatId}-${Date.now()}.jpg`,
      );

      if (adminDraft.mode === "create") {
        adminDraft.image_url = imageUrl;
        await finalizeNewProduct(ctx, adminDraft);
      } else if (adminDraft.productId) {
        const updated = await updateProduct(adminDraft.productId, {
          image_url: imageUrl,
        });
        const refreshed = refreshDraftFromProduct(updated);
        adminDrafts.set(chatId, refreshed);
        await ctx.reply("Image updated ✅");
        await ctx.reply(
          adminEditMenuText(refreshed),
          adminEditMenuKeyboard(updated.id),
        );
      }
    } catch (err) {
      console.error("Failed to save product image:", err);
      await ctx.reply("Something went wrong saving that product image.");
    }
    return;
  }

  if (!session.pendingOrderId) {
    return ctx.reply(
      "I don't have a pending order for you — tell me what you'd like to buy first.",
    );
  }

  const orderId = session.pendingOrderId;

  try {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    const res = await fetch(fileLink.href);
    if (!res.ok)
      throw new Error(`Failed to download screenshot: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const path = `${orderId}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from("payment-screenshots")
      .upload(path, buffer, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase.storage
      .from("payment-screenshots")
      .getPublicUrl(path);
    const order = await attachScreenshot(orderId, publicUrl.publicUrl);

    const { data: items } = await supabase
      .from("order_items")
      .select("*")
      .eq("order_id", orderId);

    session.pendingOrderId = null;
    await persist(chatId, session);

    await ctx.reply(
      t(
        session,
        "Got it! Your payment is being verified — we'll confirm shortly. 🙏 Check status anytime with /orders.",
        "ደረሰኝዎ ተቀብለናል! ክፍያዎ በመረጋገጥ ላይ ነው — በቅርቡ እናረጋግጣለን። 🙏 ደረጃውን በ /orders ማየት ይችላሉ።",
      ),
    );

    const itemLines = (items || [])
      .map(
        (i) =>
          `• ${i.product_name} x${i.quantity} — ${i.unit_price * i.quantity} ETB`,
      )
      .join("\n");

    try {
      await bot.telegram.sendPhoto(
        process.env.SELLER_TELEGRAM_ID!,
        publicUrl.publicUrl,
        {
          caption:
            `🛒 New order #${order.id.slice(0, 8)}\n` +
            `${itemLines}\n` +
            (order.delivery_fee
              ? `Delivery (${order.delivery_location}): ${order.delivery_fee} ETB\n`
              : `Delivery: Addis Ababa\n`) +
            `Total: ${order.total} ETB\n` +
            `Customer: ${order.customer_name}\n` +
            `📞 ${order.customer_phone || "not shared"}`,
          ...Markup.inlineKeyboard([
            Markup.button.callback("✅ Confirm", `confirm_${order.id}`),
            Markup.button.callback("❌ Reject", `reject_${order.id}`),
          ]),
        },
      );
    } catch (err) {
      console.error(`Failed to notify seller for order ${order.id}:`, err);
    }
  } catch (err) {
    console.error(
      `Failed to process payment screenshot for order ${orderId}:`,
      err,
    );
    return ctx.reply(
      t(
        session,
        "Something went wrong saving your screenshot — please try sending it again.",
        "ይቅርታ፣ ስክሪንሾትዎን ማስቀመጥ አልቻልኩም — እባክዎ እንደገና ይላኩ።",
      ),
    );
  }
});

// ---- seller taps Confirm / Reject ----
async function updateSellerOrderMessage(
  ctx: any,
  statusText: string,
): Promise<void> {
  const message = (ctx.callbackQuery as any)?.message;
  const currentText = message?.caption || message?.text || "";
  const updatedText = `${currentText}\n\n${statusText}`.trim();

  try {
    if (message?.photo || message?.caption !== undefined) {
      await ctx.editMessageCaption(updatedText);
    } else if (message?.text !== undefined) {
      await ctx.editMessageText(updatedText);
    } else {
      await ctx.reply(statusText);
    }
  } catch (err) {
    console.error("Failed to update seller order message:", err);
    await ctx.reply(statusText);
  }
}

async function deletePaymentScreenshot(
  screenshotUrl?: string | null,
): Promise<void> {
  if (!screenshotUrl) return;

  const marker = "/storage/v1/object/public/payment-screenshots/";
  const markerIndex = screenshotUrl.indexOf(marker);
  if (markerIndex < 0) {
    console.warn("Could not determine payment screenshot storage path.");
    return;
  }

  const path = decodeURIComponent(
    screenshotUrl.slice(markerIndex + marker.length),
  );
  const { error } = await supabase.storage
    .from("payment-screenshots")
    .remove([path]);
  if (error) throw error;
}

bot.action(/confirm_(.+)/, async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.SELLER_TELEGRAM_ID))
    return ctx.answerCbQuery("Not authorized");
  try {
    const orderId = ctx.match[1];
    const order = await setOrderStatus(orderId, "confirmed");
    try {
      await deletePaymentScreenshot(order.screenshot_url);
    } catch (err) {
      console.error("Failed to delete confirmed payment screenshot:", err);
    }
    await ctx.answerCbQuery("Confirmed");
    await updateSellerOrderMessage(ctx, "✅ CONFIRMED");
    const custSession = await getSession(Number(order.customer_telegram_id));
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      t(
        custSession,
        `Your order is confirmed! 🎉 We'll be in touch about delivery. Questions? Call: ${process.env.SELLER_PHONE_NUMBER}`,
        `ትዕዛዝዎ ተረጋግጧል! 🎉 ስለ ማድረሻ በቅርቡ እናገኝዎታለን። ጥያቄ ካለዎት ይደውሉ፦ ${process.env.SELLER_PHONE_NUMBER}`,
      ),
    );
  } catch (err) {
    console.error("Failed to confirm order:", err);
    await ctx.answerCbQuery("Something went wrong — please try again.");
  }
});

bot.action(/^reject_(?!now_|reason_)(.+)$/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");

  const orderId = ctx.match[1];
  await ctx.answerCbQuery();

  return ctx.reply(
    "Reject this order now, or add a reason first?",
    Markup.inlineKeyboard([
      [Markup.button.callback("❌ Reject now", `reject_now_${orderId}`)],
      [
        Markup.button.callback(
          "📝 Add reason and reject",
          `reject_reason_${orderId}`,
        ),
      ],
    ]),
  );
});

bot.action(/^reject_reason_(.+)$/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  const orderId = ctx.match[1];
  pendingRejectReasonBySeller.set(ctx.from.id, orderId);
  await ctx.answerCbQuery("Send reason as your next message");
  return ctx.reply(
    `Send rejection reason for order #${orderId.slice(0, 8)}.\n\nOr type /cancel_reject to cancel.`,
  );
});

bot.command("cancel_reject", async (ctx) => {
  if (!isSeller(ctx.from.id)) return;
  const existed = pendingRejectReasonBySeller.delete(ctx.from.id);
  if (!existed) return;
  await ctx.reply("Canceled pending reject reason.");
});

async function rejectOrderWithOptionalReason(
  ctx: any,
  orderId: string,
  reason?: string,
): Promise<void> {
  try {
    const order = await setOrderStatus(orderId, "rejected");
    try {
      await deletePaymentScreenshot(order.screenshot_url);
    } catch (err) {
      console.error("Failed to delete rejected payment screenshot:", err);
    }
    const reasonText = reason?.trim();
    const reasonLine = reasonText ? `\nReason: ${reasonText}` : "";

    // Always confirm to the seller that the rejection went through — this
    // covers BOTH paths: the "reject now" button (which has a callback
    // query and an original photo caption to edit) and the "add reason"
    // text-message path (which has no callback query, so it needs its own
    // explicit confirmation reply).
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("Rejected");
      await updateSellerOrderMessage(
        ctx,
        `❌ Order #${orderId.slice(0, 8)} rejected${reasonLine}.`,
      );
    } else {
      await ctx.reply(
        `❌ Order #${orderId.slice(0, 8)} rejected${reasonLine}.`,
      );
    }

    const customerChatId = Number(order.customer_telegram_id);
    const custSession = await getSession(customerChatId);

    if (!order.customer_phone) {
      // No phone on file for this customer — ask them to share one so the
      // seller has a direct way to follow up about the rejection.
      pendingPhoneRequestByCustomer.set(customerChatId, orderId);
      custSession.pendingStep = "awaiting_reject_phone" as any;
      await persist(customerChatId, custSession);

      await bot.telegram.sendMessage(
        customerChatId,
        t(
          custSession,
          reasonText
            ? `Your payment was not approved. Reason: ${reasonText}\n\nPlease share your phone number so we can reach out to you directly about this order 📱`
            : `There was an issue verifying your payment.\n\nPlease share your phone number so we can reach out to you directly about this order 📱`,
          reasonText
            ? `ክፍያዎ አልተፈቀደም። ምክንያት፦ ${reasonText}\n\nስለ ትዕዛዝዎ በቀጥታ ልናገኝዎት እንድንችል የስልክ ቁጥርዎን ያጋሩ 📱`
            : `ክፍያዎን ለማረጋገጥ ችግር ገጥሞናል።\n\nስለ ትዕዛዝዎ በቀጥታ ልናገኝዎት እንድንችል የስልክ ቁጥርዎን ያጋሩ 📱`,
        ),
        Markup.keyboard([
          Markup.button.contactRequest(
            t(custSession, "📱 Share phone number", "📱 ስልክ ቁጥር አጋራ"),
          ),
        ])
          .resize()
          .oneTime(),
      );
    } else {
      await bot.telegram.sendMessage(
        customerChatId,
        t(
          custSession,
          reasonText
            ? `Your payment was not approved. Reason: ${reasonText}\n\nWe'll contact you at ${order.customer_phone} shortly. Questions? Call: ${process.env.SELLER_PHONE_NUMBER}`
            : `There was an issue verifying your payment — we'll contact you at ${order.customer_phone} shortly. Questions? Call: ${process.env.SELLER_PHONE_NUMBER}`,
          reasonText
            ? `ክፍያዎ አልተፈቀደም። ምክንያት፦ ${reasonText}\n\nበ ${order.customer_phone} በቅርቡ እናገኝዎታለን። ጥያቄ ካለዎት ይደውሉ፦ ${process.env.SELLER_PHONE_NUMBER}`
            : `ክፍያዎን ለማረጋገጥ ችግር ገጥሞናል — በ ${order.customer_phone} በቅርቡ እናገኝዎታለን። ጥያቄ ካለዎት ይደውሉ፦ ${process.env.SELLER_PHONE_NUMBER}`,
        ),
      );
    }
  } catch (err) {
    console.error("Failed to reject order:", err);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("Something went wrong — please try again.");
      return;
    }
    await ctx.reply("Something went wrong — please try again.");
  }
}

bot.action(/^reject_now_(.+)$/, async (ctx) => {
  if (!isSeller(ctx.from.id)) return ctx.answerCbQuery("Not authorized");
  const orderId = ctx.match[1];
  return rejectOrderWithOptionalReason(ctx, orderId);
});

bot.catch((err, ctx) => {
  console.error(`Unhandled error for update ${ctx.updateType}:`, err);
  ctx.reply("Sorry, something went wrong 🙏 Please try again.").catch(() => {});
});

process.on("unhandledRejection", (reason) =>
  console.error("Unhandled promise rejection:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("Uncaught exception:", err),
);

let started = false;

export function getBotInstance(): Telegraf {
  return bot;
}

export async function processTelegramWebhookUpdate(update: any): Promise<void> {
  await bot.handleUpdate(update);
}

export async function runEscalationNow(): Promise<void> {
  await runEscalationCycle(bot);
}

export async function startBotPolling(): Promise<void> {
  if (started) return;
  started = true;
  startEscalationJob(bot);
  console.log("Attempting bot.launch()...");
  await bot.launch();
  console.log("Bot running in polling mode...");
}

if (BOT_MODE !== "webhook") {
  startBotPolling().catch((err) => {
    console.error("Failed to start bot:", err);
    process.exit(1);
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
