# Chrome Extension Plan: Bookmark, Read Aloud & Translation Aside

## Overview

A Manifest V3 Chrome extension with three core features, fully local (no account, no backend):

1. **Bookmark Word** — select text, right-click, save a colored highlight that persists across visits, with a searchable dashboard.
2. **Read Aloud** — reads the main content of a page aloud, auto-scrolling to the sentence being spoken.
3. **Translation Aside** — shows translated text below original sentences, lazily loaded, ignored by Read Aloud.

No user accounts, no sync, no backend server. Everything is local to the browser via `chrome.storage.local`.

---

## Stack

- **Build:** Vite + CRXJS (`@crxjs/vite-plugin`) — handles MV3 service worker, content script injection, and manifest transformation automatically.
- **UI:** React + TypeScript — used in `popup.html` and `options.html`.
- **Tests:** None for v1.

---

## Architecture

- **Manifest V3** service worker + content scripts.
- **Storage:** `chrome.storage.local` with the `unlimitedStorage` permission requested (default ~10MB cap is too tight once translation caches and many highlights accumulate).
- **Content script** (injected on all pages): selection capture, highlight rendering/re-anchoring, Readability extraction, TTS playback, translation overlay rendering, floating widget.
- **Background service worker:** owns `chrome.contextMenus`, relays save/lookup messages between content script and storage, listens to `chrome.webNavigation.onHistoryStateUpdated` to re-trigger content script logic on SPA navigation.
- **Extension pages:**
  - `popup.html` — browser action popup, opened when user clicks the extension icon.
  - `options.html` — full-tab page with two tabs (Settings / My Bookmarks), opened via `chrome.runtime.openOptionsPage()`.

### Permissions needed
- `contextMenus`
- `storage`
- `unlimitedStorage`
- `scripting`
- `webNavigation` — for detecting SPA navigation via `onHistoryStateUpdated`
- `activeTab` / `<all_urls>` host permission (needed for content script + TTS + translation on arbitrary pages)
- Web Speech API requires no special permission (it's a web API, not a chrome.* API)
- Translator API (on-device) — check current Chrome flag/permission requirements at implementation time, since this API is still rolling out

---

## Browser Action Popup (`popup.html`)

Opened when the user clicks the extension icon. Minimal layout:

```
[Extension icon + name]
[▶ Start Reading]          ← disabled if Readability finds no main content
[Translation Aside  ○/●]   ← disabled with tooltip if on-device API unavailable
[Open Dashboard ↗]
```

- **Start Reading** triggers Read Aloud in the active tab's content script.
- **Translation Aside toggle** persists as `settings.translation.enabled` (global, remembered across sessions).
- **Translation unavailability:** on popup open, probe the Translator API via a capability check (`translation.createTranslator()`). If unavailable, grey out the toggle and show a tooltip: *"Requires Chrome 138+ with language pack installed."*
- No quick-access speed/voice controls — those live in Settings only.

---

## Feature 1: Bookmark Word

### Saving a bookmark
1. User selects text on a page.
2. Right-click → native context menu shows **"Bookmark"** as a submenu parent.
3. Submenu contains 10 fixed color options (red, yellow, cyan, green, blue, orange, purple, pink, teal, gray — exact palette TBD), each rendered as a small pre-made colored-square PNG icon (16x16) + text label, since Chrome's native `contextMenus` API cannot render dynamic CSS colors — only static icons and text.
4. On selection, the content script captures:
   - Selected text (verbatim)
   - ~30–50 characters of prefix context and ~30–50 characters of suffix context (for re-anchoring)
   - Occurrence index — which occurrence (0-indexed) of the prefix+text+suffix match this is, to disambiguate repeated phrases on the same page
   - Full page URL
   - Chosen color
   - Timestamp
5. Entry is saved to `chrome.storage.local` under a structured key (e.g. `bookmark:<uuid>`).
6. The selection is immediately highlighted — no page reload needed.

### Highlight rendering
- Highlight colors are applied via **`chrome.scripting.insertCSS`** (not inline `style` attributes), so they work on pages with strict Content Security Policy (`style-src 'self'`).
- The floating widget and translation overlays are wrapped in **Shadow DOM** to isolate them from page styles (z-index conflicts, font resets, color overrides).

### Re-locating bookmarks on revisit
- On page load, content script searches the rendered text content for the stored prefix+target+suffix combination.
- Uses **occurrence index** to pick the correct match when the same phrase appears more than once on the page.
- If found: apply the highlight via the injected CSS class.
- If not found (page changed too much): mark the bookmark as **"orphaned"** in the dashboard rather than failing silently or guessing a wrong match.
- On SPA navigation, the background service worker listens to `chrome.webNavigation.onHistoryStateUpdated` and sends a message to the content script to re-run re-anchoring for the new URL.
- This text-anchor approach (similar to Hypothesis/web annotation tools and the browser's native "scroll to text fragment") is deliberately chosen over CSS-selector+offset (too brittle to DOM/layout shifts) or naive exact-string matching (too prone to false positives on repeated phrases).

### My Bookmarks dashboard (tab 2 of `options.html`)
- Full-tab page listing all saved bookmarks.
- **Filters:** full URL, color, date saved.
- **Search:** full-text search across saved snippets.
- Orphaned bookmarks are visually marked and can be deleted.
- Clicking an entry: opens/navigates to that URL, and passes a signal (URL hash param or a short-lived `chrome.storage.local` flag keyed by tab) so the content script knows to auto-scroll to and briefly flash the highlighted text once the page loads. This reuses the same text-anchor re-location logic as a normal revisit.

### Bookmark settings
- None beyond the in-context color picker at save time.

---

## Feature 2: Read Aloud

### Triggering playback
- User clicks **▶ Start Reading** in the browser action popup.
- A **minimal floating widget** is injected into the page DOM while playback is active.
- Widget controls: **⏸/▶** (pause/resume) + **⏹** (stop). Auto-dismisses on stop.
- Widget is rendered inside a Shadow DOM to avoid page style conflicts.
- Widget is draggable so users can reposition it away from page content.

### Main content detection
- Use **Readability.js** (Mozilla's algorithm, same one powering Firefox Reader View) to extract the article/main-content DOM, filtering out nav, ads, sidebars, and comments.
- If Readability finds no main content, the Start Reading button in the popup is disabled.

### Sentence-level playback
- Extracted content is split into sentences upfront using **`Intl.Segmenter`** with `granularity: 'sentence'`, seeded with the page's detected language (from `<html lang>` or Readability's output). Falls back to regex (`/[.!?]\s+/`) for unsupported locales.
- Each sentence becomes its own `SpeechSynthesisUtterance`, queued and spoken sequentially — **not** one long utterance relying on `onboundary` events, since boundary-event accuracy and even availability vary significantly across platforms/voices.
- On each utterance's `start` event: highlight that sentence in the page and auto-scroll it into view.
- **Repetition setting:** replay the same utterance N times before advancing to the next sentence.
- **Speed setting:** maps directly to `utterance.rate`.
- **Voice / pitch / volume:** user-configured fixed values in Settings (`utterance.voice`, `.pitch`, `.volume`) — not auto-detected per page language.

### Language mismatch guard
- Since voice/language is manually fixed (not auto-detected per page), there's a real risk of mismatched voice/page-language pairs (mispronunciation, or silent failure on some OSes).
- At speak-time, detect the page's language (e.g. `<html lang>` attribute or Readability's detected language) and compare against the selected voice's language.
- If mismatched, show a small non-blocking inline warning banner, e.g. *"Reading in English voice — page appears to be French."* Never fail silently.

### Interaction with Translation Aside
- Read Aloud **only** speaks and highlights/scrolls the original-language sentence.
- The translated line shown underneath (if Translation Aside is on) is purely static — it does not highlight or sync, by design.
- When Read Aloud is running, it pre-fetches translations a few sentences ahead of the current playback position (regardless of current viewport), so the translation line is already rendered by the time scroll/speech reaches it.

---

## Feature 3: Translation Aside

### Engine
- **Chrome's built-in on-device Translator API** (Gemini Nano) — free, offline, no API key.
  - Requires Chrome 138+ and the relevant language pack downloaded on-device.
  - Pairwise language support is limited and may route through English internally.
- **No fallback.** If the on-device API or required language pack is unavailable, the Translation Aside toggle in the popup is disabled with a tooltip: *"Requires Chrome 138+ with language pack installed."* This is detected via a capability probe on popup open.

### Scope and loading strategy
- **Whole-page mode**, toggled on/off — not per-selection. Toggle state persists globally via `settings.translation.enabled`.
- When enabled, a translated line is inserted below every sentence/paragraph of the Readability-extracted main content.
- **Lazy-loaded** via `IntersectionObserver`: translations are only requested for sentences as they scroll into the viewport, not all upfront.
- When combined with Read Aloud, translation requests are also pre-fetched a few sentences ahead of current playback position, independent of viewport, to avoid lag during continuous narration.
- Translation overlays are rendered inside Shadow DOM to avoid page style conflicts.

### Settings
- Single **global default target language**, applied across all sites (not per-site).

---

## Settings Page (tab 1 of `options.html`)

| Section | Controls |
|---|---|
| Read Aloud | Speed, repetition count, voice picker, pitch, volume |
| Translation | Global default target language |
| Bookmark | None (color chosen at save-time only) |

---

## Data model (`chrome.storage.local`)

```
bookmark:<uuid> = {
  url: string,
  text: string,
  prefix: string,
  suffix: string,
  occurrenceIndex: number,  // 0-indexed; disambiguates repeated prefix+text+suffix on same page
  color: string,            // one of 10 fixed palette values
  createdAt: number,
  orphaned: boolean         // set true if re-anchor fails on a later visit
}

settings = {
  readAloud: {
    speed: number,
    repetition: number,
    voice: string,       // SpeechSynthesisVoice name/identifier
    pitch: number,
    volume: number
  },
  translation: {
    defaultTargetLanguage: string,
    enabled: boolean     // global on/off state, persists across sessions
  }
}
```

---

## Build checklist / assets needed
- 10 small colored-square PNG icons (16x16) for the bookmark color submenu
- Bundle Readability.js into the content script
- `manifest.json` with `contextMenus`, `storage`, `unlimitedStorage`, `scripting`, `webNavigation`, host permissions, content script registration, `options_page`, `action` (for popup)
- `popup.html` — React app: Start Reading button + Translation Aside toggle + Dashboard link
- `options.html` — React app with two-tab layout (Settings / My Bookmarks)
- Content script modules:
  - Selection/bookmark handler
  - Highlight re-anchor engine (with occurrence index)
  - CSS injection via `chrome.scripting.insertCSS`
  - Readability + `Intl.Segmenter` sentence splitter
  - TTS controller
  - Translation overlay controller (Shadow DOM, IntersectionObserver)
  - Floating widget (Shadow DOM, draggable)
- Background service worker: context menu registration + click handler, storage relay, `webNavigation.onHistoryStateUpdated` listener

## Open implementation risks to revisit during build
- Translator API availability/flags may change before release (still rolling out as of writing) — confirm current Chrome version gating at implementation time.
- `SpeechSynthesis` voice lists differ by OS/platform — voice picker in Settings must populate dynamically from `speechSynthesis.getVoices()` and handle the async voice-list-loaded event.
- CRXJS + Vite HMR behavior in content scripts — verify hot reload works correctly for content script modules during development.
- Shadow DOM styling — verify floating widget and translation overlays render correctly across major sites (GitHub, Medium, news sites).
