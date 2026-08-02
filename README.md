# EleZone

> **Note:** This project is a supervised vibe-coded product (built entirely by AI under human supervision).

EleZone is a powerful, privacy-first Chrome Extension designed to turn your casual web browsing into a seamless learning experience. It combines language learning tools with focus and gamification features, all running locally on your device.

## 🌟 Key Features

*   **Context-Aware Translation:** Highlight any word or phrase on any webpage to get a translation that understands the sentence it's in — not just a generic dictionary guess.
*   **Video Mode (Netflix & YouTube):** Learn from what you were going to watch anyway — a full transcript beside the picture, dual subtitles under it, and every word one click from a definition. [See below](#-video-mode).
*   **Read Aloud:** Turn any English article into a listening session, with each sentence highlighted as it's spoken and an optional side-by-side translation.
*   **Extract Text from Images:** Pull readable, translatable text out of pictures, comics, or manga panels right from the page.
*   **Vocabulary Flashcards:** Save any word you look up and review it later with four practice modes — Passive, Typing, Listening, and Multiple Choice.
*   **Smart Reminders:** Get a quiet notification right when you're about to forget a saved word, so a quick review keeps it in memory.
*   **Focus & Breathe:** An integrated Pomodoro timer and guided box breathing to help you study in focused, low-stress sprints.
*   **Gamification & Tough Love:** Earn "Sparks" and build daily streaks. But beware: if you slack off, the app will roast you!
*   **Cloud Sync:** Your words, settings, and progress sync privately and directly to your own Google Drive.

## 🎬 Video Mode

Turns a Netflix title or a YouTube video into a study session, without leaving the player.

*   **Dual subtitles.** The spoken line and its translation together. Where the site publishes a translation of its own — a Netflix subtitle track in your language, or a YouTube caption track — that is used in preference to machine translation, because a human one reads better. Machine translation fills the gap when there isn't one.
*   **Full transcript sidebar.** Every line of the film, in order, with the current one highlighted and following along. Click any line to jump the video there.
*   **Click a word, get a definition.** Anywhere in the dialogue or the transcript. Playback pauses while you read and picks up when you close it. Saved words are underlined everywhere they appear later in the film, and ones the review schedule says are due are marked more strongly — meeting a word in real dialogue exactly when you were about to forget it is the point.
*   **Repeat and shadowing.** Play each line up to five times, or freeze after every line so you can say it back. The gap is as long as the line took to say. Same behaviour as Read Aloud, deliberately.
*   **Auto-pause on a saved word.** Stop whenever a line contains something from your library.
*   **Keyboard.** `A` / `D` previous and next line, `R` replay, `Z` toggle the translation, `Space` to move on from a pause. Chosen to avoid the keys each player already uses.

Sentences, not fragments. Streaming subtitles are cut to fit the screen and to be read at a comfortable pace, not by where the sentence ends, so lines like "What the hell" / "are you made of?" are stitched back together before you see them. Auto-generated YouTube captions are grouped by where the speaker actually paused instead, since their timings mean something different.

**Netflix** shrinks the picture and puts the dialogue in a band below it, so nothing is ever covered. **YouTube** leaves its page exactly as it is: the dialogue floats over the picture with no backdrop until you point at it, and you can drag it anywhere and resize it. In fullscreen both take the same shape.

Video Mode needs subtitles to be switched on in the player. On YouTube it stays out of the way unless there are captions in the language you're learning — it will not light up over a video in your own language, and it never skips or blocks ads.

## 🛠 Tech Stack

EleZone is built with modern web technologies:

*   **Framework:** [React](https://react.dev/)
*   **Language:** [TypeScript](https://www.typescriptlang.org/)
*   **Build Tool:** [Vite](https://vitejs.dev/)
*   **Extension Architecture:** Chrome Extension Manifest V3
*   **OCR Engine:** [Tesseract.js](https://tesseract.projectnaptha.com/) (Running locally via Offscreen Document)
*   **AI Translation:** Chrome's Built-in AI Prompt API
*   **Cloud Sync:** Google Drive API (OAuth 2.0)

## 📦 Getting Started

### Prerequisites

*   [Node.js](https://nodejs.org/) (v18 or higher recommended)
*   [Yarn](https://yarnpkg.com/) (Package Manager)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/great-elephant/elezone.git
    cd elezone
    ```

2.  **Install dependencies:**
    ```bash
    yarn
    ```

3.  **Build the extension:**
    ```bash
    yarn build
    ```
    *This will generate a `dist` directory containing the compiled extension.*

### Loading into Chrome

1.  Open Google Chrome and navigate to `chrome://extensions/`.
2.  Enable **Developer mode** (toggle switch in the top right corner).
3.  Click the **Load unpacked** button in the top left.
4.  Select the `dist` directory that was generated in the build step.
5.  Pin EleZone to your toolbar and start learning!

## 🔧 Development

To run the project in development mode with hot-reloading (for UI components):

```bash
yarn dev
```

*(Note: Chrome extensions have limitations with hot-reloading for background scripts and content scripts. You may need to manually reload the extension in `chrome://extensions/` after making changes to those files).*

## 🔒 Privacy

EleZone is built with privacy in mind. We do not collect, store, or transmit your data to any proprietary servers. All operations (AI translation, OCR) run entirely locally on your device. Syncing is done directly between your browser and your personal Google Drive.

For more details, please read our [Privacy Policy](PRIVACY.md).

## 📄 License

This project is licensed under the MIT License.
