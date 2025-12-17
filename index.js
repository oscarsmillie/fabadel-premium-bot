// /index.js — Fabadel Premium Bot (FINAL, WORKING)
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import IntaSend from "intasend-node";

dotenv.config();

const app = express();
app.use(express.json());

const SERVER_URL = process.env.SERVER_URL;
const BANNER_URL = process.env.BANNER_URL || (SERVER_URL ? `${SERVER_URL}/assets/banner.png` : null);

// --- Bot & DB ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userState = new Map();
const VIP_GROUP_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// --- IntaSend ---
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false
);

const INTASEND_WEBHOOK_SECRET = process.env.INTASEND_WEBHOOK_SECRET;

// ---------- Keyboards ----------
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 Explore Premium Plans", "explore_plans")],
    [Markup.button.callback("📊 Check My Subscription", "check_status")],
    [Markup.button.callback("🎁 What You Get", "what_you_get")]
  ]);
}

// ---------- START ----------
bot.start(async (ctx) => {
  const name = ctx.from?.first_name || "there";
  const caption = `✨ Welcome to *Fabadel Premium*, ${name}!

Your gateway to exclusive career growth.

Choose where to begin 👇`;

  if (BANNER_URL) {
    await ctx.replyWithPhoto({ url: BANNER_URL }, {
      caption,
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard().reply_markup
    });
  } else {
    await ctx.reply(caption, { parse_mode: "Markdown", ...mainMenuKeyboard() });
  }
});

// ---------- Plans ----------
bot.action("explore_plans", async (ctx) => {
  await ctx.reply(
    "💳 *Choose a plan:*",
    {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("KES 299 / Month", "select:kes_1m")],
        [Markup.button.callback("KES 2,999 / Year", "select:kes_12m")],
        [Markup.button.callback("USD 2.30 / Month", "select:usd_1m")],
        [Markup.button.callback("USD 23 / Year", "select:usd_12m")]
      ]).reply_markup
    }
  );
});

// ---------- Select plan ----------
bot.action(/select:(.+)/, async (ctx) => {
  const plan = ctx.match[1];
  userState.set(ctx.from.id, { step: "email", plan });
  await ctx.reply("📧 Enter your email to continue:");
});

// ---------- Email → Checkout ----------
bot.on("text", async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.step !== "email") return;

  const email = ctx.message.text.trim();
  if (!email.includes("@")) return ctx.reply("❌ Invalid email.");

  userState.delete(ctx.from.id);

  const plan = state.plan;
  const amount =
    plan === "kes_1m" ? 299 :
    plan === "kes_12m" ? 2999 :
    plan === "usd_1m" ? 2.3 : 23;

  const currency = plan.startsWith("kes") ? "KES" : "USD";
  const api_ref = `${ctx.from.id}_${Date.now()}`;

  const checkout = await intasend.collection().checkout({
    amount,
    currency,
    api_ref,
    customer: { email },
    metadata: { user_id: ctx.from.id, plan },
    redirect_url: `${SERVER_URL}/intasend/callback`
  });

  await ctx.reply("💳 Pay using the link below:", {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.url("🟦 Pay Now", checkout.url)]
    ]).reply_markup
  });
});

// ---------- CHECK STATUS ----------
bot.action("check_status", async (ctx) => {
  const { data } = await supabase
    .from("subscriptions")
    .select("status, end_at")
    .eq("telegram_id", ctx.from.id)
    .single();

  if (!data) return ctx.reply("❌ No active subscription.");
  ctx.reply(`✅ Status: *${data.status}*\n📅 Expires: ${data.end_at}`, { parse_mode: "Markdown" });
});

// ---------- INTASEND WEBHOOK ----------
app.post("/intasend/webhook", async (req, res) => {

  // Echo challenge if sent (safe)
  if (req.body?.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const secret = req.headers["x-intasend-secret"];
  if (secret !== INTASEND_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const event = req.body;
  if (event.state !== "COMPLETE") return res.sendStatus(200);

  const { metadata, tracking_id, api_ref, amount } = event;
  const telegram_id = metadata?.user_id;
  const plan = metadata?.plan;
  const payment_ref = tracking_id || api_ref;

  // Idempotency
  const { data: exists } = await supabase
    .from("subscriptions")
    .select("payment_ref")
    .eq("payment_ref", payment_ref)
    .single();

  if (exists) return res.sendStatus(200);

  const months = plan.endsWith("1m") ? 1 : 12;
  const end_at = new Date();
  end_at.setMonth(end_at.getMonth() + months);

  await supabase.from("subscriptions").upsert({
    telegram_id,
    plan,
    start_at: new Date().toISOString(),
    end_at: end_at.toISOString(),
    status: "active",
    payment_ref,
    amount_paid: amount,
    active: true
  }, { onConflict: "telegram_id" });

  await bot.telegram.sendMessage(
    telegram_id,
    `🎉 Subscription activated!\n🔗 Join: ${VIP_GROUP_LINK}`
  );

  res.sendStatus(200);
});

// ---------- Callback ----------
app.get("/intasend/callback", (_, res) =>
  res.send("Payment received. Check Telegram!")
);

// ---------- Launch ----------
bot.launch();
app.get("/", (_, res) => res.send("Bot running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
