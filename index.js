// /index.js — PAYSTACK (KENYA + USD) CLOUD RUN READY (FIXED)

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

// IMPORTANT:
// Use JSON parser for everything EXCEPT Paystack webhook
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);

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

// PAYSTACK
const PAYSTACK_API_BASE = "https://api.paystack.co";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// USD → KES (fixed rate)
const USD_TO_KES = 130;

// ======================================================
// STATE
const userState = new Map();

// ======================================================
// KEYBOARDS (UNCHANGED UX)
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 View Plans", "view_plans")],
    [Markup.button.callback("📊 Subscription Status", "check_status")],
    [Markup.button.callback("🎁 What You Get", "what_you_get")],
    [Markup.button.callback("🎯 Success Stories", "success_stories")]
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

Here you can:
💼 Access exclusive job opportunities
📚 Learn high-value skills
🎯 See real success stories
💳 Upgrade anytime for premium access

Choose an option below 👇`,
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
});

// ======================================================
// INFO PAGES
bot.action("what_you_get", (ctx) =>
  ctx.reply(
`🎁 *What You Get with Fabadel Premium*

✅ Curated job opportunities  
✅ Premium CV & cover letter templates  
✅ Career growth resources  
✅ AI-powered tools  
✅ Private Telegram community`,
    { parse_mode: "Markdown", ...backKeyboard() }
  )
);

bot.action("success_stories", (ctx) =>
  ctx.reply(
`🎯 *Success Stories*

⭐ Aisha — Remote job in 3 weeks  
⭐ Kevin — Doubled interview invites  
⭐ Mary — Career switch success`,
    { parse_mode: "Markdown", ...backKeyboard() }
  )
);

bot.action("back_to_menu", (ctx) =>
  ctx.reply("⬅️ Back to main menu:", mainMenuKeyboard())
);

// ======================================================
// PLANS
bot.action("view_plans", (ctx) => {
  ctx.reply(
    "💳 Select your preferred plan:",
    Markup.inlineKeyboard([
      [Markup.button.callback("KES 299 / Month", "kes_1m")],
      [Markup.button.callback("KES 2,999 / Year", "kes_12m")],
      [Markup.button.callback("USD 2.30 / Month", "usd_1m")],
      [Markup.button.callback("USD 23.00 / Year", "usd_12m")],
      [Markup.button.callback("🔙 Back", "back_to_menu")]
    ])
  );
});

// ======================================================
// ASK EMAIL
bot.action(/(kes|usd)_(1m|12m)/, (ctx) => {
  userState.set(ctx.from.id, ctx.match[0]);
  ctx.reply("📧 Please enter your email address for payment:");
});

// ======================================================
// EMAIL → PAYSTACK
bot.on("text", async (ctx) => {
  if (!userState.has(ctx.from.id)) return;

  const plan = userState.get(ctx.from.id);
  userState.delete(ctx.from.id);

  const email = ctx.message.text.trim();
  if (!email.includes("@")) return ctx.reply("❌ Invalid email.");

  let amountKES = 0;
  const months = plan.endsWith("1m") ? 1 : 12;

  if (plan === "kes_1m") amountKES = 299;
  if (plan === "kes_12m") amountKES = 2999;
  if (plan === "usd_1m") amountKES = Math.round(2.3 * USD_TO_KES);
  if (plan === "usd_12m") amountKES = Math.round(23 * USD_TO_KES);

  const reference = `TG_${ctx.from.id}_${Date.now()}`;

  try {
    const res = await axios.post(
      `${PAYSTACK_API_BASE}/transaction/initialize`,
      {
        email,
        amount: amountKES * 100,
        currency: "KES",
        reference,
        metadata: {
          telegram_id: ctx.from.id,
          plan,
          months
        },
        callback_url: `${SERVER_URL}/paystack/callback`
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    ctx.reply("💳 Complete payment:", {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url("Pay Now", res.data.data.authorization_url)]
      ]).reply_markup
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    ctx.reply("❌ Payment initialization failed.");
  }
});

// ======================================================
// CHECK STATUS
bot.action("check_status", async (ctx) => {
  const { data } = await supabase
    .from("subscriptions")
    .select("status, end_at")
    .eq("telegram_id", ctx.from.id)
    .single();

  if (!data)
    ctx.reply("❌ No active subscription.");
  else
    ctx.reply(
      `✅ Status: *${data.status}*\n🗓 Expires: ${data.end_at}`,
      { parse_mode: "Markdown" }
    );
});

// ======================================================
// PAYSTACK WEBHOOK (RAW BODY REQUIRED)
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];

    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) {
      console.error("❌ Invalid Paystack signature");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === "charge.success") {
      const data = event.data;
      const { telegram_id, plan, months } = data.metadata || {};

      if (!telegram_id) return res.sendStatus(200);

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
        payment_ref: data.reference,
        amount_paid: data.amount / 100,
        active: true
      });

      await bot.telegram.sendMessage(
        telegram_id,
        `🎉 Subscription active!\n🗓 Valid until: ${endDate.toDateString()}\n🔗 Join: ${STATIC_INVITE_LINK}`
      );
    }

    res.sendStatus(200);
  }
);

// ======================================================
app.get("/paystack/callback", (_, res) =>
  res.send("Payment successful. Return to Telegram.")
);

// ======================================================
// TELEGRAM WEBHOOK BOOTSTRAP
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;

app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

const PORT = process.env.PORT || 8080;
http.createServer(app).listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (SERVER_URL) {
    await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
      secret_token: WEBHOOK_SECRET
    });
  }
});
