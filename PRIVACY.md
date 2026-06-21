# Privacy Policy for EleZone

**Last updated:** June 21, 2026

EleZone ("we", "our", or "the extension") is committed to protecting your privacy. This Privacy Policy explains how we handle your data when you use our Chrome Extension.

## 1. Data We Collect
**Short answer: We do not collect, transmit, or store any of your personal data on our servers.**

All operations, including contextual translation, text-to-speech (Read Aloud), Pomodoro tracking, and Optical Character Recognition (OCR), are performed either entirely offline on your local device (using local AI models and Tesseract.js) or via direct API calls from your browser. We do not have servers that intercept or store your browsing data, reading history, or saved vocabulary.

## 2. Where Your Data is Stored
By default, all your settings, saved words, and learning progress (Sparks, Streaks) are stored locally on your device using your browser's local storage (`chrome.storage.local`).

## 3. Google Drive Integration & OAuth Scopes
We offer an optional feature to sync your learning progress and vocabulary to your personal Google Drive. 
If you choose to enable this feature, EleZone will request access to your Google Drive via OAuth.

**How we use the Google Drive scope (`https://www.googleapis.com/auth/drive.file`):**
- We only request the minimum permission needed to create and update a single specific file (`elezone_data.json`) inside your Google Drive.
- **We cannot and do not access, read, or modify any other files or folders in your Google Drive.**
- The data synced to Google Drive contains only your saved vocabulary, app settings, and learning statistics.
- We do not share this data with any third parties.

## 4. Third-Party Services
- **Translation:** If contextual translation features are used, the text you highlight is processed locally via Chrome's Built-in AI (Prompt API).
- **OCR:** Optical Character Recognition is processed locally on your machine using Tesseract.js. No images are uploaded to any external server.

## 5. Changes to This Policy
We may update our Privacy Policy from time to time. Any changes will be reflected on this page with an updated "Last updated" date.

## 6. Contact Us
If you have any questions or suggestions about our Privacy Policy, please contact the developer via the open-source repository repository issues page.
