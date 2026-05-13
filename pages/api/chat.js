// pages/api/chat.js
// サーバーサイドでGeminiを呼ぶ（APIキーをブラウザに出さない）

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "prompt required" });
  }

  const key = process.env.GEMINI_API_KEY; // NEXT_PUBLIC_なし = サーバーのみ
  if (!key) {
    return res.status(500).json({ error: "API key not configured" });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 200,
            temperature: 1.0,
            topP: 0.95,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          ],
        }),
      }
    );

    if (geminiRes.status === 429) {
      return res.status(429).json({ error: "rate_limit" });
    }

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({ error: "gemini_error" });
    }

    const data = await geminiRes.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;

    if (!text) {
      return res.status(200).json({ text: null });
    }

    text = text.replace(/^[\s「」『』""''\n]+|[\s「」『』""''\n]+$/g, "").trim();
    if (text.length > 230) text = text.slice(0, 230) + "。";

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: "fetch_failed" });
  }
}
