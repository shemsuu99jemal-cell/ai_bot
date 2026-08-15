import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { handleMessage } from "./ai";
import {
  supabase,
  createOrderFromCart,
  attachScreenshot,
  setOrderStatus,
  getCategories,
  getProductsByCategory,
  getProduct,
  getRelatedProducts,
  searchProducts,
  getCustomerOrders,
} from "./db";
import { loadSession, saveSession } from "./db";
import { runEscalationCycle, startEscalationJob } from "./cron";
import type { Session, OrderStatus } from "./types";

const REQUIRED_ENV = [
  "BOT_TOKEN",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SELLER_TELEGRAM_ID",
  "SELLER_PAYMENT_INFO",
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

function t(session: Session, en: string, am: string): string {
  return session.language === "am" ? am : en;
}

function mainMenuKeyboard(session: Session): any {
  return Markup.keyboard([
    [t(session, "🛍️ Browse", "🛍️ ካታሎግ"), t(session, "🛒 My Cart", "🛒 ጋሪዬ")],
    [
      t(session, "📦 My Orders", "📦 ትዕዛዜቼ"),
      t(session, "💬 Ask Seller", "💬 ሻጭ ይጠይቁ"),
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
        "Welcome to the shop. Choose what you want next.",
        "ወደ ሱቅ እንኳን ደህና መጡ። ምን ይፈልጋሉ?",
      ),
    mainMenuKeyboard(session),
  );
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
      [
        Markup.button.callback(
          t(session, "✅ Checkout", "✅ ይክፈሉ"),
          "do_checkout",
        ),
      ],
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

    await ctx.reply(lines.join("\n\n"), mainMenuKeyboard(session));
  } catch (err) {
    console.error(`Failed to fetch orders for chat ${ctx.chat.id}:`, err);
    await ctx.reply(friendlyErrorText(session), mainMenuKeyboard(session));
  }
}

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
    await sendMainMenu(ctx, session, t(session, "Main menu", "ዋና ሜኑ"));
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
    Markup.button.callback(c, `cat_${i}`),
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
  const session = await getSession(ctx.chat.id);
  await sendMainMenu(ctx, session, t(session, "Shop menu", "የሱቅ ሜኑ"));
});

bot.command("start", async (ctx) => {
  const session = await getSession(ctx.chat.id);
  await sendMainMenu(ctx, session, t(session, "Main menu", "ዋና ሜኑ"));
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
      [
        Markup.button.callback(
          t(session, "✅ Checkout", "✅ ይክፈሉ"),
          "do_checkout",
        ),
      ],
    ]),
  );
});

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

  const rows = products.map((p: any) => [
    Markup.button.callback(`${p.name} — ${p.price} ETB`, `prod_${p.id}`),
  ]);
  rows.push([
    Markup.button.callback(
      t(session, "🔙 Categories", "🔙 ምድቦች"),
      "back_categories",
    ),
  ]);

  await ctx.reply(
    title || t(session, `Results for “${query}” 🔎`, `ለ “${query}” ውጤቶች 🔎`),
    Markup.inlineKeyboard(rows),
  );
}

async function showProductDetail(
  ctx: any,
  session: Session,
  productId: string,
  selectedColor?: string | null,
): Promise<void> {
  const product = await getProduct(productId).catch(() => null);
  if (!product || product.stock < 1) {
    return ctx.reply(
      t(
        session,
        "Sorry, that's out of stock right now.",
        "ይቅርታ፣ አሁን ክምችት የለውም።",
      ),
    );
  }

  const availableColors = Array.isArray(product.colors)
    ? product.colors.filter(Boolean)
    : product.color
      ? [product.color]
      : [];

  const colorLine = availableColors.length
    ? `🎨 ${t(session, "Colors", "ቀለሞች")}: ${availableColors.join(", ")}`
    : t(session, "🎨 Color: not specified", "🎨 ቀለም: አልተገለጸም");

  const buttons: any[] = [
    [Markup.button.callback(t(session, "🛒 My Cart", "🛒 ጋሪዬ"), "view_cart")],
  ];
  if (availableColors.length > 0) {
    for (let index = 0; index < availableColors.length; index++) {
      const color = availableColors[index];
      buttons.push([
        Markup.button.callback(
          `${color}${selectedColor === color ? " ✅" : ""}`,
          `color_${product.id}_${index}`,
        ),
      ]);
    }
  }

  const chosenColor =
    selectedColor || product.color || availableColors[0] || null;
  const chosenIndex = chosenColor ? availableColors.indexOf(chosenColor) : 0;
  buttons.push([
    Markup.button.callback(
      t(session, "🛒 Add to cart", "🛒 ወደ ጋሪ ጨምር"),
      `add_selected_${product.id}_${chosenIndex >= 0 ? chosenIndex : 0}`,
    ),
  ]);
  buttons.push([
    Markup.button.callback(t(session, "🔙 Back", "🔙 ተመለስ"), "back_categories"),
  ]);

  await ctx.reply(
    `${product.name}\n\n${product.description || t(session, "Premium device for everyday use.", "ለየለይተኛ ጥቅም ለማገልገል ተስማሚ መሣሪያ።")}\n💰 ${t(session, "Price", "ዋጋ")}: ${product.price} ETB\n📦 ${t(session, "Stock", "ክምችት")}: ${product.stock}\n${colorLine}`,
    Markup.inlineKeyboard(buttons),
  );
}

bot.action(/cat_(\d+)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();

  const categories = await getCategories();
  const idx = Number(ctx.match[1]);
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
        "Nothing in stock in that category right now.",
        "በዚህ ምድብ ውስጥ አሁን ምንም ክምችት የለም።",
      ),
    );
  }

  const rows = products.map((p: any) => [
    Markup.button.callback(`${p.name} — ${p.price} ETB`, `prod_${p.id}`),
  ]);
  rows.push([
    Markup.button.callback(
      t(session, "🔙 Categories", "🔙 ምድቦች"),
      "back_categories",
    ),
  ]);

  await ctx.reply(`📦 ${category}`, Markup.inlineKeyboard(rows));
});

bot.action("back_categories", async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  await showCategoryMenu(ctx, session);
});

bot.action(/prod_(.+)/, async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  return showProductDetail(ctx, session, ctx.match[1]);
});

bot.action(/color_(.+)_(\d+)/, async (ctx) => {
  const session = await getSession(ctx.chat!.id);
  await ctx.answerCbQuery();
  const productId = ctx.match[1];
  const product = await getProduct(productId).catch(() => null);
  const availableColors = Array.isArray(product?.colors)
    ? product.colors.filter(Boolean)
    : product?.color
      ? [product.color]
      : [];
  const selectedColor = availableColors[Number(ctx.match[2])] || null;
  return showProductDetail(ctx, session, productId, selectedColor);
});

bot.action(/add_selected_(.+)_(\d+)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();

  const productId = ctx.match[1];
  const product = await getProduct(productId).catch(() => null);
  if (!product || product.stock < 1) {
    return ctx.reply(
      t(
        session,
        "Sorry, that's out of stock right now.",
        "ይቅርታ፣ አሁን ክምችት የለውም።",
      ),
    );
  }

  const availableColors = Array.isArray(product.colors)
    ? product.colors.filter(Boolean)
    : product.color
      ? [product.color]
      : [];
  const chosenIndex = Number(ctx.match[2]) || 0;
  const selectedColor = availableColors[chosenIndex] || product.color || null;

  const existing = session.cart.find(
    (c) => c.product_id === product.id && c.color === selectedColor,
  );
  if (existing) existing.quantity += 1;
  else
    session.cart.push({
      product_id: product.id,
      name: product.name,
      price: product.price,
      quantity: 1,
      color: selectedColor,
    });
  await persist(chatId, session);

  const related = await getRelatedProducts(product.id, 2).catch(() => []);
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
    [
      Markup.button.callback(
        t(session, "✅ Checkout", "✅ ይክፈሉ"),
        "do_checkout",
      ),
    ],
  ];

  if (related.length > 0) {
    buttons.push([
      Markup.button.callback(
        t(session, "✨ You may also like", "✨ እንዲሁም ይመልከቱ"),
        `prod_${related[0].id}`,
      ),
    ]);
  }

  await ctx.reply(
    t(
      session,
      `Added ${product.name}${selectedColor ? ` (${selectedColor})` : ""} ✅\n\nYou may also like: ${related.map((item) => item.name).join(", ") || "more products"}.`,
      `${product.name}${selectedColor ? ` (${selectedColor})` : ""} ታክሏል ✅\n\nእንዲሁም ሊያስወው የሚችሉ ምርቶች፦ ${related.map((item) => item.name).join(", ") || "ተጨማሪ ምርቶች"}.`,
    ),
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
    [
      Markup.button.callback(
        t(session, "✅ Checkout", "✅ ይክፈሉ"),
        "do_checkout",
      ),
    ],
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
        `remove_cart_${item.product_id}`,
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
  const productId = ctx.match[1];
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
            t(session, "✅ Checkout later", "✅ በኋላ ክፍያ ያድርጉ"),
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
      [
        Markup.button.callback(
          t(session, "✅ Checkout", "✅ ይክፈሉ"),
          "do_checkout",
        ),
      ],
    ]),
  );
});

bot.action(/seller_q_(.+)/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = await getSession(chatId);
  await ctx.answerCbQuery();
  const productId = ctx.match[1];
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
  if (!session.customerPhone) return askPhone(ctx, session);
  if (!session.deliveryLocation) return askDeliveryChoice(ctx, session);
  return finalizeOrder(chatId, session, customerName);
}

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
    `Order created ✅\n\n${breakdown}\n\nPlease pay to:\n${process.env.SELLER_PAYMENT_INFO}\n\nThen send a screenshot of the payment right here to confirm your order.\n\nCheck status anytime with /orders. Questions? Call: ${process.env.SELLER_PHONE_NUMBER}`,
    `ትዕዛዝዎ ተፈጥሯል ✅\n\n${breakdown}\n\nክፍያ ይፈጽሙ፦\n${process.env.SELLER_PAYMENT_INFO}\n\nከዚያ የክፍያ ደረሰኝዎን ስክሪንሾት እዚሁ ይላኩ።\n\nደረጃውን በማንኛውም ጊዜ /orders ይመልከቱ። ጥያቄ ካለዎት ይደውሉ፦ ${process.env.SELLER_PHONE_NUMBER}`,
  );

  await bot.telegram.sendMessage(chatId, payMsg, Markup.removeKeyboard());
}

// ---- /start ----
bot.start(async (ctx) => {
  await ctx.reply(
    "Welcome! Please choose your language / እባክዎ ቋንቋ ይምረጡ:",
    Markup.inlineKeyboard([
      Markup.button.callback("English", "lang_en"),
      Markup.button.callback("አማርኛ", "lang_am"),
    ]),
  );
});

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
    return finalizeOrder(chatId, session, customerName);
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

  if (!session.language) {
    return ctx.reply("Please tap /start first to choose a language.");
  }

  const customerName = ctx.from.first_name || ctx.from.username || "Customer";
  const text = ctx.message.text;

  if (isSeller(ctx.from.id)) {
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
      await finalizeOrder(chatId, session, customerName);
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

  const casualGreeting = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|how\s+are\s+you|how\s+are\s+you\s+doing|what'?s\s+up|what\s+bout\s+my\s+cart|what\s+about\s+my\s+cart|thanks|thank\s+you|help|can\s+you\s+help|yo)\b/i;
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

  const cartLookUp = /(?:what\s+bout\s+my\s+cart|what\s+about\s+my\s+cart|show\s+my\s+cart|view\s+cart|check\s+my\s+cart|my\s+cart|cart\s+please)/i;
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

// ---- photo messages: payment screenshot ----
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
bot.action(/confirm_(.+)/, async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.SELLER_TELEGRAM_ID))
    return ctx.answerCbQuery("Not authorized");
  try {
    const orderId = ctx.match[1];
    const order = await setOrderStatus(orderId, "confirmed");
    await ctx.answerCbQuery("Confirmed");
    await ctx.editMessageCaption(
      (ctx.callbackQuery as any).message.caption + "\n\n✅ CONFIRMED",
    );
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
    const reasonText = reason?.trim();
    const reasonLine = reasonText ? `\nReason: ${reasonText}` : "";

    // Always confirm to the seller that the rejection went through — this
    // covers BOTH paths: the "reject now" button (which has a callback
    // query and an original photo caption to edit) and the "add reason"
    // text-message path (which has no callback query, so it needs its own
    // explicit confirmation reply).
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("Rejected");
      try {
        await ctx.editMessageCaption(
          (ctx.callbackQuery as any).message.caption +
            `\n\n❌ REJECTED${reasonLine}`,
        );
      } catch (err) {
        console.error("Failed to edit caption on reject:", err);
        await ctx.reply(
          `❌ Order #${orderId.slice(0, 8)} rejected${reasonLine}.`,
        );
      }
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
