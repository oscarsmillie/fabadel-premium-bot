import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const PERMANENT_INVITE_LINK = "https://t.me/+kSAlgNtLRXJiYWZi";

// Helper to initialize Paystack transaction
async function initializePayment(email, plan, currency, amount) {
  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
        currency,
        metadata: { plan },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data.authorization_url;
  } catch (err) {
    console.error("Paystack init error:", err.response?.data || err.message);
    throw new Error("Failed to initialize payment");
  }
}

// Webhook endpoint for Telegram
app.post("/telegram", async (req, res) => {
  try {
    const update = req.body;

    // Handle callback_query
    if (update.callback_query) {
      const { data, message, from } = update.callback_query;
      const chatId = from.id;

      let plan, amount, currency;

      if (data === "kes_1m") {
        plan = "kes_1m";
        amount = 299;
        currency = "KES";
      } else if (data === "usd_1m") {
        plan = "usd_1m";
        amount = 2.3;
        currency = "USD";
      } else if (data === "usd_12m") {
        plan = "usd_12m";
        amount = 23;
        currency = "USD";
      } else {
        return res.sendStatus(200);
      }

      // Ask user for email
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: `Please reply with your email to pay for ${plan} (${currency} ${amount})`,
        }
      );

      // Save plan temporarily in memory (or replace with a DB session)
      app.locals[chatId] = { plan, amount, currency };
      return res.sendStatus(200);
    }

    // Handle user text (email)
    if (update.message && update.message.text) {
      const chatId = update.message.from.id;
      const email = update.message.text.trim();
      const session = app.locals[chatId];

      if (!session) return res.sendStatus(200); // No pending plan

      try {
        // Initialize Paystack payment
        const payUrl = await initializePayment(
          email,
          session.plan,
          session.currency,
          session.amount
        );

        // Send payment link
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            chat_id: chatId,
            text: `Click this link to complete payment: ${payUrl}`,
          }
        );

        // Upsert subscription in Supabase (safe)
        await supabase.from("subscriptions").upsert(
          {
            user_id: chatId.toString(),
            plan: session.plan,
            status: "pending",
            payment_ref: "pending",
            currency: session.currency,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
          { onConflict: ["user_id", "plan"] }
        );

        // Clear session
        delete app.locals[chatId];
      } catch (err) {
        console.error("Payment handling error:", err.message);
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            chat_id: chatId,
            text: "Failed to process payment. Please try again later.",
          }
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err.message);
    res.sendStatus(500);
  }
});

// Paystack webhook endpoint
app.post("/paystack-webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.event === "charge.success") {
      const metadata = event.data.metadata || {};
      const plan = metadata.plan || "unknown";
      const chatId = event.data.customer?.email || null;

      if (!chatId) return res.sendStatus(200);

      // Update Supabase subscription
      await supabase.from("subscriptions").upsert(
        {
          user_id: chatId.toString(),
          plan,
          status: "active",
          payment_ref: event.data.reference,
          amount: event.data.amount / 100,
          currency: event.data.currency,
          expires_at: new Date(
            Date.now() + (plan.includes("12m") ? 365 : 30) * 24 * 60 * 60 * 1000
          ),
        },
        { onConflict: ["user_id", "plan"] }
      );

      // Send permanent invite link
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: `Payment successful! You can join the group here: ${PERMANENT_INVITE_LINK}`,
        }
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Paystack webhook error:", err.message);
    res.sendStatus(500);
  }
});

// Health check
app.get("/", (req, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
