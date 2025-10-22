// /index.js - FINAL FIXED VERSION

import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import crypto from "crypto";

dotenv.config();

const app = express();
// Ensure express.json() is used before any routes or webhooks that require JSON bodies
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

// Placeholder for other bot logic (e.g., bot.command('/start', ...))
// --- START COMMAND ---
bot.start((ctx) => {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 View Plans', 'view_plans')],
        [Markup.button.callback('📊 Subscription Status', 'check_status')]
    ]);
    ctx.reply(
        `👋 Hello ${ctx.from.first_name}! 
        
        Welcome to *Fabadel Premium* 🚀  

Here you can:
💼 Access exclusive job opportunities  
📚 Learn high-value skills from top creators  
💳 Upgrade anytime for full premium access  

Choose an option below to get started.`,
        keyboard
    );
});

// --- VIEW PLANS ---
bot.action('view_plans', (ctx) => {
    const plansKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('KES 299/Month', 'kes_1m')],
        [Markup.button.callback('KES 2,999/Year', 'kes_12m')],
        [Markup.button.callback('USD 2.30/Month', 'usd_1m')],
        [Markup.button.callback('USD 23.00/Year', 'usd_12m')]
    ]);
    ctx.reply('Select your preferred plan and currency:', plansKeyboard);
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
                ? 230     // USD 2.30
                : 2300;   // USD 23.00
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
    // 1. Verify the webhook signature
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
    const hash = crypto.createHmac('sha512', secret)
                       .update(JSON.stringify(req.body))
                       .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
        // Log unauthorized attempt for security
        console.error("❌ Paystack Webhook: Signature mismatch!");
        return res.sendStatus(400); // Invalid signature
    }

    const event = req.body;

    if (event.event === 'charge.success') {
        const { status, reference, metadata, amount: paidAmount } = event.data;
        const { user_id: telegram_id, plan } = metadata;

        if (status !== 'success' || !telegram_id || !plan) {
            return res.sendStatus(200); // Acknowledge but ignore invalid data
        }

        // Calculate subscription duration
        const durationMonths = plan.endsWith('1m') ? 1 : 12;
        const end_at = new Date();
        end_at.setMonth(end_at.getMonth() + durationMonths);

        // 2. Update Supabase
        const { error } = await supabase
            .from("subscriptions")
            .upsert(
                {
                    telegram_id: parseInt(telegram_id),
                    plan: plan,
                    start_at: new Date().toISOString(),
                    end_at: end_at.toISOString(),
                    status: 'active',
                    payment_ref: reference,
                    amount_paid: paidAmount / 100, // Convert from kobo/cents
                    active: true
                },
                { onConflict: 'telegram_id' }
            );

        if (error) {
            console.error("Supabase upsert error:", error);
        } else {
            console.log(`✅ Subscription created/updated for user ${telegram_id}`);
            
            // 3. Send success message and invite link
            try {
                await bot.telegram.sendMessage(
                    telegram_id,
                    `🎉 Congratulations! Your *${durationMonths}-month* subscription is now active.\n\n` +
                    `🔗 Join your premium group here: ${STATIC_INVITE_LINK}`,
                    { parse_mode: "Markdown" }
                );
            } catch (msgError) {
                console.error(`❌ Failed to send welcome message to user ${telegram_id}:`, msgError.message);
            }
        }
    }
    
    res.sendStatus(200); // Always respond 200 to Paystack quickly
});

// --- PAYSTACK CALLBACK URL ---
app.get("/paystack/callback", async (req, res) => {
    // This is where the user lands after payment. We redirect them back to the bot.
    res.send('Payment complete! Please check your Telegram chat for your subscription confirmation and group invite link.');
    // Optionally, you could redirect to the bot:
    // res.redirect('https://t.me/YourBotUsername');
});

// --- NEW FUNCTION TO HANDLE ASYNC WEBHOOK REGISTRATION ---
async function registerWebhook() {
    if (SERVER_URL) {
        try {
            await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
                secret_token: WEBHOOK_SECRET,
                allowed_updates: ['message', 'callback_query', 'my_chat_member'] 
            });
            console.log(`✅ Telegram Webhook set to: ${SERVER_URL}${WEBHOOK_PATH}`);
        } catch (err) {
            console.error('❌ Failed to set Telegram Webhook. Error:', err.message);
        }
    } else {
        console.error("❌ SERVER_URL environment variable is NOT set. Webhook cannot be registered.");
    }
}


// ======================================================
// START SERVER (FINAL, ROBUST WEBHOOK MODE)
// ======================================================

// 1. Tell Express to listen for updates on that path (CRITICAL ORDER)
// This registers the middleware that handles incoming Telegram requests.
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET)); 

// 2. START SERVER AND KICK OFF WEBHOOK REGISTRATION
const PORT = process.env.PORT || 3000;

// Removed 'async' from app.listen to keep the thread alive
app.listen(PORT, () => { 
    console.log(`✅ Server running on port ${PORT}`);
    
    // Call the asynchronous function to register the webhook in the background
    registerWebhook();
});