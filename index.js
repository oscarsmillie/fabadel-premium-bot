// index.js
import express from "express";
import bodyParser from "body-parser";
import NodeTelegramBotApi from "node-telegram-bot-api";
import axios from "axios";
import crypto from "crypto";
import dayjs from "dayjs";
import { createClient } from "@supabase/supabase-js";

// --- Environment variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const PORT = process.env.PORT || 3000;
const PAYMENT_CURRENCY = process.env.PAYMENT_CURRENCY || "KES";
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 720);

// --- Plans ---
const PLANS = {
  monthly: { label: "Monthly", amountKES: 299, amountUSD: 2.3, months: 1 },
  quarterly: { label: "3 Months", amountKES: 799, amountUSD: 6.2, months: 3 },
  semiannual: { label: "6 Months", amountKES: 1499, amountUSD: 11.5, months: 6 },
  yearly: { label: "Yearly", amountKES: 2999, amountUSD: 23, months: 12 },
};

// --- Init checks ---
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PAYSTACK_SECRET_KEY) {
  console.error("❌ Missing required env vars.");
  process.exit(1);
}

// --- Init Supabase ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// --- Init Telegram Bot ---
const bot = new NodeTelegramBotApi(TELEGRAM_BOT_TOKEN, { polling: true });

// --- Express server for webhooks ---
const app = express();
app.use(bodyParser.json({
  verify: function (req, res, buf) {
    req.rawBody = buf;
  }
}));

// --- Helper: Create Paystack Transaction ---
async function createPaystackTransaction(email, amount, currency = PAYMENT_CURRENCY, metadata = {}) {
  const payload = {
    email: email || "no-reply@fabadel.example",
    amount: Math.round(amount * 100),
    currency,
    metadata,
  };

  const res = await axios.post("https://api.paystack.co/transaction/initialize", payload, {
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  return res.data;
}

// --- Helper: Verify Paystack Transaction ---
async function verifyPaystackTransaction(reference) {
  const res = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });
  return res.data;
}

// --- Helper: Create Telegram Invite Link ---
async function createInviteLink(chatId, expireSeconds = 60 * 60 * 24 * 3) {
  const expireDate = Math.floor(Date.now() / 1000) + expireSeconds;
  const res = await bot.createChatInviteLink(chatId, { expire_date: expireDate, member_limit: 1 });
  return res.invite_link;
}

// --- Helper: Upsert Subscription ---
async function upsertSubscription(telegramId, username, reference, months = 1, plan = "monthly") {
  const now = dayjs();
  const newEnd = now.add(months, "month").toISOString();

  const { error } = await supabase.from("subscriptions").upsert([{
    telegram_id: telegramId,
    telegram_username: username,
    paystack_reference: reference,
    plan,
    start_at: now.toISOString(),
    end_at: newEnd,
    active: true,
  }], { onConflict: ["telegram_id"] });

  if (error) throw error;
  return newEnd;
}

// --- Commands ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const welcome = `👋 *Welcome to Fabadel Premium!*\n\nYour gateway to exclusive updates, premium insights, and content that keeps you ahead.\n\nSelect an option below to continue 👇`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💳 View Plans", callback_data: "view_plans" },
          { text: "📊 Check My Status", callback_data: "check_status" },
        ],
      ],
    },
    parse_mode: "Markdown",
  };

  bot.sendMessage(chatId, welcome, keyboard);
});

// --- Inline Button Handling ---
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const username = query.from.username || `${query.from.first_name || ""} ${query.from.last_name || ""}`.trim();

  if (query.data === "view_plans") {
    const planButtons = Object.entries(PLANS).map(([key, plan]) => [
      {
        text: `${plan.label} – KES ${plan.amountKES} / $${plan.amountUSD}`,
        callback_data: `subscribe_${key}`,
      },
    ]);

    return bot.sendMessage(chatId, "Choose your plan 👇", {
      reply_markup: { inline_keyboard: planButtons },
    });
  }

  if (query.data.startsWith("subscribe_")) {
    const planKey = query.data.replace("subscribe_", "");
    const plan = PLANS[planKey];
    if (!plan) return bot.sendMessage(chatId, "Invalid plan selected.");

    try {
      const pseudoEmail = `${username.replace(/[^a-zA-Z0-9]/g, "") || "user"}@fabadel.example`;

      const payRes = await createPaystackTransaction(pseudoEmail, plan.amountKES, PAYMENT_CURRENCY, {
        telegram_id: telegramId,
        plan: plan.label,
      });

      const { authorization_url, reference } = payRes.data;

      await supabase.from("subscriptions").upsert([{
        telegram_id: telegramId,
        telegram_username: username,
        paystack_reference: reference,
        plan: plan.label,
        start_at: new Date().toISOString(),
        end_at: new Date().toISOString(),
        active: false,
      }], { onConflict: ["telegram_id"] });

      bot.sendMessage(chatId, `🧾 You chose *${plan.label}* plan.\n\nPlease complete payment using the link below:\n${authorization_url}`, { parse_mode: "Markdown" });

    } catch (err) {
      console.error("Payment init error:", err);
      bot.sendMessage(chatId, "⚠️ Could not create payment link. Try again later.");
    }
  }

  if (query.data === "check_status") {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("telegram_id", telegramId)
      .maybeSingle();

    if (error || !data) return bot.sendMessage(chatId, "No active subscription found.");

    const active = data.active && dayjs(data.end_at).isAfter(dayjs());
    const status = active ? "🟢 *Active*" : "🔴 *Expired*";

    const msgText = `Your Subscription Status:\n\n${status}\nPlan: ${data.plan}\nExpires: ${dayjs(data.end_at).format("YYYY-MM-DD")}`;

    bot.sendMessage(chatId, msgText, { parse_mode: "Markdown" });
  }
});

// --- Paystack Webhook ---
app.post("/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const hmac = crypto.createHmac("sha512", PAYSTACK_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const computed = hmac.digest("hex");

  if (signature !== computed) return res.status(400).send("Invalid signature");

  const event = req.body;
  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const telegram_id = event.data.metadata?.telegram_id;

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("paystack_reference", reference)
      .maybeSingle();

    if (!sub) return res.status(200).send("ok");

    const months = PLANS[sub.plan.toLowerCase()]?.months || 1;
    const end_at = await upsertSubscription(telegram_id, sub.telegram_username, reference, months, sub.plan);

    const invite = await createInviteLink(TELEGRAM_CHAT_ID);
    bot.sendMessage(telegram_id, `✅ Payment confirmed!\nYour access is active until ${end_at}.\nJoin using this link:\n${invite}`);
  }

  res.status(200).send("ok");
});

// --- Health Check ---
app.get("/", (req, res) => res.send("Fabadel Premium bot is running ✅"));

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
