// index.js — INTASEND (KENYA + USD) CLOUD RUN READY (FIXED + IMPROVED UX)

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
 * JSON for everything EXCEPT IntaSend webhook
 */
app.use((req, res, next) => {
  if (req.originalUrl === "/intasend-webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
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
const PREMIUM_GROUP = "@FabadelPremiumGroup";
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

const SERVER_URL = process.env.SERVER_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// INTASEND
const INTASEND_API_BASE = "https://payment.intasend.com/api/v1/checkout/"; // Live endpoint (switch to sandbox for testing)
const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;

// USD → KES (current approx rate as of Dec 2025)
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
    [Markup.button.callback("🔙 Back to Menu", "back_to_menu")]
  ]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Back to Menu", "back_to_menu")]
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
• Private community with mentors

Ready to level up your career? Choose an option 👇`,
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
});

// ======================================================
// INFO (IMPROVED CONTENT - REMOVED SUCCESS STORIES)
bot.action("what_you_get", (ctx) =>
  ctx.editMessageText(
    `🎁 *Premium Benefits*

✅ Daily curated remote & local job opportunities  
✅ Professional CV, cover letter & LinkedIn templates  
✅ Interview prep guides & salary negotiation tips  
✅ Access to private Telegram group with networking & mentorship  
✅ Priority support for applications  

All designed to help you land better jobs faster!`,
    { parse_mode: "Markdown", ...backKeyboard() }
  )
);

bot.action("back_to_menu", (ctx) =>
  ctx.editMessageText("⬅️ Main menu:", { parse_mode: "Markdown", ...mainMenuKeyboard() })
);

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
        [Markup.button.callback("🔙 Back", "back_to_menu")]
      ])
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
// EMAIL → INTASEND CHECKOUT (FIXED)
bot.on("text", async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== ctx.match?.[0]?.match(/(kes|usd)_(1m|12m)/)?.[0]) return; // Simple safety

  const plan = state.action;
  userState.delete(ctx.from.id);

  const email = ctx.message.text.trim();
  if (!email.includes("@") || !email.includes(".")) {
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
      INTASEND_API_BASE,
      {
        public_key: INTASEND_PUBLISHABLE_KEY,
        amount: amountKES,
        currency: "KES",
        email,
        api_ref: reference, // Used for tracking
        redirect_url: `${SERVER_URL}/intasend/callback?tg_id=${ctx.from.id}`,
        metadata: JSON.stringify({
          telegram_id: ctx.from.id,
          plan,
          months
        })
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    if (!res.data.url) throw new Error("No checkout URL returned");

    ctx.reply(
      `💳 You're almost there!\n\nAmount: *${amountKES} KES* (${months === 1 ? "Monthly" : "Annual"} plan)\n\nComplete your secure payment below:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.url("💸 Pay Now with IntaSend", res.data.url)]
        ])
      }
    );
  } catch (err) {
    console.error("IntaSend init error:", err.response?.data || err.message);
    ctx.reply("❌ Sorry, payment setup failed. Please try again later or contact support.");
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
    ctx.reply("❌ You don't have an active subscription yet.\nUpgrade now to unlock premium access!", mainMenuKeyboard());
  } else {
    const endDate = new Date(data.end_at).toDateString();
    ctx.reply(
      `✅ *Active Subscription*\n\n🗓 Expires: ${endDate}\n\nEnjoy full access to jobs, templates & community!`,
      { parse_mode: "Markdown", ...mainMenuKeyboard() }
    );
  }
});

// ======================================================
// INTASEND WEBHOOK (IMPROVED SECURITY + ROBUSTNESS)
app.post(
  "/intasend-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("✅ IntaSend webhook received");

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch (e) {
      return res.sendStatus(400);
    }

    // Basic signature verification (IntaSend sends X-IntaSend-Signature header with HMAC-SHA256)
    const signature = req.headers["x-intasend-signature"];
    if (signature) {
      const expected = crypto.createHmac("sha256", process.env.INTASEND_SECRET_KEY || "")
        .update(req.body)
        .digest("hex");
      if (signature !== expected) {
        console.warn("Invalid webhook signature");
        return res.sendStatus(401);
      }
    } else {
      console.warn("No signature header - consider enabling in IntaSend dashboard");
    }

    if (event.state !== "COMPLETE") {
      return res.sendStatus(200);
    }

    let metadata;
    try {
      metadata = typeof event.metadata === "string" ? JSON.parse(event.metadata) : event.metadata;
    } catch (e) {
      return res.sendStatus(200);
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
      payment_ref: event.invoice_id || event.tracking_id,
      amount_paid: event.amount,
      active: true
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
// INTASEND CALLBACK (USER REDIRECT AFTER PAYMENT)
app.get("/intasend/callback", (req, res) => {
  const tgId = req.query.tg_id;
  res.send(`
    <h2>✅ Payment processed!</h2>
    <p>Thank you – your subscription is being activated.</p>
    <p>Return to Telegram and check your messages for confirmation & group link.</p>
    ${tgId ? `<script>window.location.href = "https://t.me/yourbotusername";</script>` : ""}
  `);
});

// ======================================================
// TELEGRAM WEBHOOK
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

// ======================================================
// SERVER
const PORT = process.env.PORT || 8080;

http.createServer(app).listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (SERVER_URL) {
    await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
      secret_token: WEBHOOK_SECRET
    });
    console.log(`Webhook set: ${SERVER_URL}${WEBHOOK_PATH}`);
  }
});
