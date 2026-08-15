import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { searchProducts, getProduct } from "./db";
import type { Session, AiResult, CartItem } from "./types";

const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});
const geminiClient = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
});

// ---- provider selection ----
// Amharic → Gemini, English → Groq. Language is decided purely from local
// Unicode script detection (see detectLanguage below) — no AI call is ever
// made just to figure out which provider to use.
type ProviderChoice = {
  client: OpenAI;
  model: string;
  name: "gemini" | "groq";
};

function providerFor(language: "en" | "am"): ProviderChoice {
  return language === "am"
    ? { client: geminiClient, model: "gemini-2.5-flash", name: "gemini" }
    : { client: groqClient, model: "llama-3.3-70b-versatile", name: "groq" };
}

// Gemini is the fallback for both directions: if Groq (English) is
// rate-limited we fail over to Gemini; if Gemini (Amharic) is itself
// rate-limited there's nowhere left to fail over to, so we surface the
// friendly error instead.
function fallbackProvider(): ProviderChoice {
  return { client: geminiClient, model: "gemini-2.5-flash", name: "gemini" };
}

function isRateLimited(err: any): boolean {
  return err?.status === 429;
}

const AMHARIC_CHAR = /[\u1200-\u137F]/g;

function detectLanguage(text: string): "en" | "am" | "unknown" {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return "unknown";
  const amharicChars = (text.match(AMHARIC_CHAR) || []).length;
  const ratio = amharicChars / letters.length;
  // Mixed-language messages: Amharic wins whenever it's the dominant script.
  if (ratio > 0.4) return "am";
  if (ratio === 0 && /[a-zA-Z]/.test(text)) return "en";
  return "unknown";
}

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search the catalog for a specific product the customer named. Always call fresh — never reuse an earlier price.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_categories",
      description:
        "Call this when the customer's request is broad/browsing rather than a specific product — e.g. 'what do you have', 'show me phones', 'what's available'. Shows a tappable category menu instead of guessing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description:
        "Add a product the customer clearly chose. After this, ask if they want anything else or to checkout.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string" },
          quantity: { type: "integer" },
        },
        required: ["product_id", "quantity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_cart",
      description: "Show the customer their cart and running total.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "show_customer_orders",
      description:
        "Use when the customer asks where their order is, wants an order status, or asks to see their recent orders. Shows exact order history/status without guessing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_cart",
      description:
        "Remove one item from the cart by product_id or clear the whole cart when all=true.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string" },
          all: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout",
      description:
        "Call ONLY when the customer explicitly confirms they're done and want to pay. Requires a non-empty cart.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_seller",
      description:
        "Call for anything uncertain: refunds, warranty, delivery time, discounts, complaints, or anything you don't confidently know. Never guess.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

// Trimmed to the essentials — every extra sentence here is resent on every
// single turn, so keeping this lean directly cuts token cost and latency.
function systemPrompt(language: "en" | "am", customerName?: string): string {
  const langLine =
    language === "am"
      ? "Reply in Amharic, matching the customer's current message language."
      : "Reply in English, matching the customer's current message language.";
  const nameLine = customerName
    ? `Customer's name: ${customerName} (use it occasionally, not every message).`
    : "";

  return `You're a warm, concise sales assistant for a phone/electronics shop on Telegram. Sound human, not scripted. 1-2 emojis max per message.

- Specific product asked about → search_products (never reuse old prices).
- Broad/browsing request ("what do you have", "show me phones") → show_categories, don't guess.
- Customer picks a product+qty → add_to_cart, then ask what's next.
- If the customer specifies a preferred color and the item has a matching color option, keep it on the cart item.
- If the customer wants to remove something from the cart, use remove_from_cart.
- After add_to_cart, you may suggest ONE relevant accessory via search_products — skip if nothing fits, never invent products.
- Customer confirms they're done → checkout. Never call it unprompted.
- If the customer asks where their order is, wants order status, asks to track an order, or asks to see recent orders → show_customer_orders. This is a high-priority intent and must not be confused with cart actions.
- Never call view_cart when the customer is asking about an order status, order location, or tracking. view_cart is only for cart review.
- Anything uncertain (refunds, warranty, delivery time, discounts) → ask_seller, never guess.
- Ambiguous request → ask one short clarifying question (color/budget/new-used).

Prices in ETB. ${nameLine}
${langLine}`;
}

function cartSummary(cart: CartItem[]): string {
  if (cart.length === 0) return "Cart is empty.";
  const lines = cart.map(
    (i) => `${i.name} x${i.quantity} = ${i.price * i.quantity} ETB`,
  );
  const total = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return `${lines.join("\n")}\nTotal: ${total} ETB`;
}

// Lowered from 40 — history is resent in full every turn, so this is the
// single biggest lever on both token cost and response latency.
const MAX_HISTORY_MESSAGES = 16;
function trimHistory(history: any[]): any[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  const system = history[0];
  const recent = history.slice(history.length - (MAX_HISTORY_MESSAGES - 1));
  let start = 0;
  while (start < recent.length && recent[start].role === "tool") start++;
  return [system, ...recent.slice(start)];
}

function parseInlineToolAction(text: string): AiResult | null {
  if (!text) return null;

  const clean = text.replace(/<[^>]+>/g, "").trim();
  if (
    !clean ||
    /^(hi|hello|hey|good\s+(morning|afternoon|evening)|how\s+are\s+you|how\s+are\s+you\s+doing|what'?s\s+up|what\s+bout\s+my\s+cart|what\s+about\s+my\s+cart|thanks|thank\s+you|help|i\s+need\s+help|can\s+you\s+help|what\s+can\s+you\s+do|ya|yo)\b/i.test(clean)
  ) {
    return null;
  }

  const match =
    text.match(/<function\s*=\s*([a-z_]+)\s*>/i) ||
    text.match(/function\s*=\s*([a-z_]+)/i);
  if (!match) return null;

  const toolName = match[1].toLowerCase();

  if (toolName === "show_categories") {
    return { action: "show_categories" };
  }

  if (toolName === "show_customer_orders") {
    return { action: "show_customer_orders" };
  }

  if (toolName === "checkout") {
    return { action: "checkout" };
  }

  if (toolName === "ask_seller") {
    const question =
      text.replace(/<[^>]+>/g, "").trim() || "Customer asked a question.";
    return { action: "ask_seller", question };
  }

  return null;
}

export async function handleMessage(
  session: Session,
  userText: string,
  customerName?: string,
): Promise<AiResult> {
  const langMatch = userText
    .trim()
    .toLowerCase()
    .match(
      /^(?:\/lang|lang|language)[:\s]+(en|am|english|amharic|አማርኛ)$|switch to (english|amharic)/i,
    );
  if (langMatch) {
    const token = (langMatch[1] || langMatch[2] || "").toString().toLowerCase();
    const newLang =
      token.startsWith("a") ||
      token === "am" ||
      token === "amharic" ||
      token === "አማርኛ"
        ? "am"
        : "en";
    session.language = newLang as any;
    return {
      action: "reply",
      text:
        newLang === "am"
          ? "ቋንቋ ወደ አማርኛ ተቀይሯል። እንኳን እንዴት ልርዳዎት? 😊"
          : "Language switched to English. How can I help? 😊",
    };
  }

  // Local, cost-free language detection — no AI call involved.
  const detected = detectLanguage(userText);
  if (detected !== "unknown" && detected !== session.language) {
    session.language = detected;
  }

  const sys = {
    role: "system",
    content: systemPrompt(session.language, customerName),
  };
  if (session.history.length === 0) session.history.push(sys as any);
  else session.history[0] = sys as any;
  session.history.push({ role: "user", content: userText });

  for (let i = 0; i < 5; i++) {
    const provider = providerFor(session.language);
    // Provider-selection log — provider/language only, never message
    // content, customer name, or API keys.
    console.log(`[AI] provider=${provider.name} lang=${session.language}`);

    let response;
    try {
      response = await callWithRetry(
        provider.client,
        provider.model,
        session.history,
        provider.name,
      );
    } catch (err) {
      console.error(
        "[AI] call failed after retries/fallback:",
        (err as any)?.message || err,
      );
      session.history.pop();
      return {
        action: "reply",
        text:
          session.language === "am"
            ? "ይቅርታ፣ ትንሽ ችግር ገጠመኝ 🙏 እባክዎ እንደገና ይሞክሩ።"
            : "Sorry, I hit a hiccup there 🙏 Could you try that again?",
      };
    }

    const msg = response.choices[0].message;
    session.history.push(msg as any);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const inlineToolAction = parseInlineToolAction(msg.content || "");
      if (inlineToolAction) {
        session.history = trimHistory(session.history);
        return inlineToolAction;
      }

      session.history = trimHistory(session.history);
      return {
        action: "reply",
        text:
          msg.content ||
          (session.language === "am"
            ? "ይቅርታ፣ እንደገና መድገም ይችላሉ?"
            : "Sorry, could you rephrase that?"),
      };
    }

    let pendingAction: AiResult | null = null;

    for (const call of msg.tool_calls) {
      let args: any = {};
      try {
        args = call.function.arguments
          ? JSON.parse(call.function.arguments)
          : {};
      } catch {
        session.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "Could not parse arguments." }),
        } as any);
        continue;
      }

      try {
        if (call.function.name === "search_products") {
          const products = await searchProducts(args.query);
          session.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(
              products.map((p) => ({
                id: p.id,
                name: p.name,
                price: p.price,
                stock: p.stock,
                description: p.description,
              })),
            ),
          } as any);
        } else if (call.function.name === "show_categories") {
          session.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true }),
          } as any);
          pendingAction = { action: "show_categories" };
        } else if (call.function.name === "add_to_cart") {
          const product = await getProduct(args.product_id);
          if (!product || product.stock < args.quantity) {
            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: "Not enough stock available." }),
            } as any);
          } else {
            const existing = session.cart.find(
              (c) => c.product_id === product.id,
            );
            if (existing) existing.quantity += args.quantity;
            else
              session.cart.push({
                product_id: product.id,
                name: product.name,
                price: product.price,
                quantity: args.quantity,
              });

            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                added: product.name,
                cart: cartSummary(session.cart),
              }),
            } as any);
          }
        } else if (call.function.name === "view_cart") {
          session.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: cartSummary(session.cart),
          } as any);
        } else if (call.function.name === "show_customer_orders") {
          session.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true }),
          } as any);
          pendingAction = { action: "show_customer_orders" };
        } else if (call.function.name === "remove_from_cart") {
          if (args.all) {
            session.cart = [];
            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ ok: true, cleared: true }),
            } as any);
          } else if (args.product_id) {
            const before = session.cart.length;
            session.cart = session.cart.filter(
              (item) => item.product_id !== args.product_id,
            );
            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: true,
                removed: before !== session.cart.length,
              }),
            } as any);
          } else {
            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: "No item specified." }),
            } as any);
          }
        } else if (call.function.name === "checkout") {
          if (session.cart.length === 0) {
            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                error: "Cart is empty, cannot checkout.",
              }),
            } as any);
          } else {
            session.history.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ ok: true }),
            } as any);
            pendingAction = { action: "checkout" };
          }
        } else if (call.function.name === "ask_seller") {
          session.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true, forwarded: true }),
          } as any);
          pendingAction = { action: "ask_seller", question: args.question };
        } else {
          session.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "Unknown tool." }),
          } as any);
        }
      } catch (err) {
        console.error(`Tool "${call.function.name}" failed:`, err);
        session.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error: "Something went wrong on our end, please try again.",
          }),
        } as any);
      }
    }

    if (pendingAction) {
      session.history = trimHistory(session.history);
      return pendingAction;
    }
  }

  session.history = trimHistory(session.history);
  return {
    action: "reply",
    text:
      session.language === "am"
        ? "አንድ በአንድ እንሂድ — ምን ይፈልጋሉ? 😊"
        : "Let's take that one step at a time — what would you like? 😊",
  };
}

async function callWithRetry(
  client: OpenAI,
  model: string,
  history: any[],
  providerName: "gemini" | "groq",
  attempt = 1,
): Promise<any> {
  try {
    return await client.chat.completions.create({
      model,
      messages: history as ChatCompletionMessageParam[],
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    });
  } catch (err: any) {
    console.error(
      `[AI] ${providerName} call failed (attempt ${attempt}, status=${err?.status ?? "n/a"})`,
    );

    // Any 429 (per-minute or daily quota) → fail over to the other
    // provider once instead of hammering a rate-limited endpoint.
    if (isRateLimited(err)) {
      const fb = fallbackProvider();
      if (providerName !== fb.name) {
        console.log(
          `[AI] ${providerName} rate-limited — falling back to ${fb.name}`,
        );
        return await callWithRetry(fb.client, fb.model, history, fb.name, 1);
      }
      // Already on the fallback provider and still rate-limited — nothing
      // left to try. Let the caller show the friendly "try again" message.
      console.error(
        `[AI] ${providerName} (fallback) also rate-limited — giving up gracefully`,
      );
      throw err;
    }

    // Transient/server errors → retry the same provider a couple of times.
    if (attempt < 3 && (err?.status === 400 || err?.status >= 500)) {
      console.log(`[AI] ${providerName} retrying (attempt ${attempt})...`);
      await new Promise((r) => setTimeout(r, 300 * attempt));
      return await callWithRetry(
        client,
        model,
        history,
        providerName,
        attempt + 1,
      );
    }
    throw err;
  }
}
