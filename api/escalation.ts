import "dotenv/config";
import { runEscalationNow } from "../src/index";

function isAuthorized(req: any): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = String(req.headers.authorization || "");
  return auth === `Bearer ${secret}`;
}

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  try {
    await runEscalationNow();
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Escalation endpoint failed:", err);
    res.status(500).json({ ok: false });
  }
}
