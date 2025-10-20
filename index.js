import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Replace with your group/channel username or numeric ID
const PREMIUM_GROUP = "@FabadelPremiumGroup"; 

// ======================================================
// >>> NEW CODE: KICK-OFF FUNCTION (For External Scheduler) <<<
// ======================================================

/**
 * Checks for expired users in the database and kicks them from the Telegram group.
 * This function should be called by an external scheduler (e.g., cron job, Edge Function).
 * * NOTE: The kicking action (bot.telegram.banChatMember) will only work if the bot 
 * is an administrator in the PREMIUM_GROUP.
 */
async function kickExpiredUsers() {
    console.log("Starting kickExpiredUsers job...");
    
    // 1. Get expired but still active users
    const { data: expiredUsers, error } = await supabase
        .from("subscriptions")
        .select("telegram_id")
        .eq("active", true)
        .lt("end_at", new Date().toISOString()); // end_at is before now

    if (error) {
        console.error("Supabase query error for kick-off:", error);
        return;
    }
    
    if (!expiredUsers || expiredUsers.length === 0) {
        console.log("No users found to kick.");
        return;
    }

    console.log(`Found ${expiredUsers.length} users to kick.`);

    const kickPromises = expiredUsers.map(async (user) => {
        try {
            // Telegram API to kick the user.
            // NOTE: This actually "bans" them, which prevents rejoining until unbanned.
            // If you want to only "unrestrict" (remove), the process is more complex.
            await bot.telegram.banChatMember(PREMIUM_GROUP, user.telegram_id);
            
            // You might want to unban them immediately so they can rejoin later, 
            // but the primary action is banChatMember to remove them.
            // await bot.telegram.unbanChatMember(PREMIUM_GROUP, user.telegram_id);

            console.log(`Successfully kicked user: ${user.telegram_id}`);
            return user.telegram_id;
        } catch (kickError) {
            console.error(`Failed to kick user ${user.telegram_id}:`, kickError.message);
            return null;
        }
    });

    // Wait for all kick promises to resolve
    const kickedIds = (await Promise.all(kickPromises)).filter(id => id !== null);

    // 2. You will handle the Supabase SQL update externally to mark them as active=false.
    // For now, we'll log the IDs you need to update:
    if (kickedIds.length > 0) {
         console.log(`Kicked IDs: [${kickedIds.join(', ')}]. Now run your SQL update to set active=false.`);
    }

    console.log("Kick-off job finished.");
}

// Example of how you might expose this as an API endpoint for an external cron service
app.get("/api/kick-expired", async (req, res) => {
    // Add secret key check here if exposing publicly
    await kickExpiredUsers();
    res.status(200).send("Kick-off process initiated.");
});

// ======================================================
// >>> END NEW CODE <<<
// ======================================================


// --- START COMMAND ---
bot.start(async (ctx) => {
  const startKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📊 Subscription Status", "check_status")],
    [Markup.button.callback("💳 View Plans", "view_plans")],
  ]);

  await ctx.reply(
    `👋 Hey there! Welcome to *Fabadel Premium* 🚀  

Here you can:
💼 Access exclusive job opportunities  
📚 Learn high-value skills from top creators  
💳 Upgrade anytime for full premium access  

Choose an option below to get started.`,
    { parse_mode: "Markdown", ...startKeyboard }
  );
});

// --- VIEW PLANS ---
bot.action("view_plans", async (ctx) => {
  const plansKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🇰🇪 KES Plans", "kes_plans")],
    [Markup.button.callback("💵 USD Plans", "usd_plans")],
  ]);
  await ctx.editMessageText("💳 Choose your currency:", plansKeyboard);
});

// --- KES PLANS ---
bot.action("kes_plans", async (ctx) => {
  const kesKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 Month - KES 299", "kes_1m")],
    [Markup.button.callback("1 Year - KES 2999", "kes_12m")],
  ]);
  await ctx.editMessageText("🇰🇪 *KES Subscription Plans:*", {
    parse_mode: "Markdown",
    ...kesKeyboard,
  });
});

// --- USD PLANS ---
bot.action("usd_plans", async (ctx) => {
  const usdKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 Month - $2.3", "usd_1m")],
    [Markup.button.callback("1 Year - $23", "usd_12m")],
  ]);
  await ctx.editMessageText("💵 *USD Subscription Plans:*", {
    parse_mode: "Markdown",
    ...usdKeyboard,
  });
});

// --- ASK FOR EMAIL AND INITIATE PAYMENT ---
bot.action(/(kes|usd)_(1m|12m)/, async (ctx) => {
  const plan = ctx.match[0];
  const userId = ctx.from.id;

  await ctx.reply("📧 Please enter your email address for payment:");

  const handler = async (msgCtx) => {
    if (msgCtx.from.id !== userId) return;

    const email = msgCtx.message.text.trim();
    if (!email.includes("@")) return msgCtx.reply("❌ Please provide a valid email address.");

    const amount =
      plan === "kes_1m"
        ? 29900
        : plan === "kes_12m"
        ? 299900
        : plan === "usd_1m"
        ? 230
        : 2300;
    const currency = plan.startsWith("kes") ? "KES" : "USD";

    try {
      const res = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email,
          amount,
          currency,
          metadata: { user_id: userId, plan },
          callback_url: `${process.env.SERVER_URL}/paystack/callback`,
        },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
      );

      const payUrl = res.data.data.authorization_url;
      await msgCtx.reply(`💳 Complete your payment here:\n${payUrl}`);
    } catch (err) {
      console.error("Paystack init error:", err);
      await msgCtx.reply("❌ Failed to initialize payment. Please try again.");
    }

    bot.off("text", handler);
  };

  bot.on("text", handler);
});

// --- CHECK STATUS ---
bot.action("check_status", async (ctx) => {
  const userId = ctx.from.id;
  
 // >>> CORRECTION: Fix the column names used for select and where condition <<<
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, end_at") // Select the correct expiration column
    .eq("telegram_id", userId) // Query against the correct unique column
    .single();
// >>> END CORRECTION <<<

  if (error || !data) {
    await ctx.reply("❌ You do not have an active subscription.");
  } else {
    await ctx.reply(
      `✅ Subscription Status: *${data.status.toUpperCase()}*\n🗓 Expires on: ${data.end_at}`, // Use the correct expiration column
      { parse_mode: "Markdown" }
    );
  }
});

// --- PAYSTACK WEBHOOK ---
app.post("/paystack/webhook", express.json({ type: "*/*" }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto
      .createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) return res.sendStatus(400);

    const event = req.body;
    if (event.event === "charge.success") {
      const metadata = event.data.metadata || {};
      const plan = metadata.plan || "unknown";
      const telegramIdValue = metadata.user_id; 
      const amount = event.data.amount || 0;
      const currency = event.data.currency || "USD";

      if (!telegramIdValue) return res.sendStatus(400);

      const days = plan.endsWith("1m") ? 30 : plan.endsWith("12m") ? 365 : 30;
      
      const expirationDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

      await supabase.from("subscriptions").upsert({
        telegram_id: telegramIdValue, 
        end_at: expirationDate, 
        plan,
        status: "active",
        payment_ref: event.data.reference,
        amount,
        currency,
      }, { onConflict: 'telegram_id' });

      try {
        const inviteLink = await bot.telegram.exportChatInviteLink(PREMIUM_GROUP);
        await bot.telegram.sendMessage(
          telegramIdValue, 
          `🎉 *Congratulations!* Your Fabadel Premium subscription is now active.\n\n` +
            `Welcome aboard! 🚀 You now have full access to premium resources and jobs.\n\n` +
            `👉 Join our premium group here: ${inviteLink}`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
           // Log the error for debugging why the link failed (e.g., bot permissions)
           console.error("Invite Link Error (Webhook):", error);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// --- PAYSTACK CALLBACK URL ---
app.get("/paystack/callback", async (req, res) => {
  const { reference } = req.query;
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      }
    );

    if (response.data.status && response.data.data.status === "success") {
      const metadata = response.data.data.metadata || {};
      const plan = metadata.plan || "unknown";
      const telegramIdValue = metadata.user_id; 
      const amount = response.data.data.amount || 0;
      const currency = response.data.data.currency || "USD";

      if (!telegramIdValue) return res.status(400).send("❌ Invalid transaction metadata.");

      const days = plan.endsWith("1m") ? 30 : plan.endsWith("12m") ? 365 : 30;

      const expirationDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

      await supabase.from("subscriptions").upsert({
        telegram_id: telegramIdValue, 
        end_at: expirationDate, 
        plan,
        status: "active",
        payment_ref: reference, 
        amount,
        currency,
      }, { onConflict: 'telegram_id' });

      try {
        const inviteLink = await bot.telegram.exportChatInviteLink(PREMIUM_GROUP);
        await bot.telegram.sendMessage(
          telegramIdValue, 
          `🎉 Payment verified! Your Fabadel Premium subscription is now active.\n\n` +
            `👉 Join our premium group here: ${inviteLink}`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
           // Log the error for debugging why the link failed (e.g., bot permissions)
           console.error("Invite Link Error (Callback):", error);
      }

      return res.status(200).send("✅ Payment verified. You can close this window.");
    }

    res.status(400).send("❌ Payment not successful.");
  } catch (error) {
    console.error("Callback verification error:", error);
    res.status(500).send("⚠️ Internal error verifying payment.");
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
bot.launch();