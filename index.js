// /index.js — Fabadel Premium Bot (FINAL – UX RETAINED, PORT 8080)

import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import IntaSendPkg from "intasend-node";

dotenv.config();

// ---------- Express ----------
const app = express();
app.use(express.json());

// ---------- Constants ----------
const SERVER_URL = process.env.SERVER_URL || null;
const BANNER_URL =
  process.env.BANNER_URL ||
  (SERVER_URL ? `${SERVER_URL}/assets/banner.png` : null);

const INTASEND_WEBHOOK_SECRET = process.env.INTASEND_WEBHOOK_SECRET;
const VIP_GROUP_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// ---------- Bot ----------
const bot = new Telegraf(process.env.BOT_TOKEN);

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- IntaSend (FIXED IMPORT) ----------
const { IntaSend } = IntaSendPkg;
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false // live mode
);

// ---------- State ----------
const userState = new Map();

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
      await ctx.replyWithPhoto(
        { url: BANNER_URL },
        {
          caption,
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard().reply_markup
        }
      );
    } else {
      await ctx.reply(caption, {
        parse_mode: "Markdown",
        ...mainMenuKeyboard()
      });
    }
  } catch (err) {
    console.error("Banner error:", err.message);
    await ctx.reply(caption, {
      parse_mode: "Markdown",
      ...mainMenuKeyboard()
    });
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
  await ctx.reply(content, {
    parse_mode: "Markdown",
    ...whatYouGetKeyboard()
  });
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
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(`💳 *Fabadel Premium Plans*

Choose a plan:`, {
    parse_mode: "Markdown",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🇰🇪 KES 299 / Month", "select:kES_299_1m")],
      [Markup.button.callback("🇰🇪 KES 2,999 / Year", "select:kES_2999_12m")],
      [Markup.button.callback("🌍 USD 2.30 / Month", "select:USD_2_30_1m")],
      [Markup.button.callback("🌍 USD 23.00 / Year", "select:USD_23_12m")],
      [Markup.button.callback("🔙 Back", "back_to_menu")]
    ]).reply_markup
  });
});

// ---------- Plan selection ----------
bot.action(/select:(.+)/, async (ctx) => {
  const raw = ctx.match[1];

  const map = {
    kES_299_1m: { id: "kes_1m", label: "KES 299 / Month", amount: 299, currency: "KES" },
    kES_2999_12m: { id: "kes_12m", label: "KES 2,999 / Year", amount: 2999, currency: "KES" },
    USD_2_30_1m: { id: "usd_1m", label: "USD 2.30 / Month", amount: 2.3, currency: "USD" },
    USD_23_12m: { id: "usd_12m", label: "USD 23.00 / Year", amount: 23, currency: "USD" }
  };

  const plan = map[raw];
  if (!plan) return ctx.reply("❌ Unknown plan.");

  await ctx.reply(
    `You selected *${plan.label}*\n\nTap Confirm & Pay to continue.`,
    {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirm & Pay", `confirm:${plan.id}`)],
        [Markup.button.callback("🔙 Choose Another", "explore_plans")],
        [Markup.button.callback("🏠 Main Menu", "back_to_menu")]
      ]).reply_markup
    }
  );
});

// ---------- Confirm ----------
bot.action(/confirm:(.+)/, async (ctx) => {
  userState.set(ctx.from.id, { step: "awaiting_email", plan: ctx.match[1] });
  await ctx.reply("📧 Enter your email to generate your payment link.\n/send /cancel any time.");
});

bot.command("cancel", (ctx) => {
  userState.delete(ctx.from.id);
  ctx.reply("❌ Cancelled.", mainMenuKeyboard());
});

// ---------- Email → Checkout ----------
bot.on("text", async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.step !== "awaiting_email") return;

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

  try {
    const checkout = await intasend.collection().checkout({
      amount,
      currency,
      api_ref,
      customer: { email },
      metadata: { user_id: ctx.from.id, plan },
      redirect_url: `${SERVER_URL}/intasend/callback`
    });

    await ctx.reply("💳 Tap below to pay:", {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url("🟦 Pay Now", checkout.url)],
        [Markup.button.callback("🔙 Main Menu", "back_to_menu")]
      ]).reply_markup
    });
  } catch (err) {
    console.error("IntaSend error:", err);
    await ctx.reply("❌ Payment initiation failed.");
  }
});

// ---------- WEBHOOK ----------
app.post("/intasend/webhook", async (req, res) => {
  if (req.body?.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  if (req.headers["x-intasend-secret"] !== INTASEND_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  if (req.body.state !== "COMPLETE") {
    return res.sendStatus(200);
  }

  const { metadata, tracking_id, api_ref, amount } = req.body;
  const telegram_id = metadata?.user_id;
  const plan = metadata?.plan;
  const payment_ref = tracking_id || api_ref;

  const months = plan.endsWith("1m") ? 1 : 12;
  const end = new Date();
  end.setMonth(end.getMonth() + months);

  await supabase.from("subscriptions").upsert({
    telegram_id,
    plan,
    start_at: new Date().toISOString(),
    end_at: end.toISOString(),
    status: "active",
    payment_ref,
    amount_paid: amount,
    active: true
  });

  await bot.telegram.sendMessage(
    telegram_id,
    `🎉 Payment confirmed!\n\n🔗 Join VIP: ${VIP_GROUP_LINK}`
  );

  res.sendStatus(200);
});

// ---------- Server ----------
app.get("/", (_, res) => res.send("Bot running"));

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

// ---------- Launch bot ----------
bot.launch()
  .then(() => console.log("🤖 Bot launched"))
  .catch((err) => {
    console.error("❌ Bot launch failed (will keep server alive):", err);
  });
