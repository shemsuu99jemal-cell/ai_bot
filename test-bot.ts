import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");

import "dotenv/config";
import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN!);

bot.start((ctx) => ctx.reply("pong"));

console.log("About to launch...");
bot
  .launch()
  .then(() => console.log("Launched successfully!"))
  .catch((err) => console.error("Launch failed:", err));

console.log(
  "launch() call issued (this line runs immediately, launch() is async)",
);
