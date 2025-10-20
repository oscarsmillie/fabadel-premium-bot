import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

// Initialize Telegram bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- CONSTANTS ---
const PERMANENT_INVITE = "https://t.me/+kSAlgNtLRXJiYWZi";
const PUBLIC_URL = "https://fabadel-premium-bot-production.up.railway.app";

// --- HELPERS ---
const getAmount = (plan) => {
  switch (plan) {
    case "kes_1m": return 29900;
    case "kes_12m": return 299900;
    case "usd_1m": return 230;
    case "usd_12m": return 2300;
    default: return 0;
  }
};

const getCurrency = (plan) => plan.startsWith("kes") ? "KES" : "USD";
const getExpiryDays = (plan) => plan.endsWith("1m") ? 30 : 365;

// --- START COMMAND ---
bot.start(async (ctx) => {
  const startKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📊 Subscription Status", "check_status")],
    [Markup.button.callback("💳 View Plans", "view_plans")],
  ]);

  await ctx.reply(
    `👋 Hey there! Welcome to *Fabadel Premium* 🚀  

Here you can:
💼 Access exclusive job opportunities  
📚 Learn high-value skills from top creators  
💳 Upgrade anytime for full premium access  

Choose an option below to get started.`,
    { parse_mode: "Markdown", ...startKeyboard }
  );
});

// --- VIEW PLANS ---
bot.action("view_plans", async (ctx) => {
  const plansKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🇰🇪 KES Plans", "kes_plans")],
    [Markup.button.callback("💵 USD Plans", "usd_plans")],
  ]);
  await ctx.editMessageText("💳 Choose your currency:", plansKeyboard);
});

// --- KES PLANS ---
bot.action("kes_plans", async (ctx) => {
  const kesKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 Month - KES 299", "kes_1m")],
    [Markup.button.callback("1 Year - KES 2999", "kes_12m")],
  ]);
  await ctx.editMessageText("🇰🇪 *KES Subscription Plans:*", { parse_mode: "Markdown", ...kesKeyboard });
});

// --- USD PLANS ---
bot.action("usd_plans", async (ctx) => {
  const usdKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 Month - $2.3", "usd_1m")],
    [Markup.button.callback("1 Year - $23", "usd_12m")],
  ]);
  await ctx.editMessageText("💵 *USD Subscription Plans:*", { parse_mode: "Markdown", ...usdKeyboard });
});

// --- HANDLE PLAN SELECTION & EMAIL ---
bot.action(/(kes|usd)_(1m|12m)/, async (ctx) => {
  const plan = ctx.match[0];
  const userId = ctx.from.id;

  await ctx.reply("📧 Please enter your email address for payment:");

  // Use 'on' listener instead of once/off
  const emailHandler = async (msgCtx) => {
    if (msgCtx.message.from.id !== userId) return; // only handle the same user
    const email = msgCtx.message.text;

    const amount = getAmount(plan);
    const currency = getCurrency(plan);

    try {
      const res = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email,
          amount,
          currency,
          metadata: { user_id: userId, plan },
          callback_url: `${PUBLIC_URL}/paystack/callback`,
        },
        {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        }
      );

      const payUrl = res.data.data.authorization_url;
      await msgCtx.reply(`💳 Complete your payment here:\n${payUrl}`);

    } catch (err) {
      console.error("Paystack init error:", err.response?.data || err.message);
      await msgCtx.reply("❌ Failed to initialize payment. Please try again.");
    }

    bot.off("text", emailHandler); // remove listener
  };

  bot.on("text", emailHandler);
});

// --- CHECK STATUS ---
bot.action("check_status", async (ctx) => {
  const userId = ctx.from.id;
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, expires_at")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    await ctx.reply("❌ You do not have an active subscription.");
  } else {
    await ctx.reply(`✅ Subscription Status: *${data.status.toUpperCase()}*\n🗓 Expires on: ${data.expires_at}`, { parse_mode: "Markdown" });
  }
});

// --- PAYSTACK CALLBACK ---
app.get("/paystack/callback", async (req, res) => {
  const { reference } = req.query;
  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });

    if (response.data.status && response.data.data.status === "success") {
      const { metadata, amount, currency } = response.data.data;
      const userId = metadata.user_id;
      const plan = metadata.plan;
      const expiryDays = getExpiryDays(plan);

      // Safe upsert: only existing columns
      await supabase.from("subscriptions").upsert({
        user_id: userId,
        plan,
        status: "active",
        payment_ref: reference,
        currency,
        expires_at: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
      });

      // Send permanent invite once
      await bot.telegram.sendMessage(
        userId,
        `🎉 Congratulations! Your Fabadel Premium subscription is now active.\n\nWelcome aboard! 🚀\n\n👉 Join here: ${PERMANENT_INVITE}`
      );

      return res.status(200).send("✅ Payment verified. You can close this window.");
    }

    res.status(400).send("❌ Payment not successful.");
  } catch (error) {
    console.error("Callback verification error:", error);
    res.status(500).send("⚠️ Internal error verifying payment.");
  }
});

// --- PAYSTACK WEBHOOK ---
app.post("/paystack/webhook", express.json({ type: "*/*" }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto.createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) return res.sendStatus(400);

    const event = req.body;
    if (event.event === "charge.success") {
      const { reference, metadata, amount, currency } = event.data;
      const userId = metadata?.user_id;
      const plan = metadata?.plan;

      if (!userId || !plan) return res.sendStatus(400);

      const expiryDays = getExpiryDays(plan);

      await supabase.from("subscriptions").upsert({
        user_id: userId,
        plan,
        status: "active",
        payment_ref: reference,
        currency,
        expires_at: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
      });

      await bot.telegram.sendMessage(
        userId,
        `🎉 Your payment was successful! Fabadel Premium subscription activated.\n\n👉 Join here: ${PERMANENT_INVITE}`
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// --- USE WEBHOOK FOR TELEGRAM ---
app.use(bot.webhookCallback("/telegram"));

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

