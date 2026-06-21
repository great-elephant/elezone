# EleZone

> **Note:** This project is a supervised vibe-coded product (built entirely by AI under human supervision).

EleZone is a powerful, privacy-first Chrome Extension designed to turn your casual web browsing into a seamless learning experience. It combines language learning tools with focus and gamification features, all running locally on your device.

## 🌟 Key Features

*   **Context-Aware Translation:** Highlight any word or phrase on any webpage to get AI-powered translations that understand the exact context of the sentence (Powered by Chrome's Built-in Prompt AI).
*   **Immersive Read Aloud:** Turn any English article into a listening practice session with native pronunciation and side-by-side translation.
*   **Image to Text (OCR):** Extract and translate text directly from images or manga on the web using our built-in OCR tool.
*   **Focus & Breathe:** Integrated Pomodoro timer and Box Breathing techniques to reduce anxiety and improve memory retention during study sprints.
*   **Gamification & Tough Love:** Earn "Sparks" and build daily streaks. But beware: if you slack off, the app will roast you!
*   **Cloud Sync:** Securely sync your vocabulary, settings, and learning progress directly to your personal Google Drive.

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
