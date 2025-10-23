// /index.js - FINAL ROBUST VERSION (FIXED BUTTONS + WEBHOOK ORDER)

import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import crypto from "crypto";
import http from "http";
import cron from "node-cron";
import { kickExpiredUsers } from "./tasks/kickExpiredUsers.js"; // ✅ added import

dotenv.config();

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PREMIUM_GROUP = "-1003189621026";
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "a-new-unique-secret-key-12345";
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
const SERVER_URL = process.env.SERVER_URL;

// ✅ Manual cron trigger endpoint
app.get("/run-cron", async (req, res) => {
  try {
    console.log("⏰ Manual cron trigger initiated...");
    await kickExpiredUsers(bot);
    res.send("✅ Cron job executed successfully!");
  } catch (error) {
    console.error("❌ Error running cron job manually:", error);
    res.status(500).send("Error running cron job manually");
  }
});

// ======================================================
// BOT COMMANDS
// ======================================================
bot.start((ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("💳 View Plans", "view_plans")],
    [Markup.button.callback("📊 Subscription Status", "check_status")],
  ]);

  return ctx.reply(
    `👋 Hello ${ctx.from.first_name}! 
        
Welcome to *Fabadel Premium* 🚀  

Here you can:
💼 Access exclusive job opportunities  
📚 Learn high-value skills from top creators  
💳 Upgrade anytime for full premium access  

Choose an option below to get started.`,
    { parse_mode: "Markdown", ...keyboard }
  );
});

// --- VIEW PLANS ---
bot.action("view_plans", (ctx) => {
  const plansKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("KES 299/Month", "kes_1m")],
    [Markup.button.callback("KES 2,999/Year", "kes_12m")],
    [Markup.button.callback("USD 2.30/Month", "usd_1m")],
    [Markup.button.callback("USD 23.00/Year", "usd_12m")],
  ]);

  return ctx.reply("Select your preferred plan and currency:", plansKeyboard);
});

// --- ASK FOR EMAIL AND INITIATE PAYMENT ---
bot.action(/(kes|usd)_(1m|12m)/, async (ctx) => {
  const plan = ctx.match[0];
  const userId = ctx.from.id;

  await ctx.reply("📧 Please enter your email address for payment:");

  const handler = async (msgCtx) => {
    if (msgCtx.from.id !== userId) return;

    const email = msgCtx.message.text.trim();
    if (!email.includes("@")) return msgCtx.reply("❌ Please provide a valid email address.");

    const amount =
      plan === "kes_1m"
        ? 29900
        : plan === "kes_12m"
        ? 299900
        : plan === "usd_1m"
        ? 230
        : 2300;
    const currency = plan.startsWith("kes") ? "KES" : "USD";

    try {
      const res = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email,
          amount,
          currency,
          metadata: { user_id: userId, plan },
          callback_url: `${SERVER_URL}/paystack/callback`,
        },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
      );

      const payUrl = res.data.data.authorization_url;
      await msgCtx.reply(`💳 Complete your payment here:\n${payUrl}`);
    } catch (err) {
      console.error("Paystack init error:", err);
      await msgCtx.reply("❌ Failed to initialize payment. Please try again.");
    }

    stopListening();
  };

  const stopListening = bot.on("text", handler);
});

// --- CHECK STATUS ---
bot.action("check_status", async (ctx) => {
  const userId = ctx.from.id;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, end_at")
    .eq("telegram_id", userId)
    .single();

  if (error || !data) {
    await ctx.reply("❌ You do not have an active subscription.");
  } else {
    await ctx.reply(
      `✅ Subscription Status: *${data.status.toUpperCase()}*\n🗓 Expires on: ${data.end_at}`,
      { parse_mode: "Markdown" }
    );
  }
});

// --- PAYSTACK WEBHOOK ---
app.post("/paystack/webhook", express.json({ type: "*/*" }), async (req, res) => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const hash = crypto.createHmac("sha512", secret).update(JSON.stringify(req.body)).digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    console.error("❌ Paystack Webhook: Signature mismatch!");
    return res.sendStatus(400);
  }

  const event = req.body;

  if (event.event === "charge.success") {
    const { status, reference, metadata, amount: paidAmount } = event.data;
    const { user_id: telegram_id, plan } = metadata;

    if (status !== "success" || !telegram_id || !plan) {
      return res.sendStatus(200);
    }

    const durationMonths = plan.endsWith("1m") ? 1 : 12;
    const end_at = new Date();
    end_at.setMonth(end_at.getMonth() + durationMonths);

    const { error } = await supabase
      .from("subscriptions")
      .upsert(
        {
          telegram_id: parseInt(telegram_id),
          plan,
          start_at: new Date().toISOString(),
          end_at: end_at.toISOString(),
          status: "active",
          payment_ref: reference,
          amount_paid: paidAmount / 100,
          active: true,
        },
        { onConflict: "telegram_id" }
      );

    if (error) {
      console.error("Supabase upsert error:", error);
    } else {
      console.log(`✅ Subscription created/updated for user ${telegram_id}`);

      try {
        await bot.telegram.sendMessage(
          telegram_id,
          `🎉 Congratulations! Your *${durationMonths}-month* subscription is now active.\n\n` +
            `🔗 Join your premium group here: ${STATIC_INVITE_LINK}`,
          { parse_mode: "Markdown" }
        );
      } catch (msgError) {
        console.error(`❌ Failed to send welcome message to user ${telegram_id}:`, msgError.message);
      }
    }
  }

  res.sendStatus(200);
});

// --- PAYSTACK CALLBACK URL ---
app.get("/paystack/callback", async (req, res) => {
  res.send(
    "Payment complete! Please check your Telegram chat for your subscription confirmation and group invite link."
  );
});

// ======================================================
// WEBHOOK SETUP (Option 1 — REGISTER FIRST)
// ======================================================
if (SERVER_URL) {
  try {
    await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
    });
    console.log(`✅ Telegram Webhook set to: ${SERVER_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error("❌ Failed to set Telegram Webhook. Error:", err.message);
  }
} else {
  console.error("❌ SERVER_URL environment variable is NOT set. Webhook cannot be registered.");
}

// ======================================================
// START SERVER
// ======================================================
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);

  // ✅ Hourly cron job to kick expired users
  cron.schedule(
    "0 * * * *",
    () => {
      kickExpiredUsers(bot);
    },
    {
      scheduled: true,
      timezone: "Etc/UTC",
    }
  );
  console.log("⏰ Expired user kick-off job scheduled to run hourly (0 * * * *).");
});
