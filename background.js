const SYSTEM_PROMPTS = {
  preserve:
    "You are a prompt editor. The user has written a rough prompt draft. Fix grammar errors and ambiguous phrasing only. Do not change the person's vocabulary, sentence structure, or tone. Do not add ideas, formatting, or instructions they didn't write. Return only the edited prompt, no explanation.",
  improve:
    "You are a prompt engineer. The user has written a rough prompt draft. Improve it into a well-structured LLM prompt. Keep the core intent and topic. You may rephrase for clarity. Add a role, context, or output format instruction if clearly missing and helpful. Do not add constraints or requirements that aren't implied by the original. Return only the improved prompt, no explanation.",
  rewrite:
    "You are an expert prompt engineer. The user has written rough notes describing what they want from an LLM. Extract their core intent and write the most effective possible prompt from scratch. Keep the output to 3-6 sentences maximum. Do not use headers, bullet points, or numbered lists. Return only the final prompt as plain prose, no explanation, no preamble."
};

// Tried in order; the next one is used if Google reports a model as not found (retired).
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash'];

function callGemini(model, apiKey, systemPrompt, text) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 800,
        // 2.5 models "think" by default, which would eat into the 800-token output budget.
        ...(model.startsWith('gemini-2.5') && { thinkingConfig: { thinkingBudget: 0 } })
      }
    })
  });
}

async function rewrite(text, mode) {
  const { api_key } = await chrome.storage.local.get('api_key');
  if (!api_key) {
    return { error: 'No API key set. Click the extension icon to add your Gemini key.' };
  }

  const systemPrompt = SYSTEM_PROMPTS[mode];
  if (!systemPrompt) return { error: `Unknown mode: ${mode}` };

  try {
    let res;
    for (const model of GEMINI_MODELS) {
      res = await callGemini(model, api_key, systemPrompt, text);
      if (res.status !== 404) break;
    }

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
