const SYSTEM_PROMPTS = {
  preserve:
    "You are a prompt editor. The user has written a rough prompt draft. Your job is to fix its structure and clarity while preserving their exact words, phrasing, and tone as much as possible. Do not add new ideas, do not change the voice, do not rephrase more than necessary. Only improve structure: add line breaks where helpful, fix grammar, make the intent unambiguous. Return only the improved prompt, no explanation.",
  improve:
    "You are a prompt engineer. The user has written a rough prompt draft. Improve it into a well-structured LLM prompt. Keep the core intent and topic. You may rephrase for clarity. Add a role, context, or output format instruction if clearly missing and helpful. Do not add constraints or requirements that aren't implied by the original. Return only the improved prompt, no explanation.",
  rewrite:
    "You are an expert prompt engineer. The user has written rough notes describing what they want from an LLM. Extract their core intent and write the most effective possible prompt from scratch. Use best practices: clear role, specific context, explicit constraints, desired output format. Your version can be completely different from their original wording. Return only the final prompt, no explanation, no preamble."
};

async function rewrite(text, mode) {
  const { openai_key } = await chrome.storage.local.get('openai_key');
  if (!openai_key) {
    return { error: 'No API key set. Click the extension icon to add your OpenAI key.' };
  }

  const systemPrompt = SYSTEM_PROMPTS[mode];
  if (!systemPrompt) return { error: `Unknown mode: ${mode}` };

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openai_key}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      })
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || `OpenAI API error (${res.status})`;
      return { error: res.status === 401 ? 'Invalid API key. Update it in the extension popup.' : msg };
    }

    const result = data?.choices?.[0]?.message?.content?.trim();
    if (!result) return { error: 'Empty response from OpenAI.' };
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
