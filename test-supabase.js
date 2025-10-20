import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testUpsert() {
  const { data, error } = await supabase.from("subscriptions").upsert({
    user_id: "5070094809",
    plan: "usd_1m",
    status: "active",
    payment_ref: "test123",
    amount: 230,
    currency: "USD",
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  if (error) {
    console.error("Supabase upsert error:", error);
  } else {
    console.log("Upsert successful:", data);
  }
}

testUpsert();
