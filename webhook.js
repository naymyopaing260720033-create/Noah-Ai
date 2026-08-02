import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Environment Variables ──────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Gemini Client ──────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  systemInstruction: `သင်သည် အကူအညီပေးသော AI Assistant တစ်ယောက်ဖြစ်သည်။
မြန်မာဘာသာဖြင့် မေးလျှင် မြန်မာဘာသာဖြင့် ဖြေပါ။
အင်္ဂလိပ်ဘာသာဖြင့် မေးလျှင် အင်္ဂလိပ်ဘာသာဖြင့် ဖြေပါ။
တိုတိုရှင်းရှင်း ရှင်းလင်းစွာ ဖြေဆိုပါ။`,
});

// ── In-Memory Chat History (per chatId) ───────────────────────
// Serverless မို့ restart တိုင်း ကုန်မည် — Production မှာ Redis သုံးပါ
const chatHistories = {};
const MAX_HISTORY   = 10; // နောက်ဆုံး ၁၀ ကြိမ် မှတ်ထားမည်

// ── Telegram Helpers ───────────────────────────────────────────
async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:    chatId,
      text:       text,
      parse_mode: "Markdown",
    }),
  });
}

async function sendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      action:  "typing",
    }),
  });
}

// ── Gemini Chat Function ───────────────────────────────────────
async function askGemini(chatId, userMessage) {
  // History မရှိရင် အသစ်ဖန်တီး
  if (!chatHistories[chatId]) {
    chatHistories[chatId] = [];
  }

  // Chat session စပါ
  const chat = model.startChat({
    history: chatHistories[chatId],
    generationConfig: {
      maxOutputTokens: 1000,
      temperature:     0.7,
    },
  });

  // Gemini ကို မေး
  const result   = await chat.sendMessage(userMessage);
  const response = result.response.text();

  // History ထဲ ထည့်သိမ်း
  chatHistories[chatId].push(
    { role: "user",  parts: [{ text: userMessage }] },
    { role: "model", parts: [{ text: response }] }
  );

  // History ကြီးလွန်းရင် အဟောင်းတွေ ဖျက်
  if (chatHistories[chatId].length > MAX_HISTORY * 2) {
    chatHistories[chatId] = chatHistories[chatId].slice(-(MAX_HISTORY * 2));
  }

  return response;
}

// ── Command Handlers ───────────────────────────────────────────
async function handleStart(chatId, firstName) {
  const text =
    `မင်္ဂလာပါ *${firstName}*\\! 🤖\n\n` +
    `ကျွန်တော်က *Gemini AI* နဲ့ အလုပ်လုပ်တဲ့ Chatbot ဖြစ်ပါတယ်။\n\n` +
    `📌 *Commands:*\n` +
    `/start \\- Bot စတင်ခြင်း\n` +
    `/clear \\- စကားဝိုင်းသမိုင်း ရှင်းလင်းခြင်း\n` +
    `/help  \\- အကူအညီ\n\n` +
    `💬 ဘာမဆို မေးနိုင်ပါတယ်\\!`;
  await sendMessage(chatId, text);
}

async function handleHelp(chatId) {
  const text =
    `🆘 *အကူအညီ*\n\n` +
    `*Commands တွေ:*\n` +
    `• /start \\- Bot ကို ပြန်စတင်ခြင်း\n` +
    `• /clear \\- စကားဝိုင်းသမိုင်း ဖျက်ခြင်း\n` +
    `• /help  \\- ဒီ message ကိုပြတာ\n\n` +
    `*Tips:*\n` +
    `• မြန်မာဘာသာ သို့မဟုတ် အင်္ဂလိပ်ဘာသာ နှစ်မျိုးလုံး သုံးလို့ရတယ်\n` +
    `• Bot က နောက်ဆုံး ${MAX_HISTORY} ကြိမ် မှတ်ထားတယ်\n` +
    `• /clear နှိပ်ရင် အသစ်ပြန်စနိုင်တယ်`;
  await sendMessage(chatId, text);
}

async function handleClear(chatId) {
  chatHistories[chatId] = [];
  await sendMessage(chatId, "✅ စကားဝိုင်းသမိုင်း ရှင်းလင်းပြီးပါပြီ။ အသစ်ပြန်စနိုင်ပါပြီ။");
}

// ── Main Handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  // GET request ဖြစ်ရင် health check အတွက် OK ပြန်
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Bot is running!" });
  }

  // Telegram ကို ချက်ချင်း 200 ပြန် (timeout မဖြစ်အောင်)
  res.status(200).json({ ok: true });

  try {
    const { message } = req.body;

    // Message မရှိရင် ထွက်
    if (!message) return;

    const chatId    = message.chat.id;
    const text      = message.text;
    const firstName = message.from?.first_name || "သူငယ်ချင်း";

    // Text မဟုတ်တဲ့ message (ဓာတ်ပုံ၊ voice စသည်)
    if (!text) {
      await sendMessage(chatId, "⚠️ စာသားသာ ပေးပို့နိုင်ပါသည်။");
      return;
    }

    // Commands စစ်ဆေး
    if (text === "/start") {
      await handleStart(chatId, firstName);
      return;
    }

    if (text === "/help") {
      await handleHelp(chatId);
      return;
    }

    if (text === "/clear") {
      await handleClear(chatId);
      return;
    }

    // ── AI Response ──────────────────────────────────────────
    // Typing indicator ပြ
    await sendTyping(chatId);

    // 8 စက္ကန့် Timeout နဲ့ Gemini ကို မေး
    const reply = await Promise.race([
      askGemini(chatId, text),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), 8000)
      ),
    ]);

    await sendMessage(chatId, reply);

  } catch (error) {
    console.error("Error:", error.message);

    const chatId = req.body?.message?.chat?.id;
    if (!chatId) return;

    if (error.message === "TIMEOUT") {
      await sendMessage(
        chatId,
        "⏳ တုံ့ပြန်မှု နှေးသွားတယ်။ နည်းနည်းနောက်မှ ထပ်ကြိုးစားပါ။"
      );
    } else {
      await sendMessage(
        chatId,
        "❌ တစ်ခုခု မှားယွင်းသွားတယ်။ /clear နှိပ်ပြီး ထပ်ကြိုးစားပါ။"
      );
    }
  }
    }
      
