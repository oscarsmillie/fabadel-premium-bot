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

// Webhook Configuration Variables
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'a-strong-secret-key-you-must-set';
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
const SERVER_URL = process.env.SERVER_URL;


// ======================================================
// KICK-OFF FUNCTION (For External Scheduler)
// ======================================================

/**
 * Checks for expired users in the database, kicks them from the Telegram group,
 * updates the subscription status, and sends a notification.
 */
async function kickExpiredUsers() {
    console.log("Starting kickExpiredUsers job...");

    // 1. Get expired but still active subscriptions
    const { data: expiredUsers, error } = await supabase
        .from("subscriptions")
        .select("telegram_id, end_at, plan, status, payment_ref")
        .eq("status", "active")
        .lt("end_at", new Date().toISOString()); 

    if (error) {
        console.error("Supabase query error for kick-off:", error);
        return;
    }

    if (!expiredUsers || expiredUsers.length === 0) {
        console.log("No subscriptions found to expire.");
        return;
    }

    console.log(`Found ${expiredUsers.length} subscriptions to kick.`);

    const kickedIds = [];
    const failedKicks = [];

    // 2. Kick Users and track success/failure
    const kickPromises = expiredUsers.map(async (user) => {
        try {
            // CRITICAL STEP: Bot must be an admin with permission to restrict members
            await bot.telegram.banChatMember(PREMIUM_GROUP, user.telegram_id, {
                until_date: Math.floor(Date.now() / 1000) + 300 // Temporary ban for 5 minutes (removes user)
            });
            await bot.telegram.unbanChatMember(PREMIUM_GROUP, user.telegram_id); // Immediately unban them 
            
            console.log(`Successfully removed user: ${user.telegram_id}`);
            kickedIds.push(user.telegram_id);
            return user.telegram_id;
        } catch (kickError) {
            // Logs the error that explains why the removal failed (usually permission-related)
            console.error(`❌ Failed to remove user ${user.telegram_id}. Error: ${kickError.message}`);
            failedKicks.push(user.telegram_id);
            return null;
        }
    });

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

    // 4. Send Telegram Notification 
    const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID; 
    if (kickedIds.length > 0 && ADMIN_CHAT_ID) {
        const expiredList = expiredUsers
            .filter(u => kickedIds.includes(u.telegram_id))
            .map((u, index) => 
                `${index + 1}. ID: \`${u.telegram_id}\` (Plan: ${u.plan})`
            )
            .join('\n');

        const expirationMessage = 
            `🛑 *Subscription Expiration Notice!* 🛑\n\n` +
            `**${kickedIds.length}** subscriptions removed and marked *expired*:\n` +
            `${expiredList}`;
            
        try {
            await bot.telegram.sendMessage(ADMIN_CHAT_ID, expirationMessage, { 
                parse_mode: "Markdown" 
            });
            console.log("✅ Admin notification sent successfully.");
        } catch (alertError) {
            // Logs the error if the admin message fails (usually wrong chat ID or bot blocked)
            console.error("❌ Failed to send admin notification:", alertError.message);
        }
    }
    
    console.log("Kick-off job finished.");
}

// Expose the kick function as an API endpoint
app.get("/api/kick-expired", async (req, res) => {
    // ⚠️ SECURE THIS ENDPOINT! For production, check a secret key.
    if (req.query.secret !== process.env.CRON_SECRET) {
        return res.status(401).send("Unauthorized");
    }

    await kickExpiredUsers();
    res.status(200).send("Kick-off process initiated.");
});

// ======================================================
// END KICK-OFF FUNCTION
// ======================================================

// ... (All other bot.start, bot.action logic remains the same) ...

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
                ? 230     // USD 2.30
                : 2300;   // USD 23.00
        const currency = plan.startsWith("kes") ? "KES" : "USD";

        try {
            const res = await axios.post(
                "https://api.paystack.co/transaction/initialize",
                {
                    email,
                    amount,
                    currency,
                    metadata: { user_id: userId, plan },
                    // Use SERVER_URL for callback
                    callback_url: `${SERVER_URL}/paystack/callback`, 
                },
                { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
            );

            const payUrl = res.data.data.authorization_url;
            await msgCtx.reply(`💳 Complete your payment here:\n${payUrl}`);
        } catch (err) {
            console.error("Paystack init error:", err);
            await msgCtx.reply("❌ Failed to initialize payment. Please try again.");
        }

        // FIX FOR TYPEERROR: CALL THE UNLISTEN FUNCTION
        stopListening();
    };

    // CAPTURE THE UNLISTEN FUNCTION RETURNED BY bot.on
    const stopListening = bot.on("text", handler);
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
    // ... (logic remains the same) ...
});

// --- PAYSTACK CALLBACK URL ---
app.get("/paystack/callback", async (req, res) => {
    // ... (logic remains the same) ...
});


// /index.js (FINAL SECTION)

// ... (All other code, including app.use(express.json()), remains above) ...

// 2. Tell Express to listen for updates on that path (MOVE THIS LINE UP)
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

// --- START SERVER (WEBHOOK MODE) ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`✅ Server running on port ${PORT}`);
    
    // 1. Set the webhook URL on Telegram's side (This must run AFTER the server starts listening)
    if (SERVER_URL) {
        try {
            // Note: Keep the await here, but the app.use must be defined earlier.
            await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
                secret_token: WEBHOOK_SECRET,
                allowed_updates: ['message', 'callback_query', 'my_chat_member'] 
            });
            console.log(`✅ Telegram Webhook set to: ${SERVER_URL}${WEBHOOK_PATH}`);
        } catch (err) {
            console.error('❌ Failed to set Telegram Webhook. Check BOT_TOKEN and SERVER_URL.', err.message);
        }
    } else {
        console.error("❌ SERVER_URL environment variable is NOT set. Webhook cannot be registered.");
    }
});