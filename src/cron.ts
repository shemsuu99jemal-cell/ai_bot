import cron from "node-cron";
import type { Telegraf } from "telegraf";
import { getPendingVerificationOrders, incrementReminder } from "./db";
import { sendSms } from "./sms";

export async function runEscalationCycle(bot: Telegraf): Promise<void> {
  const stale = await getPendingVerificationOrders(15); // older than 15 min

  for (const order of stale) {
    const count = order.reminder_count || 0;

    if (count === 0) {
      await bot.telegram.sendMessage(
        process.env.SELLER_TELEGRAM_ID!,
        `⏰ Reminder: Order #${order.id.slice(0, 8)} has been waiting >15 min for confirmation. Please check it.`,
      );
      await incrementReminder(order.id, 1);
    } else if (count === 1) {
      await bot.telegram.sendMessage(
        process.env.SELLER_TELEGRAM_ID!,
        `🚨 Still unconfirmed: Order #${order.id.slice(0, 8)} — customer is waiting. Please respond soon.`,
      );
      await incrementReminder(order.id, 2);
    } else if (count === 2) {
      await sendSms(
        process.env.SELLER_PHONE_NUMBER!,
        `Unconfirmed order #${order.id.slice(0, 8)} on your bot — customer waiting. Check Telegram.`,
      );
      await incrementReminder(order.id, 3); // stop re-triggering
    }
  }
}

export function startEscalationJob(bot: Telegraf): void {
  cron.schedule("*/5 * * * *", async () => {
    try {
      await runEscalationCycle(bot);
    } catch (err) {
      console.error("Escalation job error:", err);
    }
  });
}
