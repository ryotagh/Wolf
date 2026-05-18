import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
export const config = { maxDuration: 30 };

// 3つのAPIキーをローテーション（429が出たら自動で次のキーに切り替え）
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
  process.env.GEMINI_API_KEY_7,
  process.env.GEMINI_API_KEY_8,
  process.env.GEMINI_API_KEY_9,
].filter(Boolean);
let keyIndex = 0;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (!API_KEYS.length) return res.status(500).json({ error: "API key not configured" });

  // 全キーを2周試す（1周目全滅→少し待って1個目から再試行）
  const maxAttempts = API_KEYS.length * 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 2周目の最初だけ少し待つ（1個目が回復している可能性があるため）
    if (attempt === API_KEYS.length) {
      await new Promise(r => setTimeout(r, 8000));
    }
    const apiKey = API_KEYS[keyIndex % API_KEYS.length];
    keyIndex = (keyIndex + 1) % API_KEYS.length;
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite",
        generationConfig: {
          maxOutputTokens: 600,
          temperature: 1.0,
          topP: 0.95,
        },
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      });
      const result = await model.generateContent(prompt);
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
      const is429 = error?.status === 429 || String(error?.message).includes("429");
      if (is429 && attempt < maxAttempts - 1) {
        continue; // 次のキーへ
      }
      if (is429) {
        return res.status(429).json({ error: "rate_limit" });
      }
      console.error("Gemini error:", error?.message || error);
      return res.status(500).json({ error: "failed" });
    }
  }
  return res.status(429).json({ error: "rate_limit" });
}
