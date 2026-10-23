# Polishd

Chrome extension (Manifest V3) for developers who prompt coding agents like Claude Code and Cursor.
Select a prompt you're about to send in ChatGPT, Claude, Gemini, Perplexity, Notion or Google AI Mode, and a pill appears with four modes:

- **touch up**: fixes typos and grammar, keeps your exact words.
- **improve**: restructures a vague request into one an agent executes well (target, change, guardrails, steps).
- **tighten**: same instructions, fewer tokens.
- **scope-check**: catches prompts that cram 3+ unrelated tasks together and offers to split them.

Rewrites run through Google Gemini with your own API key (`gemini-2.0-flash`, falling back to `gemini-2.5-flash`).
improve and tighten learn your style from the last few rewrites you kept. That history stays in `chrome.storage.local` on your device and can be turned off or cleared in the popup.

## Install (unpacked)
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Click the Polishd icon, paste your Gemini API key (free at aistudio.google.com), and click **save**.
4. Open or refresh one of the supported sites, type a prompt, select it, and pick a mode.

## Where to edit things
- Mode system prompts: `MODE_PROMPTS` at the top of `background.js`.
- Pill buttons, long-text limit, scope-check threshold and verb list: constants at the top of `content.js`.
- Style learning (buffer size, on/off, which modes learn): `STYLE_PROFILE_CONFIG` in `styleProfile.js`.
