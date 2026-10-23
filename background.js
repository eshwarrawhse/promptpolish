importScripts('styleProfile.js');

// ============================================================================
// MODE PROMPTS — the system prompt sent to Gemini for each mode.
// This is the product; edit freely. Keys must match the mode ids in content.js.
// improve and tighten also get a style anchor appended (see styleProfile.js).
// 'scopecheck' is only used when the user clicks "split" in the scope-check panel;
// detection itself runs locally in content.js.
// ============================================================================
const MODE_PROMPTS = {
  touchup: `You fix typos, spelling, grammar and punctuation in a prompt a developer is about to send to a coding agent (Claude Code, Cursor). Change as little as possible.
- Keep the developer's exact words, voice, casing and intent. If they write in lowercase, stay lowercase.
- Fix misspellings, doubled words, missing apostrophes, broken grammar, and chat shorthand like "u" -> "you".
- Do not restructure, reorder, summarise, or turn anything into a list.
- Do not add context, constraints, steps or explanations. Do not remove content.
- Never change code, identifiers, file paths, commands, error messages, or anything in backticks, even if it looks misspelled.
Return only the corrected prompt. No quotes, no preamble, no commentary.`,

  improve: `You turn a developer's rough request into a prompt a coding agent (Claude Code, Cursor) will execute well. Scale effort to the input: a short, specific request gets a light touch; a vague or rambling one gets restructured.
A strong agent prompt:
- names the target (file, function, component, endpoint). If the developer implies a target without naming it, tell the agent to locate it ("find the component that renders the login form"). Never invent file names, paths, functions, libraries or details they didn't give or clearly imply.
- states the concrete change and what done looks like.
- adds guardrails where scope could sprawl: what must stay unchanged (existing behaviour, public APIs, unrelated files, tests).
- tells the agent to read the relevant code before editing when the change touches existing code.
- uses short numbered steps only when the work has a natural order; otherwise plain prose.
Don't add requirements the developer didn't ask for or clearly imply. No persona line ("you are an expert..."), no markdown headers or bold. Keep code, identifiers, paths and error messages exactly as written. Match the developer's casing.
Return only the improved prompt, written as the developer would send it. No preamble, no explanation, no quotes.`,

  tighten: `You compress a developer's prompt for a coding agent (Claude Code, Cursor) to the fewest words that still carry every instruction. Same intent, fewer tokens.
- Keep every target, requirement, constraint, condition, exclusion, file name, identifier, number, code snippet and error message. Dropping any of them is a failure.
- Remove filler ("so basically", "what I want you to do is"), hedging ("maybe", "I think", "if possible"), politeness, repetition, and explanation the agent doesn't need in order to act.
- Turn questions and requests into direct imperatives.
- Add nothing new. Don't turn prose into a list unless the original was a list.
- If it's already tight, return it nearly unchanged.
Return only the tightened prompt. No preamble, no explanation, no quotes.`,

  scopecheck: `This prompt for a coding agent contains several separate tasks. Split it into a numbered list, one task per line, in the order they appear.
- Each line is a short, self-contained imperative that keeps the developer's wording, targets and constraints for that task.
- A constraint that applies to every task ("don't touch the api") goes on a final line starting "for all tasks:".
- Don't add, merge or explain tasks.
Return only the list, formatted "1. ..." one per line.`
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

  const basePrompt = MODE_PROMPTS[mode];
  if (!basePrompt) return { error: `Unknown mode: ${mode}` };
  const systemPrompt = basePrompt + await StyleProfile.buildAnchor(mode);

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
    return { result, tokens: data?.usageMetadata?.candidatesTokenCount };
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }
}

// Custom mode was removed in v1.5; drop its leftover setting.
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('custom_prompt'));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === 'rewrite') {
    rewrite(msg.text, msg.mode).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  // A rewrite the user kept (undo window passed without Ctrl+Z). Stored on-device only.
  if (msg?.action === 'accepted') {
    StyleProfile.record(msg.mode, msg.text, msg.site).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
