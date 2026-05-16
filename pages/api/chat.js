import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
export const config = { maxDuration: 30 };

// 2つのAPIキーをローテーション（429が出たら自動で切り替え）
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
].filter(Boolean);
let keyIndex = 0;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  // 最大2回試す（キーを切り替えながら）
  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const apiKey = API_KEYS[keyIndex % API_KEYS.length];
    if (!apiKey) break;
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite",
        generationConfig: { maxOutputTokens: 600, temperature: 1.0, topP: 0.95 },
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      });
      const result = await model.generateContent(prompt);
      keyIndex = (keyIndex + 1) % API_KEYS.length; // 次回は次のキー
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
      if (error?.status === 429 || String(error?.message).includes("429")) {
        keyIndex = (keyIndex + 1) % API_KEYS.length; // キーを切り替えてリトライ
        continue;
      }
      return res.status(500).json({ error: "failed" });
    }
  }
  return res.status(429).json({ error: "rate_limit" });
}
