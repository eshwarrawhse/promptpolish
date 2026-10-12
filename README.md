# PromptPolish

Chrome extension (Manifest V3) that rewrites rough prompt drafts on ChatGPT, Claude, Gemini, Perplexity and Notion.
Select text in the prompt box → pick **Preserve**, **Improve** or **Rewrite** → the selection is replaced with the rewritten prompt (via Google Gemini `gemini-2.0-flash`, falling back to `gemini-2.5-flash`).

## Install (unpacked)
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Click the PromptPolish icon, paste your Gemini API key, and click **Save**.
4. Open or refresh chatgpt.com or claude.ai, type a draft, select it, and pick a mode.
