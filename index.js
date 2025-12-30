// index.js — FINAL VERSION FOR GOOGLE CLOUD RUN (ONLY SERVER FIX APPLIED)

import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import http from "http";
import crypto from "crypto";

dotenv.config();

// ======================================================
// APP SETUP
const app = express();

/**
 * JSON for everything EXCEPT IntaSend webhook (raw body needed)
 */
app.use((req, res, next) => {
  if (req.originalUrl === "/intasend-webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Simple health check route (helps Cloud Run detect startup)
app.get("/", (req, res) => {
  res.send("🚀 Fabadel Premium Bot is alive and running!");
});

// ======================================================
// TELEGRAM
const bot = new Telegraf(process.env.BOT_TOKEN);

// SAFETY: log errors instead of silent failure
bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

// ======================================================
// SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ======================================================
// CONSTANTS
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

const SERVER_URL = process.env.SERVER_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// INTASEND
const INTASEND_CHECKOUT_BASE = process.env.NODE_ENV === "production"
  ? "https://payment.intasend.com/api/v1/checkout/"
  : "https://sandbox.intasend.com/api/v1/checkout/";

const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;

// USD → KES
const USD_TO_KES = 130;

// ======================================================
// STATE
const userState = new Map();

// ======================================================
// KEYBOARDS
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 View Plans", "view_plans")],
    [Markup.button.callback("📊 My Subscription", "check_status")],
    [Markup.button.callback("🎁 Premium Benefits", "what_you_get")],
  ]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Back to Menu", "back_to_menu")],
  ]);
}

// ======================================================
// START
bot.start((ctx) => {
  ctx.reply(
    `👋 Hello ${ctx.from.first_name}!

Welcome to *Fabadel Premium* 🚀

Unlock exclusive access to:
• Curated high-paying job listings
• Premium CV & application templates
• Career guidance resources
• Private community with mentors & networking

Ready to level up your career? Choose an option 👇`,
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
});

// ======================================================
// INFO
bot.action("what_you_get", (ctx) => {
  ctx.editMessageText(
    `🎁 *Premium Benefits*

✅ Daily curated remote & local job opportunities  
✅ Professional CV, cover letter & LinkedIn templates  
✅ Interview prep guides & salary negotiation tips  
✅ Access to private Telegram group with networking & mentorship  
✅ Priority support for applications  

All designed to help you land better jobs faster!`,
    { parse_mode: "Markdown", ...backKeyboard() }
  );
});

bot.action("back_to_menu", (ctx) => {
  ctx.editMessageText("⬅️ Main menu:", { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

// ======================================================
// PLANS
bot.action("view_plans", (ctx) => {
  ctx.editMessageText(
    "💳 Choose your subscription plan:\n\n*Monthly* – Flexible, cancel anytime\n*Annual* – Save ~20%!",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🇰🇪 KES 299 / Month", "kes_1m")],
        [Markup.button.callback("🇰🇪 KES 2,999 / Year (Save 20%)", "kes_12m")],
        [Markup.button.callback("🌍 USD 2.30 / Month", "usd_1m")],
        [Markup.button.callback("🌍 USD 23 / Year (Save 20%)", "usd_12m")],
        [Markup.button.callback("🔙 Back", "back_to_menu")],
      ]),
    }
  );
});

// ======================================================
// ASK EMAIL
bot.action(/(kes|usd)_(1m|12m)/, (ctx) => {
  userState.set(ctx.from.id, { action: ctx.match[0] });
  ctx.editMessageText("📧 Please reply with your email address to continue:");
});

// ======================================================
// EMAIL → INTASEND CHECKOUT
bot.on("text", async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;

  const plan = state.action;
  userState.delete(ctx.from.id);

  const email = ctx.message.text.trim();
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return ctx.reply("❌ Please provide a valid email address.");
  }

  const months = plan.endsWith("1m") ? 1 : 12;

  let amountKES = 0;
  if (plan === "kes_1m") amountKES = 299;
  if (plan === "kes_12m") amountKES = 2999;
  if (plan === "usd_1m") amountKES = Math.round(2.3 * USD_TO_KES);
  if (plan === "usd_12m") amountKES = Math.round(23 * USD_TO_KES);

  const reference = `TG_${ctx.from.id}_${Date.now()}`;

  try {
    const res = await axios.post(
      INTASEND_CHECKOUT_BASE,
      {
        public_key: INTASEND_PUBLISHABLE_KEY,
        amount: amountKES,
        currency: "KES",
        email,
        api_ref: reference,
        redirect_url: `${SERVER_URL}/intasend/callback`,
        metadata: JSON.stringify({
          telegram_id: ctx.from.id,
          plan,
          months,
        }),
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!res.data.url) throw new Error("No checkout URL returned");

    ctx.reply(
      `💳 You're almost there!\n\nAmount: *${amountKES} KES* (${months === 1 ? "Monthly" : "Annual"} plan)\n\nComplete your secure payment below:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.url("💸 Pay Now with IntaSend", res.data.url)],
        ]),
      }
    );
  } catch (err) {
    console.error("IntaSend init error:", err.response?.data || err.message);
    ctx.reply("❌ Sorry, payment setup failed. Please try again later.");
  }
});

// ======================================================
// CHECK STATUS
bot.action("check_status", async (ctx) => {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, end_at")
    .eq("telegram_id", ctx.from.id)
    .single();

  if (error || !data || data.status !== "active") {
    ctx.reply("❌ No active subscription.\nUpgrade now to unlock premium access!", mainMenuKeyboard());
  } else {
    const endDate = new Date(data.end_at).toDateString();
    ctx.reply(
      `✅ *Active Subscription*\n\n🗓 Expires: ${endDate}\n\nEnjoy full access to jobs, templates & community!`,
      { parse_mode: "Markdown", ...mainMenuKeyboard() }
    );
  }
});

// ======================================================
// INTASEND WEBHOOK (CHALLENGE VALIDATION + OPTIONAL SIGNATURE)
app.post(
  "/intasend-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("✅ IntaSend webhook received");

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch (e) {
      console.error("Invalid JSON");
      return res.sendStatus(400);
    }

    // CHALLENGE VALIDATION
    if (event.challenge) {
      const expectedChallenge = process.env.INTASEND_WEBHOOK_CHALLENGE?.trim();
      if (!expectedChallenge || event.challenge !== expectedChallenge) {
        console.warn("Invalid or missing challenge");
        return res.sendStatus(401);
      }
      console.log("Challenge validated");
      return res.sendStatus(200);
    }

    // Optional signature verification
    const signature = req.headers["x-intasend-signature"] || req.headers["x-signature"];
    if (signature && process.env.INTASEND_SECRET_KEY) {
      const expected = crypto
        .createHmac("sha256", process.env.INTASEND_SECRET_KEY)
        .update(req.body)
        .digest("hex");
      if (signature !== expected) {
        console.warn("Invalid webhook signature");
        return res.sendStatus(401);
      }
    }

    // Process only completed payments
    if (event.state !== "COMPLETE" && (!event.invoice || event.invoice.state !== "COMPLETE")) {
      return res.sendStatus(200);
    }

    let metadata;
    try {
      metadata = typeof event.metadata === "string" ? JSON.parse(event.metadata) : event.metadata;
    } catch (e) {
      metadata = {};
    }

    const { telegram_id, plan, months } = metadata || {};
    if (!telegram_id || !plan || !months) {
      console.warn("Missing metadata");
      return res.sendStatus(200);
    }

    const { data: existing } = await supabase
      .from("subscriptions")
      .select("end_at")
      .eq("telegram_id", telegram_id)
      .single();

    let startDate = new Date();
    if (existing?.end_at && new Date(existing.end_at) > startDate) {
      startDate = new Date(existing.end_at);
    }

    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + Number(months));

    await supabase.from("subscriptions").upsert({
      telegram_id,
      plan,
      start_at: new Date().toISOString(),
      end_at: endDate.toISOString(),
      status: "active",
      payment_ref: event.invoice_id || event.tracking_id || event.api_ref,
      amount_paid: event.amount || event.invoice?.value,
      active: true,
    });

    await bot.telegram.sendMessage(
      telegram_id,
      `🎉 Payment successful! Your *Fabadel Premium* subscription is now active.

🗓 Valid until: *${endDate.toDateString()}*

Next steps:
• Join the private group for exclusive jobs & resources
• Check pinned messages for templates & guides

🔗 Join premium group: ${STATIC_INVITE_LINK}

Welcome aboard – let's land your next big opportunity! 🚀`,
      { parse_mode: "Markdown" }
    );

    res.sendStatus(200);
  }
);

// ======================================================
// INTASEND CALLBACK
app.get("/intasend/callback", (req, res) => {
  res.send(`
    <h2>✅ Payment processed!</h2>
    <p>Thank you – your subscription is being activated.</p>
    <p>Return to Telegram for confirmation & private group link.</p>
    <script>
      setTimeout(() => window.location.href = "https://t.me", 5000);
    </script>
  `);
});

// ======================================================
// TELEGRAM WEBHOOK
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

// ======================================================
// SERVER - ONLY CHANGE: FIXED FOR CLOUD RUN
const PORT = process.env.PORT || 8080;

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Server successfully listening on http://0.0.0.0:${PORT}`);

  if (SERVER_URL) {
    try {
      await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
        secret_token: WEBHOOK_SECRET,
      });
      console.log(`Telegram webhook successfully set: ${SERVER_URL}${WEBHOOK_PATH}`);
    } catch (error) {
      console.error("Failed to set Telegram webhook:", error.message);
    }
  } else {
    console.warn("SERVER_URL not set – running in polling mode locally");
  }
});
