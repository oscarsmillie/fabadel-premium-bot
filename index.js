// /index.js - Cloud Run-ready with upgraded Premium UX + IntaSend SDK
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import http from "http";
import fs from "fs";
import path from "path";
import IntaSend from "intasend-node";

dotenv.config();

const app = express();
app.use(express.json());

// Serve static assets if present (for banner image)
const assetsDir = path.join(process.cwd(), "assets");
if (fs.existsSync(assetsDir)) app.use("/assets", express.static(assetsDir));

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userState = new Map();
const PREMIUM_GROUP = "@FabadelPremiumGroup";
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
const SERVER_URL = process.env.SERVER_URL;
const BANNER_URL = process.env.BANNER_URL || (SERVER_URL ? `${SERVER_URL}/assets/banner.png` : null);

// --- INTASEND SDK CONFIG ---
const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;
const INTASEND_SECRET_KEY = process.env.INTASEND_SECRET_KEY;
const INTASEND_WEBHOOK_SECRET = process.env.INTASEND_WEBHOOK_SECRET;

const intasend = new IntaSend(
  INTASEND_PUBLISHABLE_KEY,
  INTASEND_SECRET_KEY,
  true // sandbox: true | production: false
);

// ---------- Utility: main menu keyboard ----------
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✨ What You Get", "what_you_get")],
    [Markup.button.callback("💳 Explore Plans", "explore_plans")],
    [Markup.button.callback("📊 My Subscription", "check_status")],
    [Markup.button.callback("🎯 Success Stories", "success_stories")]
  ]);
}

// ---------- START ----------
bot.start(async (ctx) => {
  const firstName = ctx.from?.first_name || "there";
  const caption = `✨ Welcome to *Fabadel Premium*, ${firstName}!

Your gateway to exclusive:
🔥 High-paying job opportunities
📚 Premium learning resources
🚀 Career growth & mentorship

Choose where to begin:`;

  try {
    if (BANNER_URL) {
      await ctx.replyWithPhoto({ url: BANNER_URL }, {
        caption,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard().reply_markup
      });
    } else {
      await ctx.reply(caption, mainMenuKeyboard());
    }
  } catch (err) {
    console.error("Failed to send start banner:", err.message);
    await ctx.reply(caption, mainMenuKeyboard());
  }
});

// ---------- What You Get ----------
bot.action("what_you_get", async (ctx) => {
  const content = `💎 *What's inside Fabadel Premium*

🔹 Exclusive job drops (daily)
🔹 High-converting CV templates
🔹 One-on-one career mentorship
🔹 Weekly premium resource packs
🔹 AI tools for applications
🔹 Invite to private community`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⭐ View Plans", "explore_plans")],
    [Markup.button.callback("🔙 Back", "back_to_menu")]
  ]);

  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(content, { parse_mode: "Markdown", ...keyboard });
});

// ---------- Success Stories ----------
bot.action("success_stories", async (ctx) => {
  const stories = `📣 *Success Stories*

• *Aisha* — Landed a remote dev role in 2 weeks.
• *John* — Doubled interview invites after our CV template.
• *Grace* — Promoted after interview coaching.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⭐ View Plans", "explore_plans")],
    [Markup.button.callback("🔙 Back", "back_to_menu")]
  ]);

  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(stories, { parse_mode: "Markdown", ...keyboard });
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply("Back to the main menu:", mainMenuKeyboard());
});

// ---------- Explore Plans ----------
bot.action("explore_plans", async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🇰🇪 KES 299 / Month", "select:kES_299_1m")],
    [Markup.button.callback("🇰🇪 KES 2,999 / Year", "select:kES_2999_12m")],
    [Markup.button.callback("🌍 USD 2.30 / Month", "select:USD_2_30_1m")],
    [Markup.button.callback("🌍 USD 23.00 / Year", "select:USD_23_12m")],
    [Markup.button.callback("🔙 Back", "back_to_menu")]
  ]);

  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(`💳 *Fabadel Premium Plans*

Choose a plan:`, { parse_mode: "Markdown", ...keyboard });
});

// ---------- Plan selection ----------
bot.action(/select:(.+)/, async (ctx) => {
  const raw = ctx.match[1];

  const map = {
    "kES_299_1m": { id: "kes_1m", label: "KES 299 / Month", amount: 299, currency: "KES" },
    "kES_2999_12m": { id: "kes_12m", label: "KES 2,999 / Year", amount: 2999, currency: "KES" },
    "USD_2_30_1m": { id: "usd_1m", label: "USD 2.30 / Month", amount: 2.3, currency: "USD" },
    "USD_23_12m": { id: "usd_12m", label: "USD 23.00 / Year", amount: 23, currency: "USD" }
  };

  const plan = map[raw];
  if (!plan) return ctx.reply("❌ Unknown plan.");

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm & Pay", `confirm:${plan.id}`)],
    [Markup.button.callback("🔙 Choose Another", "explore_plans")],
    [Markup.button.callback("🏠 Main Menu", "back_to_menu")]
  ]);

  await ctx.reply(`You selected *${plan.label}*

Tap Confirm & Pay to continue.`, { parse_mode: "Markdown", ...keyboard });
});

// ---------- Confirm → ask email ----------
bot.action(/confirm:(.+)/, async (ctx) => {
  const planId = ctx.match[1];
  userState.set(ctx.from.id, { step: "awaiting_email", plan: planId });
  await ctx.reply(`📧 Enter your email to generate your payment link.
/send /cancel any time.`);
});

bot.command("cancel", (ctx) => {
  userState.delete(ctx.from.id);
  ctx.reply("❌ Cancelled.", mainMenuKeyboard());
});

// ---------- Handle email → create checkout ----------
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  if (!userState.has(userId)) return;

  const state = userState.get(userId);
  if (state.step !== "awaiting_email") return;

  const email = ctx.message.text.trim();
  if (!email.includes("@")) return ctx.reply("❌ Invalid email.");

  userState.delete(userId);

  const plan = state.plan;
  const amount = plan === "kes_1m" ? 299 : plan === "kes_12m" ? 2999 : plan === "usd_1m" ? 2.3 : 23;
  const currency = plan.startsWith("kes") ? "KES" : "USD";
  const unique_ref = `${userId}_${Date.now()}`;

  try {
    const checkout = await intasend.collection.createCheckout({
      amount,
      currency,
      api_ref: unique_ref,
      customer: { email },
      metadata: { user_id: userId, plan },
      redirect_url: `${SERVER_URL}/intasend/callback`
    });

    const payUrl = checkout.url;
    if (!payUrl) return ctx.reply("❌ Payment link creation failed.");

    await ctx.reply("💳 Tap below to pay:", {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url("🟦 Pay Now", payUrl)],
        [Markup.button.callback("🔙 Main Menu", "back_to_menu")]
      ]).reply_markup
    });
  } catch (err) {
    console.error("IntaSend error:", err);
    await ctx.reply("❌ Payment initiation failed. Try again later.");
  }
});

// ---------- Launch bot ----------
bot.launch().then(() => console.log("Bot launched."));

// ---------- Express fallback for health check ----------
app.get("/", (req, res) => res.send("Bot is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
