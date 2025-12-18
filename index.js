// /index.js - INTASEND MIGRATION (Cloud Run-ready)
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import http from "http";

dotenv.config();

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userState = new Map();
const PREMIUM_GROUP = "@FabadelPremiumGroup";
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// Webhook Configuration
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || "a-strong-secret-key-you-must-set";
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
const SERVER_URL = process.env.SERVER_URL;

// INTASEND CONFIG
const INTASEND_API_BASE = "https://api.intasend.com/api/v1";
const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;
const INTASEND_SECRET_KEY = process.env.INTASEND_SECRET_KEY;
const INTASEND_WEBHOOK_SECRET = process.env.INTASEND_WEBHOOK_SECRET;

// ======================================================
// UX KEYBOARDS
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
// KICK-OFF FUNCTION
async function kickExpiredUsers() {
  const { data: expiredUsers } = await supabase
    .from("subscriptions")
    .select("telegram_id, end_at")
    .eq("status", "active")
    .lt("end_at", new Date().toISOString());

  if (!expiredUsers?.length) return;

  const kickedIds = [];

  await Promise.all(
    expiredUsers.map(async (user) => {
      try {
        await bot.telegram.banChatMember(PREMIUM_GROUP, user.telegram_id, {
          until_date: Math.floor(Date.now() / 1000) + 300
        });
        await bot.telegram.unbanChatMember(
          PREMIUM_GROUP,
          user.telegram_id
        );
        kickedIds.push(user.telegram_id);
      } catch {}
    })
  );

  if (kickedIds.length) {
    await supabase
      .from("subscriptions")
      .update({ status: "expired", active: false })
      .in("telegram_id", kickedIds);
  }
}

app.get("/api/kick-expired", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET)
    return res.sendStatus(401);
  await kickExpiredUsers();
  res.send("Done");
});

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
// WHAT YOU GET
bot.action("what_you_get", (ctx) => {
  ctx.reply(
`🎁 *What You Get with Fabadel Premium*

✅ Curated job opportunities  
✅ Premium CV & cover letter templates  
✅ Career growth resources  
✅ AI-powered tools  
✅ Private Telegram community`,
    { parse_mode: "Markdown", ...backKeyboard() }
  );
});

// ======================================================
// SUCCESS STORIES
bot.action("success_stories", (ctx) => {
  ctx.reply(
`🎯 *Success Stories*

⭐ Aisha — Remote job in 3 weeks  
⭐ Kevin — Doubled interview invites  
⭐ Mary — Career switch success  

You could be next 🚀`,
    { parse_mode: "Markdown", ...backKeyboard() }
  );
});

// ======================================================
// BACK TO MENU
bot.action("back_to_menu", (ctx) => {
  ctx.reply("⬅️ Back to main menu:", mainMenuKeyboard());
});

// ======================================================
// VIEW PLANS
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
// EMAIL → INTASEND
bot.on("text", async (ctx) => {
  if (!userState.has(ctx.from.id)) return;

  const plan = userState.get(ctx.from.id);
  userState.delete(ctx.from.id);

  const email = ctx.message.text.trim();
  if (!email.includes("@")) return ctx.reply("❌ Invalid email.");

  const amount =
    plan === "kes_1m" ? 299 :
    plan === "kes_12m" ? 2999 :
    plan === "usd_1m" ? 2.3 : 23;

  const currency = plan.startsWith("kes") ? "KES" : "USD";
  const api_ref = `${ctx.from.id}_${Date.now()}`;

  try {
    const res = await axios.post(
      `${INTASEND_API_BASE}/checkout/`,
      {
        public_key: INTASEND_PUBLISHABLE_KEY,
        amount,
        currency,
        api_ref,
        customer: { email },
        metadata: { user_id: ctx.from.id, plan },
        redirect_url: `${SERVER_URL}/intasend/callback`
      },
      { headers: { Authorization: `token ${INTASEND_SECRET_KEY}` } }
    );

    ctx.reply("💳 Complete payment:", {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url("Pay Now", res.data.url)]
      ]).reply_markup
    });
  } catch {
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

  if (!data) ctx.reply("❌ No active subscription.");
  else
    ctx.reply(
      `✅ Status: *${data.status}*\n🗓 Expires: ${data.end_at}`,
      { parse_mode: "Markdown" }
    );
});

// ======================================================
// INTASEND WEBHOOK
app.post("/intasend/webhook", async (req, res) => {
  if (req.body?.challenge)
    return res.json({ challenge: req.body.challenge });

  if (req.headers["x-intasend-secret"] !== INTASEND_WEBHOOK_SECRET)
    return res.sendStatus(401);

  if (req.body.state === "COMPLETE") {
    const { metadata, tracking_id, api_ref, amount } = req.body;
    const months = metadata.plan.endsWith("1m") ? 1 : 12;

    const end = new Date();
    end.setMonth(end.getMonth() + months);

    await supabase.from("subscriptions").upsert({
      telegram_id: metadata.user_id,
      plan: metadata.plan,
      start_at: new Date().toISOString(),
      end_at: end.toISOString(),
      status: "active",
      payment_ref: tracking_id || api_ref,
      amount_paid: amount,
      active: true
    });

    await bot.telegram.sendMessage(
      metadata.user_id,
      `🎉 Subscription active!\n🔗 Join: ${STATIC_INVITE_LINK}`
    );
  }

  res.sendStatus(200);
});

// ======================================================
app.get("/intasend/callback", (_, res) =>
  res.send("Payment complete. Return to Telegram.")
);

// ======================================================
async function registerWebhook() {
  if (!SERVER_URL) return;
  await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
    secret_token: WEBHOOK_SECRET
  });
}

app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

const PORT = process.env.PORT || 8080;
http.createServer(app).listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  registerWebhook();
});
