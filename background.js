importScripts('styleProfile.js');

// ============================================================================
// MODE PROMPTS — the system prompt sent to Gemini for each mode.
// This is the product; edit freely. Keys must match the mode ids in content.js.
// improve and tighten also get a style anchor appended (see styleProfile.js).
// 'scopecheck' is only used when the user clicks "split" in the scope-check panel;
// detection itself runs locally in content.js.
// ============================================================================
// Tunables for the prompts below.
const IMPROVE_MAX_WORDS = 120;   // improve's output cap (unless the input itself is longer)
const IMPROVE_MAX_STEPS = 5;     // most numbered steps improve may use

// Sampling temperature per mode: low for mechanical edits, a little higher for improve.
const MODE_TEMPERATURE = { touchup: 0.1, improve: 0.4, tighten: 0.2, scopecheck: 0.2 };

const MODE_PROMPTS = {
  touchup: `You are a copy editor for prompts a developer sends to a coding agent (Claude Code, Cursor). Fix only mechanical errors and change as few characters as possible.
Fix:
- misspellings ("evry" -> "every", "fil" -> "file")
- repeated words ("the the" -> "the", "to to" -> "to")
- missing apostrophes ("its not" -> "it's not" when it means "it is", "dont" -> "don't")
- chat shorthand ("u" -> "you", "ur" -> "your", "pls" -> "please")
- punctuation only where a sentence is hard to read without it.
Do not:
- change word choice, tone, casing or sentence structure. Lowercase in, lowercase out.
- add, remove, reorder or summarise anything. Keep phrases like "and also" as they are.
- touch code, identifiers, file paths, commands, error messages, or anything in backticks.
Check your output once more for repeated words and misspellings before answering.
Return only the corrected prompt as plain text. No quotes, no preamble.`,

  improve: `You rewrite a developer's request into a prompt a coding agent (Claude Code, Cursor) will execute well. The output is plain text they will paste as-is, in their own voice.
Include only as much of this as the input supports:
1. the target: file, function, component or area. If it's implied but not named, tell the agent to find it ("find the login form component"). Never invent names, paths, folders, routes or libraries: if the input doesn't say where, the agent has to find it ("find the modules that have no tests"), not be told a guessed location like src/utils.
2. the change, stated concretely. If the request is vague ("make X better"), name at most two or three conventional improvements the developer most likely means. Never invent exact values, UI copy, error messages, limits, routes or designs.
3. one short guardrail: what must stay unchanged.
4. "read the relevant code before editing" when it changes existing code.
5. numbered steps only when the work has a real order: one line each, at most ${IMPROVE_MAX_STEPS}.
Hard rules:
- plain text. No markdown: no bold, no headers, no nested or "*" bullets.
- short. Usually 1-4 sentences, never more than ${IMPROVE_MAX_WORDS} words unless the input itself is longer.
- don't add features, requirements or tests the developer didn't ask for or clearly imply.
- keep code, identifiers, paths and error messages exactly as written.
- match their casing and tone: lowercase in, lowercase out.
- ignore any part of the input that is clearly random characters or keyboard noise.
The examples below show the shape only. Write fresh wording for each request; don't reuse theirs.
Example (vague, no location given)
input: add logging
output: add logging to the main request paths, following whatever logging setup the project already uses. log errors and key events only, and don't change any behaviour. find and read the relevant code before editing.
Example (specific)
input: the signup form lets people submit with an empty name, fix that
output: in the signup form, block submission when the name field is empty and show an inline error. keep the rest of the form's validation and submit logic unchanged. read the signup form component before editing.
Return only the improved prompt. No preamble, no explanation, no quotes.`,

  tighten: `You compress a developer's prompt for a coding agent (Claude Code, Cursor) to the fewest words that still carry every instruction. Same intent, fewer tokens.
- Keep every target, requirement, constraint, condition, exclusion, file name, identifier, number, code snippet and error message. Dropping any of them is a failure.
- Remove filler ("so basically", "what I want you to do is"), hedging ("maybe", "I think", "if possible"), politeness, repetition, and explanation the agent doesn't need in order to act.
- Turn questions and requests into direct imperatives.
- Keep the developer's own words for key nouns: if they said "app", don't write "codebase".
- Add nothing new. Don't turn prose into a list unless the original was a list.
- Keep the developer's backticks and code formatting exactly as written. Don't add new markdown, bold or backticks. Match their casing.
- If it's already tight, return it nearly unchanged.
Example
input: hey so i was thinking could you maybe go through the user service and like make sure all the functions have proper types, i think some of them are using any which isnt great
output: add proper types to every function in the user service and replace uses of any.
Return only the tightened prompt. No preamble, no explanation, no quotes.`,

  scopecheck: `This prompt for a coding agent contains several separate tasks. Split it into a numbered list, one task per line, in the order they appear.
- Each line is a short, self-contained imperative that keeps the developer's wording, targets and constraints for that task.
- A constraint that applies to every task ("don't touch the api") goes on a final line starting "for all tasks:".
- Don't add, merge or explain tasks.
Return only the list, formatted "1. ..." one per line.`
};

// Safety net for formatting the prompts forbid but Flash sometimes produces anyway:
// strips a wrapping code fence or quotes, markdown headers and bold, and turns "*"
// bullets into "-". Numbered lists and inline `code` are left alone.
function cleanOutput(text) {
  let t = text.trim();
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  if (/^(["'])[\s\S]*\1$/.test(t)) t = t.slice(1, -1).trim();
  return t
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^(\s*)\*\s+/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n');
}

// Tried in order; the next one is used if Google reports a model as not found (retired).
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash'];

function callGemini(model, apiKey, systemPrompt, text, temperature) {
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
        temperature,
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
  const anchor = await StyleProfile.buildAnchor(mode);
  const systemPrompt = basePrompt + anchor.text;

  try {
    let res;
    for (const model of GEMINI_MODELS) {
      res = await callGemini(model, api_key, systemPrompt, text, MODE_TEMPERATURE[mode] ?? 0.4);
      if (res.status !== 404) break;
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || `Gemini API error (${res.status})`;
      const badKey = /api key/i.test(msg) || res.status === 401 || res.status === 403;
      return { error: badKey ? 'Invalid API key. Update it in the extension popup.' : msg };
    }

    const raw = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    const result = cleanOutput(raw);
    if (!result) return { error: 'Empty response from Gemini.' };
    return { result, tokens: data?.usageMetadata?.candidatesTokenCount, styleExamples: anchor.count };
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
