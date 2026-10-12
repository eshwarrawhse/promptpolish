const SYSTEM_PROMPTS = {
  preserve:
    "You are a prompt editor. The user has written a rough prompt draft. Your job is to fix its structure and clarity while preserving their exact words, phrasing, and tone as much as possible. Do not add new ideas, do not change the voice, do not rephrase more than necessary. Only improve structure: add line breaks where helpful, fix grammar, make the intent unambiguous. Return only the improved prompt, no explanation.",
  improve:
    "You are a prompt engineer. The user has written a rough prompt draft. Improve it into a well-structured LLM prompt. Keep the core intent and topic. You may rephrase for clarity. Add a role, context, or output format instruction if clearly missing and helpful. Do not add constraints or requirements that aren't implied by the original. Return only the improved prompt, no explanation.",
  rewrite:
    "You are an expert prompt engineer. The user has written rough notes describing what they want from an LLM. Extract their core intent and write the most effective possible prompt from scratch. Use best practices: clear role, specific context, explicit constraints, desired output format. Your version can be completely different from their original wording. Return only the final prompt, no explanation, no preamble."
};

const GEMINI_MODEL = 'gemini-1.5-flash';

async function rewrite(text, mode) {
  const { api_key } = await chrome.storage.local.get('api_key');
  if (!api_key) {
    return { error: 'No API key set. Click the extension icon to add your Gemini key.' };
  }

  const systemPrompt = SYSTEM_PROMPTS[mode];
  if (!systemPrompt) return { error: `Unknown mode: ${mode}` };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': api_key
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 800 }
        })
      }
    );

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || `Gemini API error (${res.status})`;
      const badKey = /api key/i.test(msg) || res.status === 401 || res.status === 403;
      return { error: badKey ? 'Invalid API key. Update it in the extension popup.' : msg };
    }

    const result = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!result) return { error: 'Empty response from Gemini.' };
    return { result };
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== 'rewrite') return false;
  rewrite(msg.text, msg.mode).then(sendResponse);
  return true; // keep the message channel open for the async response
});
