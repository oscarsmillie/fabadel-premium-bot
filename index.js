// /index.js

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
// The static invite link to be used for all successful payments
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";


// ======================================================
// KICK-OFF FUNCTION (For External Scheduler)
// ======================================================

/**
 * Checks for expired users in the database, kicks them from the Telegram group,
 * updates the subscription status, and sends a notification.
 */
async function kickExpiredUsers() {
    console.log("Starting kickExpiredUsers job...");

    // 1. Get expired but still active users
    const { data: expiredUsers, error } = await supabase
        .from("subscriptions")
        // Select fields needed for kicking, updating, and reporting
        .select("telegram_id, end_at, plan, status, payment_ref")
        .eq("status", "active") // Only target currently active subscriptions
        .lt("end_at", new Date().toISOString()); 

    if (error) {
        console.error("Supabase query error for kick-off:", error);
        return;
    }

    if (!expiredUsers || expiredUsers.length === 0) {
        console.log("No users found to kick.");
        return;
    }

    console.log(`Found ${expiredUsers.length} users to kick.`);

    const kickedIds = [];
    const failedKicks = [];

    // 2. Kick Users and track success/failure
    const kickPromises = expiredUsers.map(async (user) => {
        try {
            // Telegram API to kick the user.
            // NOTE: Must use 'unbanChatMember' with 'only_if_banned: true' 
            // for it to act as a removal/kick. (If using banChatMember, they can't rejoin)
            // For simple group removal (allowing them to rejoin if they pay later):
            await bot.telegram.banChatMember(PREMIUM_GROUP, user.telegram_id, {
                until_date: Math.floor(Date.now() / 1000) + 300 // Temporary ban for 5 minutes
            });
            await bot.telegram.unbanChatMember(PREMIUM_GROUP, user.telegram_id); // Immediately unban them so they can't re-enter unless they pay
            
            console.log(`Successfully removed user: ${user.telegram_id}`);
            kickedIds.push(user.telegram_id);
            return user.telegram_id;
        } catch (kickError) {
            console.error(`Failed to remove user ${user.telegram_id}. Error: ${kickError.message}`);
            failedKicks.push(user.telegram_id);
            return null;
        }
    });

    // Wait for all kick attempts to finish
    await Promise.all(kickPromises);

    // 3. Update the database ONLY for successfully kicked users
    if (kickedIds.length > 0) {
        const { error: updateError } = await supabase
            .from("subscriptions")
            .update({ status: 'expired', active: false }) 
            .in("telegram_id", kickedIds);

        if (updateError) {
            console.error("Database update error:", updateError);
        } else {
            console.log(`Successfully updated status for ${kickedIds.length} subscriptions.`);
        }
    }


    // 4. Send Telegram Notification (To the channel owner/admin)
    const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Must be set in .env
    if (kickedIds.length > 0 && ADMIN_CHAT_ID) {
        const expiredList = expiredUsers
            .filter(u => kickedIds.includes(u.telegram_id))
            .map((u, index) => 
                `${index + 1}. ID: \`${u.telegram_id}\` (Plan: ${u.plan})`
            )
            .join('\n');

        const expirationMessage = 
            `🛑 *Subscription Expiration Notice!* 🛑\n\n` +
            `**${kickedIds.length}** users have been *removed* and marked *expired*:\n` +
            `${expiredList}`;
            
        try {
            await bot.telegram.sendMessage(ADMIN_CHAT_ID, expirationMessage, { 
                parse_mode: "Markdown" 
            });
            console.log("Admin notification sent.");
        } catch (alertError) {
            console.error("Failed to send admin notification:", alertError.message);
        }
    }
    
    console.log("Kick-off job finished.");
}

// Example of how you might expose this as an API endpoint for an external cron service
app.get("/api/kick-expired", async (req, res) => {
    // ⚠️ SECURITY NOTE: 
    // This endpoint should be secured! Anyone who knows this URL can trigger this job.
    // For production, check a secret key in the request header/query.

    await kickExpiredUsers();
    res.status(200).send("Kick-off process initiated.");
});

// ======================================================
// END KICK-OFF FUNCTION
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

        // NOTE: Paystack expects amount in Kobo/Cents (100 times the actual amount)
        const amount =
            plan === "kes_1m"
                ? 29900 // KES 299.00
                : plan === "kes_12m"
                ? 299900 // KES 2,999.00
                : plan === "usd_1m"
                ? 230    // USD 2.30
                : 2300;  // USD 23.00
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

    const { data, error } = await supabase
        .from("subscriptions")
        .select("status, end_at")
        .eq("telegram_id", userId)
        .single();

    if (error || !data) {
        await ctx.reply("❌ You do not have an active subscription.");
    } else {
        await ctx.reply(
            `✅ Subscription Status: *${data.status.toUpperCase()}*\n🗓 Expires on: ${data.end_at}`,
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
                active: true, // Explicitly set active flag
                payment_ref: event.data.reference,
                amount,
                currency,
            }, { onConflict: 'telegram_id' });

            // --- MODIFICATION: Use STATIC_INVITE_LINK directly ---
            await bot.telegram.sendMessage(
                telegramIdValue,
                `🎉 *Congratulations!* Your Fabadel Premium subscription is now active.\n\n` +
                `Welcome aboard! 🚀 You now have full access to premium resources and jobs.\n\n` +
                `👉 Join our premium group here: ${STATIC_INVITE_LINK}`,
                { parse_mode: "Markdown" }
            );
            // --- END MODIFICATION ---
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
                active: true, // Explicitly set active flag
                payment_ref: reference,
                amount,
                currency,
            }, { onConflict: 'telegram_id' });

            // --- MODIFICATION: Use STATIC_INVITE_LINK directly ---
            await bot.telegram.sendMessage(
                telegramIdValue,
                `🎉 Payment verified! Your Fabadel Premium subscription is now active.\n\n` +
                `👉 Join our premium group here: ${STATIC_INVITE_LINK}`,
                { parse_mode: "Markdown" }
            );
            // --- END MODIFICATION ---

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