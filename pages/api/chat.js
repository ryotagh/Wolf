import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
export const config = { maxDuration: 30 };

let lastCallTime = 0;
const INTERVAL_MS = 4000;
const queue = [];
let processing = false;

function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const now = Date.now();
  const wait = Math.max(0, lastCallTime + INTERVAL_MS - now);

  setTimeout(async () => {
    const { prompt, resolve, reject } = queue.shift();
    lastCallTime = Date.now();
    processing = false;

    try {
      const result = await callGemini(prompt);
      resolve(result);
    } catch (e) {
      reject(e);
    }

    processQueue();
  }, wait);
}

function enqueue(prompt) {
  return new Promise((resolve, reject) => {
    if (queue.length >= 5) {
      return reject({ status: 429, message: "queue_full" });
    }
    queue.push({ prompt, resolve, reject });
    processQueue();
  });
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    generationConfig: {
      maxOutputTokens: 600,
      temperature: 1.0,
      topP: 0.95,
    },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
  });
  const result = await model.generateContent(prompt);
  return result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "API key not configured" });

  try {
    const result = await enqueue(prompt);

    if (!result.response.candidates || result.response.candidates[0]?.finishReason === "SAFETY") {
      return res.status(200).json({ text: null });
    }
    let text = result.response.text().trim();
    if (!text) return res.status(200).json({ text: null });
    text = text.replace(/^[\s「」『』""''\n]+|[\s「」『』""''\n]+$/g, "").trim();
    if (text.length > 0 && !text.match(/[。！？]$/)) {
      const lastPunct = Math.max(text.lastIndexOf("。"), text.lastIndexOf("！"), text.lastIndexOf("？"));
      if (lastPunct > 10) text = text.slice(0, lastPunct + 1);
    }
    return res.status(200).json({ text });
  } catch (error) {
    console.error("Gemini error:", error?.message || error);
    if (error?.status === 429 || String(error?.message).includes("429") || error?.message === "queue_full") {
      return res.status(429).json({ error: "rate_limit" });
    }
    return res.status(500).json({ error: "failed" });
  }
}
