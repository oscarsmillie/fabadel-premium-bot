// /index.js - Cloud Run-ready Fabadel Premium Bot
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import http from "http";

dotenv.config();

const app = express();
app.use(express.json()); // Must be before routes

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userState = new Map();
const PREMIUM_GROUP = "@FabadelPremiumGroup";
const STATIC_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// Webhook config
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'a-strong-secret-key';
const WEBHOOK_PATH = `/bot/${bot.secretPathComponent()}`;
const SERVER_URL = process.env.SERVER_URL;

// IntaSend config
const INTASEND_API_BASE = "https://payment.intasend.com/api/v1";
const INTASEND_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;
const INTASEND_SECRET_KEY = process.env.INTASEND_SECRET_KEY;
const INTASEND_WEBHOOK_SECRET = process.env.INTASEND_WEBHOOK_SECRET;

// Kick expired users logic (unchanged)
// ... keep your kickExpiredUsers function as is ...

app.get("/api/kick-expired", async (req, res) => {
    if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).send("Unauthorized");
    await kickExpiredUsers();
    res.status(200).send("Kick-off process initiated.");
});

// --- BOT COMMANDS AND ACTIONS --- (unchanged)
// Keep all your bot.start, bot.action, bot.on('text') logic exactly as is

// --- INTASEND WEBHOOK ---
app.post("/intasend/webhook", async (req, res) => {
    const headerSecret = req.headers['x-intasend-secret'];
    if (headerSecret !== INTASEND_WEBHOOK_SECRET) return res.sendStatus(401);

    const event = req.body;
    // Keep all your webhook logic as is
    res.sendStatus(200);
});

// Callback URL
app.get("/intasend/callback", (req, res) => {
    res.send('Payment complete! Check Telegram for confirmation.');
});

// --- REGISTER TELEGRAM WEBHOOK ---
async function registerWebhook() {
    if (!SERVER_URL) {
        console.error("❌ SERVER_URL is not set. Webhook cannot be registered.");
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

// --- CLOUD RUN SERVER SETUP ---
app.use(bot.webhookCallback(WEBHOOK_PATH, WEBHOOK_SECRET));

const PORT = process.env.PORT || 8080; // <--- Cloud Run expects PORT
const server = http.createServer(app);

server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    registerWebhook();
});
