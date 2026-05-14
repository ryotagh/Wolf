import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

// Vercelのタイムアウトを30秒に延長
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        maxOutputTokens: 400,
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

    if (!result.response.candidates || result.response.candidates[0]?.finishReason === "SAFETY") {
      return res.status(200).json({ text: null });
    }

    let text = result.response.text().trim();
    if (!text) return res.status(200).json({ text: null });

    text = text.replace(/^[\s「」『』""''\n]+|[\s「」『』""''\n]+$/g, "").trim();
    if (text.length > 250) {
      const cut = text.slice(0, 250);
      const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
      text = lastPunct > 80 ? cut.slice(0, lastPunct + 1) : cut + "。";
    }

    return res.status(200).json({ text });
  } catch (error) {
    console.error("Gemini error:", error?.message || error);
    if (error?.status === 429 || String(error?.message).includes("429")) {
      return res.status(429).json({ error: "rate_limit" });
    }
    return res.status(500).json({ error: "failed" });
  }
}
