// /index.js - INTASEND MIGRATION (Cloud Run-ready)
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import http from "http";

dotenv.config();

const app = express();
// CLOUD RUN CHANGE: Ensure JSON middleware before routes
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userState = new Map();
const PREMIUM_GROUP = "@FabadelPremiumGroup";
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// Webhook Configuration
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'a-strong-secret-key-you-must-set';
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
const SERVER_URL = process.env.SERVER_URL;

// INTASEND CONFIG
const INTASEND_API_BASE = "https://payment.intasend.com/api/v1";
const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;
const INTASEND_SECRET_KEY = process.env.INTASEND_SECRET_KEY;
const INTASEND_WEBHOOK_SECRET = process.env.INTASEND_WEBHOOK_SECRET;

// ======================================================
// KICK-OFF FUNCTION (unchanged)
async function kickExpiredUsers() {
    console.log("Starting kickExpiredUsers job...");

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

    const kickPromises = expiredUsers.map(async (user) => {
        try {
            await bot.telegram.banChatMember(PREMIUM_GROUP, user.telegram_id, {
                until_date: Math.floor(Date.now() / 1000) + 300
            });
            await bot.telegram.unbanChatMember(PREMIUM_GROUP, user.telegram_id);
            
            console.log(`Successfully removed user: ${user.telegram_id}`);
            kickedIds.push(user.telegram_id);
            return user.telegram_id;
        } catch (kickError) {
            console.error(`❌ Failed to remove user ${user.telegram_id}. Error: ${kickError.message}`);
            failedKicks.push(user.telegram_id);
            return null;
        }
    });

    await Promise.all(kickPromises);

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

    const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID; 
    if (kickedIds.length > 0 && ADMIN_CHAT_ID) {
        const expiredList = expiredUsers
            .filter(u => kickedIds.includes(u.telegram_id))
            .map((u, index) => `${index + 1}. ID: \`${u.telegram_id}\` (Plan: ${u.plan})`)
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
            console.error("❌ Failed to send admin notification:", alertError.message);
        }
    }
    
    console.log("Kick-off job finished.");
}

app.get("/api/kick-expired", async (req, res) => {
    if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).send("Unauthorized");
    await kickExpiredUsers();
    res.status(200).send("Kick-off process initiated.");
});

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

// --- STEP 1: ASK FOR EMAIL ---
bot.action(/(kes|usd)_(1m|12m)/, async (ctx) => {
    const plan = ctx.match[0];
    const userId = ctx.from.id;
    userState.set(userId, plan);
    await ctx.reply("📧 Please enter your email address for payment:");
});

// --- STEP 2: PROCESS EMAIL ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    if (!userState.has(userId)) return;
    const plan = userState.get(userId);
    userState.delete(userId);

    const email = ctx.message.text.trim();
    if (!email.includes("@")) return ctx.reply("❌ Invalid email. Click plan button again.");

    const amount =
        plan === "kes_1m"
            ? 299.00
            : plan === "kes_12m"
            ? 2999.00
            : plan === "usd_1m"
            ? 2.30
            : 23.00;
    const currency = plan.startsWith("kes") ? "KES" : "USD";
    const unique_ref = `${userId}_${Date.now()}`;

    try {
        const res = await axios.post(
            `${INTASEND_API_BASE}/checkout/`,
            {
                public_key: INTASEND_PUBLISHABLE_KEY,
                amount: amount,
                currency: currency,
                api_ref: unique_ref,
                customer: {
                    first_name: ctx.from.first_name || 'TGUser',
                    last_name: ctx.from.last_name || userId.toString(),
                    email: email,
                },
                metadata: { user_id: userId, plan: plan },
                redirect_url: `${SERVER_URL}/intasend/callback`,
            },
            { 
                headers: { 
                    'Authorization': `Bearer ${INTASEND_SECRET_KEY.trim()}`,
                    'Content-Type': 'application/json' 
                } 
            }
        );

        const payUrl = res.data.url;
        if (!payUrl) {
            console.error("IntaSend init error: No payment URL returned.", res.data);
            await ctx.reply("❌ Failed to initialize payment.");
        } else {
            await ctx.reply(`💳 Complete payment:`, {
                reply_markup: Markup.inlineKeyboard([[Markup.button.url('Pay Now', payUrl)]]).reply_markup,
                parse_mode: 'Markdown'
            });
        }
    } catch (err) {
        const authError = err.response?.data?.errors?.find(e => e.code === 'authentication_failed');
        if (authError) {
             console.error("Authentication Failed. Check Secret Key.");
             await ctx.reply("❌ Payment initiation failed. Check Secret Key.");
        } else {
            console.error("IntaSend init error:", err.response?.data || err.message);
            await ctx.reply("❌ Failed to initialize payment.");
        }
    }
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

// --- INTASEND WEBHOOK ---
app.post("/intasend/webhook", async (req, res) => {
    const headerSecret = req.headers['x-intasend-secret'];
    if (headerSecret !== INTASEND_WEBHOOK_SECRET) return res.sendStatus(401);

    const event = req.body;
    console.log("IntaSend Webhook Received:", event.checkout_id, event.state);

    if (event.state === 'COMPLETE') {
        const { tracking_id, metadata, amount, api_ref } = event;
        const telegram_id = metadata?.user_id;
        const plan = metadata?.plan;

        if (!telegram_id || !plan) return res.sendStatus(200);

        const durationMonths = plan.endsWith('1m') ? 1 : 12;
        const end_at = new Date();
        end_at.setMonth(end_at.getMonth() + durationMonths);

        const { error } = await supabase
            .from("subscriptions")
            .upsert(
                {
                    telegram_id: parseInt(telegram_id),
                    plan: plan,
                    start_at: new Date().toISOString(),
                    end_at: end_at.toISOString(),
                    status: 'active',
                    payment_ref: tracking_id || api_ref,
                    amount_paid: amount,
                    active: true
                },
                { onConflict: 'telegram_id' }
            );

        if (error) console.error("Supabase upsert error:", error);
        else {
            try {
                await bot.telegram.sendMessage(
                    telegram_id,
                    `🎉 Your *${durationMonths}-month* subscription is now active.\n🔗 Join: ${STATIC_INVITE_LINK}`,
                    { parse_mode: "Markdown" }
                );
            } catch (msgError) {
                console.error(`Failed to send welcome message:`, msgError.message);
            }
        }
    } else if (event.state === 'FAILED') {
         const telegram_id = event.metadata?.user_id;
         if (telegram_id) {
             try {
                await bot.telegram.sendMessage(
                    telegram_id,
                    `❌ Payment failed. Try again or contact support.`,
                    { parse_mode: "Markdown" }
                );
            } catch (msgError) {
                console.error(`Failed to send failure message:`, msgError.message);
            }
         }
    }
    
    res.sendStatus(200);
});

// Callback URL
app.get("/intasend/callback", (req, res) => {
    res.send('Payment complete! Please check your Telegram chat.');
});

// Register Telegram Webhook
async function registerWebhook() {
    if (!SERVER_URL) {
        console.error("❌ SERVER_URL not set. Cannot register webhook.");
        return;
    }

    try {
        await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, {
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        });
        console.log(`✅ Telegram Webhook set to: ${SERVER_URL}${WEBHOOK_PATH}`);
    } catch (err) {
        console.error("❌ Failed to set Telegram Webhook:", err.message);
    }
}

// CLOUD RUN CHANGE: Use webhook callback middleware
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

// CLOUD RUN CHANGE: Listen on process.env.PORT || 8080
const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

server.listen(PORT, () => { 
    console.log(`✅ Server running on port ${PORT}`);
    registerWebhook();
});
