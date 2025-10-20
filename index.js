import express from "express"
import dotenv from "dotenv"
import { Telegraf, Markup } from "telegraf"
import { createClient } from "@supabase/supabase-js"
import axios from "axios"

dotenv.config()

const app = express()
app.use(express.json())

const bot = new Telegraf(process.env.BOT_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// --- START COMMAND ---
bot.start(async (ctx) => {
  const startKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🎓 Start Learning", "start_learning")],
    [Markup.button.callback("📊 Subscription Status", "check_status")],
    [Markup.button.callback("💳 View Plans", "view_plans")],
  ])

  await ctx.reply(
    `👋 Welcome to *KaziNest Academy*!  
Here you can access exclusive educational courses to sharpen your skills and grow your career.  
Choose an option below to get started.`,
    { parse_mode: "Markdown", ...startKeyboard }
  )
})

// --- START LEARNING ---
bot.action("start_learning", async (ctx) => {
  await ctx.reply(
    "🌍 Explore our range of professional development and job-ready courses directly on our platform!"
  )
})

// --- VIEW PLANS ---
bot.action("view_plans", async (ctx) => {
  const plansKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🇰🇪 KES Plans", "kes_plans")],
    [Markup.button.callback("💵 USD Plans", "usd_plans")],
  ])
  await ctx.editMessageText("💳 Choose your currency:", plansKeyboard)
})

// --- KES PLANS ---
bot.action("kes_plans", async (ctx) => {
  const kesKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 Month - KES 299", "kes_1m")],
    [Markup.button.callback("3 Months - KES 799", "kes_3m")],
    [Markup.button.callback("6 Months - KES 1499", "kes_6m")],
    [Markup.button.callback("1 Year - KES 2999", "kes_12m")],
  ])
  await ctx.editMessageText("🇰🇪 *KES Subscription Plans:*", {
    parse_mode: "Markdown",
    ...kesKeyboard,
  })
})

// --- USD PLANS ---
bot.action("usd_plans", async (ctx) => {
  const usdKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 Month - $2.3", "usd_1m")],
    [Markup.button.callback("3 Months - $6", "usd_3m")],
    [Markup.button.callback("6 Months - $12", "usd_6m")],
    [Markup.button.callback("1 Year - $23", "usd_12m")],
  ])
  await ctx.editMessageText("💵 *USD Subscription Plans:*", {
    parse_mode: "Markdown",
    ...usdKeyboard,
  })
})

// --- ASK FOR EMAIL WHEN PLAN SELECTED ---
bot.action(/(kes|usd)_(1m|3m|6m|12m)/, async (ctx) => {
  const plan = ctx.match[0]
  ctx.session = { plan }
  await ctx.reply("📧 Please enter your email address for Paystack payment:")
  bot.on("text", async (msgCtx) => {
    const email = msgCtx.message.text
    const userId = msgCtx.from.id
    const { plan } = ctx.session

    // Store user email in Supabase
    await supabase
      .from("profiles")
      .upsert({ user_id: userId, email: email }, { onConflict: ["user_id"] })

    // Initialize Paystack payment
    const amount =
      plan === "kes_1m"
        ? 29900
        : plan === "kes_3m"
        ? 79900
        : plan === "kes_6m"
        ? 149900
        : plan === "kes_12m"
        ? 299900
        : plan === "usd_1m"
        ? 230
        : plan === "usd_3m"
        ? 600
        : plan === "usd_6m"
        ? 1200
        : 2300

    const currency = plan.startsWith("kes") ? "KES" : "USD"

    const res = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount,
        currency,
        metadata: { user_id: userId, plan },
        callback_url: `${process.env.SERVER_URL}/paystack/webhook`,
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      }
    )

    const payUrl = res.data.data.authorization_url
    await msgCtx.reply(`💳 Complete your payment here: ${payUrl}`)
  })
})

// --- CHECK STATUS ---
bot.action("check_status", async (ctx) => {
  const userId = ctx.from.id
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, expires_at")
    .eq("user_id", userId)
    .single()

  if (error || !data) {
    await ctx.reply("❌ You do not have an active subscription.")
  } else {
    await ctx.reply(
      `✅ Subscription Status: *${data.status.toUpperCase()}*\n🗓 Expires on: ${data.expires_at}`,
      { parse_mode: "Markdown" }
    )
  }
})

// --- PAYSTACK WEBHOOK ---
app.post("/paystack/webhook", async (req, res) => {
  try {
    const event = req.body
    if (event.event === "charge.success") {
      const { reference, customer, metadata } = event.data
      const userId = metadata.user_id

      await supabase.from("subscriptions").upsert({
        user_id: userId,
        plan: metadata.plan,
        status: "active",
        payment_ref: reference,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // default 30 days
      })

      await bot.telegram.sendMessage(
        userId,
        "🎉 Payment received! Your subscription is now active."
      )
    }
    res.sendStatus(200)
  } catch (error) {
    console.error("Webhook error:", error)
    res.sendStatus(500)
  }
})

// --- START SERVER ---
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`))
bot.launch()
