// index.js
import express from "express";
import bodyParser from "body-parser";
import NodeTelegramBotApi from "node-telegram-bot-api";
import axios from "axios";
import crypto from "crypto";
import dayjs from "dayjs";
import { createClient } from "@supabase/supabase-js";

// --- ENV ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // numeric - your public group id
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// Plan amounts
const PAYMENT_AMOUNT_KES_MONTHLY = 299;
const PAYMENT_AMOUNT_USD_MONTHLY = 2.3;
const PAYMENT_AMOUNT_KES_YEARLY = 2999;
const PAYMENT_AMOUNT_USD_YEARLY = 23;

// --- Supabase ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// --- Telegram Bot ---
const bot = new NodeTelegramBotApi(TELEGRAM_BOT_TOKEN, { polling: true });

// --- Express Server ---
const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- Helper Functions ---

async function createPaystackTransaction(email, amount, currency, telegramId, plan) {
  const minorAmount = Math.round(amount * 100);
  const payload = {
    email,
    amount: minorAmount,
    currency,
    metadata: {
      telegram_id: telegramId,
      plan
    }
  };
  const res = await axios.post("https://api.paystack.co/transaction/initialize", payload, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
  });
  return res.data;
}

async function verifyPaystackTransaction(reference) {
  const res = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
  });
  return res.data;
}

async function createInviteLink(chatId, expireSeconds = 60 * 60 * 24) {
  const expireDate = Math.floor(Date.now() / 1000) + expireSeconds;
  const res = await bot.createChatInviteLink(chatId, { expire_date: expireDate, member_limit: 1 });
  return res;
}

async function upsertSubscription(telegramId, username, reference, months = 1) {
  const { data: existing } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("telegram_id", telegramId)
    .limit(1)
    .maybeSingle();

  const now = dayjs();
  const newEnd = existing && existing.end_at && existing.end_at > now.toISOString()
    ? dayjs(existing.end_at).add(months, "month")
    : now.add(months, "month");

  if (existing) {
    const { error } = await supabase
      .from("subscriptions")
      .update({
        paystack_reference: reference,
        start_at: now.toISOString(),
        end_at: newEnd.toISOString(),
        active: true,
        telegram_username: username
      })
      .eq("id", existing.id);
    if (error) throw error;
    return { action: "updated", end_at: newEnd.toISOString() };
  } else {
    const { error } = await supabase
      .from("subscriptions")
      .insert([{
        telegram_id: telegramId,
        telegram_username: username,
        paystack_reference: reference,
        plan: "monthly",
        start_at: now.toISOString(),
        end_at: newEnd.toISOString(),
        active: true
      }]);
    if (error) throw error;
    return { action: "created", end_at: newEnd.toISOString() };
  }
}

async function removeUserFromGroup(chatId, telegramId) {
  try {
    await bot.kickChatMember(chatId, telegramId);
    await bot.unbanChatMember(chatId, telegramId, { only_if_banned: true });
    await supabase.from("subscriptions").update({ active: false }).eq("telegram_id", telegramId);
  } catch (err) {
    console.error("Error removing user", telegramId, err);
  }
}

async function checkExpiredAndRemove() {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("active", true)
    .lte("end_at", new Date().toISOString());
  if (error) return console.error(error);
  for (const sub of data) await removeUserFromGroup(TELEGRAM_CHAT_ID, sub.telegram_id);
}

// --- Telegram Commands ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Status", callback_data: "status" }, { text: "Plans", callback_data: "plans" }]
      ]
    }
  };
  await bot.sendMessage(chatId, "Welcome to Fabadel Premium! Access educational content, courses, and job posts here.", keyboard);
});

// Callback for inline buttons
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const username = query.from.username || `${query.from.first_name || ""} ${query.from.last_name || ""}`;

  if (query.data === "status") {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("telegram_id", telegramId)
      .limit(1)
      .maybeSingle();
    if (!sub) {
      await bot.sendMessage(chatId, "You do not have an active subscription.");
    } else {
      await bot.sendMessage(chatId, `Your subscription is active until ${sub.end_at}. Plan: ${sub.plan}`);
    }
  }

  if (query.data === "plans") {
    const text = "Select your preferred plan and currency:";
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Monthly KES 299", callback_data: "plan_monthly_kes" }, { text: "Monthly $2.3", callback_data: "plan_monthly_usd" }],
          [{ text: "Yearly KES 2,999", callback_data: "plan_yearly_kes" }, { text: "Yearly $23", callback_data: "plan_yearly_usd" }]
        ]
      }
    };
    await bot.sendMessage(chatId, text, keyboard);
  }

  // Payment buttons
  if (query.data.startsWith("plan_")) {
    let amount = 0, currency = "KES", planName = "";
    switch (query.data) {
      case "plan_monthly_kes": amount = PAYMENT_AMOUNT_KES_MONTHLY; currency = "KES"; planName = "Monthly"; break;
      case "plan_monthly_usd": amount = PAYMENT_AMOUNT_USD_MONTHLY; currency = "USD"; planName = "Monthly"; break;
      case "plan_yearly_kes": amount = PAYMENT_AMOUNT_KES_YEARLY; currency = "KES"; planName = "Yearly"; break;
      case "plan_yearly_usd": amount = PAYMENT_AMOUNT_USD_YEARLY; currency = "USD"; planName = "Yearly"; break;
    }

    await bot.sendMessage(chatId, "Please reply with your email to complete payment.");
    bot.once("message", async (emailMsg) => {
      const email = emailMsg.text.trim();
      try {
        const payRes = await createPaystackTransaction(email, amount, currency, telegramId, planName);
        // Save pending subscription
        await supabase.from("subscriptions").upsert([{
          telegram_id: telegramId,
          telegram_username: username,
          paystack_reference: payRes.data.reference,
          plan: planName,
          start_at: new Date().toISOString(),
          end_at: new Date().toISOString(),
          active: false
        }], { onConflict: ["telegram_id"] });

        await bot.sendMessage(chatId, `Payment link: ${payRes.data.authorization_url}`);
      } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, "Failed to create payment. Try again later.");
      }
    });
  }
});

// --- Paystack Webhook ---
app.post("/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const hmac = crypto.createHmac("sha512", PAYSTACK_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  if (signature !== hmac.digest("hex")) return res.status(400).send("Invalid signature");

  const event = req.body;
  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("paystack_reference", reference)
      .limit(1)
      .maybeSingle();
    if (!sub) return res.status(200).send("ok");

    // Update subscription
    const months = sub.plan === "Yearly" ? 12 : 1;
    const up = await upsertSubscription(sub.telegram_id, sub.telegram_username || "", reference, months);

    // Create invite link
    const invite = await createInviteLink(TELEGRAM_CHAT_ID, 60 * 60 * 24 * 3);
    const inviteUrl = invite.invite_link || invite.result?.invite_link || invite.link || invite;

    try {
      await bot.sendMessage(sub.telegram_id, `Payment confirmed ✅\nYour access is active until ${up.end_at}.\nJoin using this link:\n${inviteUrl}`);
    } catch (err) {
      console.error(err);
    }
  }
  res.status(200).send("ok");
});

// Health check
app.get("/", (req, res) => res.send("Fabadel Premium bot running"));

// Start server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
setInterval(checkExpiredAndRemove, 12 * 60 * 60 * 1000); // check every 12h
