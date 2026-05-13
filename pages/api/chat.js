import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

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
      model: "gemini-1.5-flash",
      generationConfig: {
        maxOutputTokens: 80,
        temperature: 0.9,
        topP: 0.9,
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
    });

    const result = await model.generateContent(prompt);

    // 安全フィルターでブロックされた場合
    if (!result.response.candidates || result.response.candidates[0]?.finishReason === "SAFETY") {
      return res.status(200).json({ text: null });
    }

    let text = result.response.text().trim();
    if (!text) return res.status(200).json({ text: null });
    text = text.replace(/^[\s「」『』""''\n]+|[\s「」『』""''\n]+$/g, "").trim();
    if (text.length > 200) text = text.slice(0, 200) + "。";
    return res.status(200).json({ text });

  } catch (error) {
    console.error("Gemini error:", error?.message || error);
    if (error?.status === 429 || String(error?.message).includes("429")) {
      return res.status(429).json({ error: "rate_limit" });
    }
    return res.status(500).json({ error: "failed", detail: error?.message });
  }
}
