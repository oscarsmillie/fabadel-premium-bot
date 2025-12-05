// /index.js — Fabadel Premium Bot (Final, Fixed & UX Updated)
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import IntaSend from "intasend-node";

dotenv.config();

const app = express();
app.use(express.json());

const SERVER_URL = process.env.SERVER_URL || null;
const BANNER_URL = process.env.BANNER_URL || (SERVER_URL ? `${SERVER_URL}/assets/banner.png` : null);

// --- Initialize Bot ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userState = new Map();
const VIP_GROUP_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// --- IntaSend Config ---
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  true // sandbox mode
);

// ---------- Keyboards ----------
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 Explore Premium Plans", "explore_plans")],
    [Markup.button.callback("📊 Check My Subscription", "check_status")],
    [Markup.button.callback("🎁 What You Get", "what_you_get")],
    [Markup.button.callback("🎯 Success Stories", "success_stories")]
  ]);
}

function whatYouGetKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⭐ View Plans", "explore_plans")],
    [Markup.button.callback("🔙 Back to Menu", "back_to_menu")]
  ]);
}

function plansKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🇰🇪 KES 299 / Month", "select:kES_299_1m")],
    [Markup.button.callback("💼 KES 2,999 / Year (Best Value)", "select:kES_2999_12m")],
    [Markup.button.callback("🌎 USD 2.30 / Month", "select:USD_2_30_1m")],
    [Markup.button.callback("🏆 USD 23.00 / Year", "select:USD_23_12m")],
    [Markup.button.callback("🔙 Back", "back_to_menu")]
  ]);
}

// ---------- START ----------
bot.start(async (ctx) => {
  const firstName = ctx.from?.first_name || "there";
  const caption = `✨ Welcome to *Fabadel Premium*, ${firstName}!

This is your gateway to exclusive career growth:

💎 Hand-Picked Opportunities: Vetted, high-paying jobs across Africa & globally.
📚 Elite Skill Resources: Premium learning modules & AI-powered tools.
🤝 Insider Mentorship: Connect with mentors & a supportive community.

Choose where to begin:`;

  try {
    if (BANNER_URL) {
      await ctx.replyWithPhoto({ url: BANNER_URL }, {
        caption,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard().reply_markup
      });
    } else {
      await ctx.reply(caption, { parse_mode: "Markdown", ...mainMenuKeyboard() });
    }
  } catch (err) {
    console.error("Failed to send start banner:", err.message);
    await ctx.reply(caption, { parse_mode: "Markdown", ...mainMenuKeyboard() });
  }
});

// ---------- What You Get ----------
bot.action("what_you_get", async (ctx) => {
  const content = `💎 *What's Inside Fabadel Premium*

🔹 Exclusive job drops (updated daily)  
🔹 Insider CV templates  
🔹 One-on-one mentorship  
🔹 Weekly premium resources  
🔹 AI-powered career tools  
🔹 Invite to private Telegram community`;

  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(content, { parse_mode: "Markdown", ...whatYouGetKeyboard() });
});

// ---------- Success Stories ----------
bot.action("success_stories", async (ctx) => {
  const stories = `📣 *Success Stories*

• *Aisha* — Landed a remote dev role in 2 weeks  
• *John* — Doubled interview invites after using our CV templates  
• *Grace* — Promoted after career coaching`;

  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(stories, { parse_mode: "Markdown", ...whatYouGetKeyboard() });
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply("Back to the main menu:", { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

// ---------- Explore Plans ----------
bot.action("explore_plans", async (ctx) => {
  const content = `💳 *Fabadel Premium Plans*

Choose a plan that fits your goals 🔥`;
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(content, { parse_mode: "Markdown", ...plansKeyboard() });
});

// ---------- Plan Selection ----------
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

  userState.set(ctx.from.id, { step: "awaiting_email", plan });
  await ctx.reply(`📧 Great choice!\n\nPlease enter your email address so we can create your VIP payment link.`, { parse_mode: "Markdown" });
});

// ---------- Cancel Command ----------
bot.command("cancel", (ctx) => {
  userState.delete(ctx.from.id);
  ctx.reply("❌ Cancelled.", { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

// ---------- Handle Email & Create Payment ----------
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  if (!userState.has(userId)) return;

  const state = userState.get(userId);
  if (state.step !== "awaiting_email") return;

  const email = ctx.message.text.trim();
  if (!email.includes("@")) return ctx.reply("❌ Invalid email.");

  userState.delete(userId);

  const plan = state.plan;
  try {
    const checkout = await intasend.collection().charge({
      amount: plan.amount,
      first_name: ctx.from.first_name || "Telegram",
      last_name: ctx.from.last_name || "User",
      currency: plan.currency,
      api_ref: `${userId}_${Date.now()}`,
      email: email,
      metadata: { user_id: userId, plan: plan.id },
      redirect_url: SERVER_URL ? `${SERVER_URL}/intasend/callback` : null,
      // Optional: Add host if needed for your setup (e.g., for webhooks/callbacks)
      // host: SERVER_URL || 'https://yourdomain.com'
    });

    await ctx.reply("💵 You're almost there! Click the button below to securely complete your payment.", {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url("🟦 Pay Now", checkout.url)],
        [Markup.button.callback("🔙 Main Menu", "back_to_menu")]
      ]).reply_markup
    });
  } catch (err) {
    // This will print the official IntaSend API response to your server console.
    console.error("IntaSend error:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2)); 
    await ctx.reply("⚠️ Payment creation failed. Please try again later. (Error logged)", { parse_mode: "Markdown" });
  }
});

// ---------- Check Subscription ----------
bot.action("check_status", async (ctx) => {
  const userId = ctx.from.id;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return ctx.reply("❌ No active subscription found. Tap below to view plans.", { reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("⭐ View Plans", "explore_plans")]
    ]).reply_markup });
  }

  const statusMsg = `📊 *Subscription Status*\n\nStatus: ${data.status.toUpperCase()}\nExpiry: ${data.expiry_date || "N/A"}\n\n🔥 Thank you for being a Premium Member!\n\n🎁 Join your exclusive VIP group:\n${VIP_GROUP_LINK}`;

  await ctx.reply(statusMsg, { parse_mode: "Markdown" });
});

// ---------- Express Health Check ----------
app.get("/", (req, res) => res.send("Fabadel Premium Bot is running!"));

// ---------- Start Server & Bot ----------
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);

  try {
    await bot.launch(); // Polling mode
    console.log("Bot launched successfully in polling mode!");
  } catch (err) {
    console.error("Bot launch failed:", err);
  }
});
