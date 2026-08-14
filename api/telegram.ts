import "dotenv/config";
import { processTelegramWebhookUpdate } from "../src/index";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, message: "Telegram webhook endpoint" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (configuredSecret) {
    const incoming = req.headers["x-telegram-bot-api-secret-token"];
    if (incoming !== configuredSecret) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
  }

  try {
    await processTelegramWebhookUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook update handling failed:", err);
    res.status(500).json({ ok: false });
  }
}
