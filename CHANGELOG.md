# Changelog

## [0.7.0](https://github.com/great-elephant/elezone/compare/0.6.0...0.7.0) (2026-09-20)

### Features

* add eye toggle to mask focus session task name ([5d2496b](https://github.com/great-elephant/elezone/commit/5d2496bd3eb6e02e3359ded8d14d86f9507d3c86))
* **dictionary:** save and show the sentence translation, editable before saving ([b48df1a](https://github.com/great-elephant/elezone/commit/b48df1ad035e939d8dc8afdecdb0d30aedcf5b45))
* **library:** add fsrs grading, notification muting, and custom deck colors ([c43d8f1](https://github.com/great-elephant/elezone/commit/c43d8f172ccb84c9d0ec6fc5c16736fc90a80a92))
* **phonetics:** make ipa editable in the save popup and reveal look-ahead ipa on focus ([d548ad6](https://github.com/great-elephant/elezone/commit/d548ad6024663f0214fd23220ad070506b0fc3f5))
* **read-aloud:** add a settings toggle for the audio keepalive, off by default ([bca98bc](https://github.com/great-elephant/elezone/commit/bca98bc4222a5cb95d4cfa58581d47b7b63d34fd))
* **read-aloud:** add sentence-level repeat mode for shadowing ([d862cb7](https://github.com/great-elephant/elezone/commit/d862cb7dc1e60780087516d9e19b0aeb05597ff4))
* **read-aloud:** add shadowing gap ratio control ([23b6889](https://github.com/great-elephant/elezone/commit/23b688912e2592fa48f47f25f21b46f54dd3d5ec))
* **read-aloud:** raise the repeat and shadowing gap limits to 9 ([b36f73b](https://github.com/great-elephant/elezone/commit/b36f73bde7d60b654a216c10324e552f0063663c))
* **read-aloud:** say up front that the first ipa lookup can be slow ([4edeca2](https://github.com/great-elephant/elezone/commit/4edeca23a213eac1b58315769d93f2f579279f94))
* **translation:** add chinese (simplified) reading support with pinyin ([a649621](https://github.com/great-elephant/elezone/commit/a649621a100679206adc2300d47508538f39692b))
* **translation:** resolve chinese source language from the text, not a lang attribute ([571b6a2](https://github.com/great-elephant/elezone/commit/571b6a2b2563f8d6d2739de103b1361cdbedff1a))
* **video-mode:** add subtitle hide toggle beside sidebar toggle ([ce2f0b9](https://github.com/great-elephant/elezone/commit/ce2f0b9cc084ccd222069c1ca1f58ff45f1c2a03))
* **video-mode:** stack subtitle/sidebar toggle buttons vertically and make them draggable ([3259bb8](https://github.com/great-elephant/elezone/commit/3259bb8d1cc52bb8932b32655c37e17c96a36e55))

### Bug Fixes

* **dictionary:** fetch phonetics/pinyin in parallel and use background cache in save modal ([43ff784](https://github.com/great-elephant/elezone/commit/43ff784e4623fa14465a71d2c54a7161eb57fc6b))
* **dictionary:** find phonetics for possessives and hyphenated words ([891ae4f](https://github.com/great-elephant/elezone/commit/891ae4f3506c3f826e59611b436ec30d95daa40c))
* **dictionary:** keep abbreviations like "T. Rowe" inside the save popup sentence ([8c025bb](https://github.com/great-elephant/elezone/commit/8c025bb18f641a50ca66d88c4c0935e466fbeac7))
* **notifications:** support active-hours window that wraps past midnight ([038bc98](https://github.com/great-elephant/elezone/commit/038bc98699f4d933c76d6cade3411e7a71b2afbd))
* **read-aloud:** fix phonetics word-wrap split by intra-sentence whitespace ([6c98645](https://github.com/great-elephant/elezone/commit/6c9864542c3e0e2ec17b046ec6655ddb1be52bca))
* **read-aloud:** keep phonetics visible after toggling shadowing off ([690e206](https://github.com/great-elephant/elezone/commit/690e20600a47fcc977d95d474cf40828d9e2bcc9))
* **read-aloud:** keep saved highlights alive across phonetics word-wrap ([a4e00a0](https://github.com/great-elephant/elezone/commit/a4e00a07bbbd6a30ae0f86f4e5667df8bd284935))
* **read-aloud:** route every speak through one path so voice settings apply everywhere ([d8afa0c](https://github.com/great-elephant/elezone/commit/d8afa0c0a8bbc6b40b6193c3bcea2d173e467677))
* **read-aloud:** stop bluetooth earbuds swallowing the first word ([352769d](https://github.com/great-elephant/elezone/commit/352769df18b3f7af43f259179cdcba478fa7be69))
* **read-aloud:** stop engine before re-speaking a sentence ([76e4b11](https://github.com/great-elephant/elezone/commit/76e4b11400d18f590730eee04cb8980d7f152fc5))
* **read-aloud:** stop reading on page navigation ([6355e2a](https://github.com/great-elephant/elezone/commit/6355e2a3d4db2af708a59fec7d6bc213161d99ef))
* **readaloud:** speak the right voice for a non-english card ([0c6e419](https://github.com/great-elephant/elezone/commit/0c6e4199cd0e20ce696b14318d8e052a60bbdaed))
* **translate:** dedupe and cache translate requests to stop duplicate google calls ([a661b19](https://github.com/great-elephant/elezone/commit/a661b19c6861c614d67bef98be97a038fe18d79c))
* **translation:** send google requests through a cached, batched background service ([0c20bbf](https://github.com/great-elephant/elezone/commit/0c20bbf2fb3658389980fb62693a42100235616c))
* **translation:** wait longer for a slow dictionary api response ([9f81b73](https://github.com/great-elephant/elezone/commit/9f81b73ccbb8fc2634844005685b825c8f00e502))
* **video-mode:** prefetch upcoming lines' phonetics sequentially ([74253c2](https://github.com/great-elephant/elezone/commit/74253c2b276a1ac03529e6dda27b3fc4f7680ed9))
* **video-mode:** raise default subtitle strip position on YouTube ([1570435](https://github.com/great-elephant/elezone/commit/1570435a477716baba234fa3c476e0c5c169f1ad))
* **video-mode:** save subtitle words with a valid id and creation time ([845e2ac](https://github.com/great-elephant/elezone/commit/845e2aca75d411563bb1077b90fb8538317ab28b))
* **video-mode:** saved-word tooltip shows deck name instead of raw color code ([f1c56dc](https://github.com/great-elephant/elezone/commit/f1c56dca4f253b712bcbe0021c90bb009cda204c))
* **video-mode:** stop shadowing hold on current line, not next, on YouTube ([28c9f2a](https://github.com/great-elephant/elezone/commit/28c9f2a09467fb8470a031365a73ea8d4c1f9064))

## [0.6.0](https://github.com/great-elephant/elezone/compare/0.5.0...0.6.0) (2026-08-24)

### Features

* **ocr:** add re-crop button to text-from-image popup ([72d16c9](https://github.com/great-elephant/elezone/commit/72d16c9bd4924509bec70139bbd6fbfdc7a8d67a))
* **phonetics:** add configurable dictionary-based IPA source with google romanization fallback ([bc03560](https://github.com/great-elephant/elezone/commit/bc03560f6ece4a4ccb2e30bd8c4b3155ad00d5b4))
* **read-aloud:** make pronunciation lookups faster and more reliable ([9d8c71e](https://github.com/great-elephant/elezone/commit/9d8c71ea16983789f0a19dd264df9720372f2edb))
* **read-aloud:** show pronunciation under words while reading aloud ([9e30162](https://github.com/great-elephant/elezone/commit/9e30162b202377d1b7c7fd45d40b6210e07f9b01))
* **video-mode:** add hover tooltip for saved words in subtitle/sidebar ([f3d4949](https://github.com/great-elephant/elezone/commit/f3d4949616e157506e0c9b6c5d68661d1ad2791a))
* **video-mode:** auto-show IPA phonetics under English words ([8a01efe](https://github.com/great-elephant/elezone/commit/8a01efe8678242aab3794d6b2408fb76d5b852d7))

### Bug Fixes

* correct logic bugs found across all features ([aef842e](https://github.com/great-elephant/elezone/commit/aef842e23013da8a50eb7e337a600af588213209))
* **ocr:** stop translated text getting stuck on some hosting pages ([497d70f](https://github.com/great-elephant/elezone/commit/497d70f618fd377c50f4f870a0bc60e487f2ff4e))

## [0.5.0](https://github.com/great-elephant/elezone/compare/0.4.0...0.5.0) (2026-08-02)

### Features

* **video-mode:** add Netflix and YouTube study mode with dual subtitles and transcript ([d642ac8](https://github.com/great-elephant/elezone/commit/d642ac88110bb241580d1310bc9267847744c3d8))

### Bug Fixes

* **read-aloud:** split shadowing at punctuation ([0a094fb](https://github.com/great-elephant/elezone/commit/0a094fb2418bf0a037b22d46b845c2b1e9c64691))

## [0.4.0](https://github.com/great-elephant/elezone/compare/0.3.0...0.4.0) (2026-07-27)

### Features

* **context-menu:** add Listen option next to Image to text ([81f1aa5](https://github.com/great-elephant/elezone/commit/81f1aa5e274864dc08e20df04649f7b7d8499816))
* **pomodoro:** improve Focus & Breathe UX (settings shortcut, task access, clarity) ([a788c4d](https://github.com/great-elephant/elezone/commit/a788c4d99257eafbd5de528522ed628255fef1b5))
* **read-aloud:** persist focus/spotlight mode to user settings ([8f08b50](https://github.com/great-elephant/elezone/commit/8f08b500cffcfc8a9acd16ff8f8f910d52edcccb))
* **selection-chip:** replace + Save button with plain logo icon ([6a31b6e](https://github.com/great-elephant/elezone/commit/6a31b6ea5c6663999d19847aa26f3feabe955384))
* **translation:** apply popup Translate toggle to the page immediately ([5bcd4f4](https://github.com/great-elephant/elezone/commit/5bcd4f4d5512e92426e8ba273c986f36a0f536bc))

### Bug Fixes

* **content-discovery:** detect div-based paragraphs and read main content fully ([f2081f2](https://github.com/great-elephant/elezone/commit/f2081f26538f77ff30ddbab0216ad3fae237eead))
* **dictionary:** move IPA phonetics to its own line ([97f2821](https://github.com/great-elephant/elezone/commit/97f2821f5055bc59dcd8e09321e5cbdd7d8031b0))
* **dictionary:** stop stale async responses from corrupting the popup/page ([c7336da](https://github.com/great-elephant/elezone/commit/c7336dac05faa9965e7919ccc3c1ad3d2485fb93))
* **dragging:** account for scrollbar width on flying widget and OCR result ([3298902](https://github.com/great-elephant/elezone/commit/32989026ebe08195d637aa8e7b61bf06f164af8f))
* **gamification:** guard divide-by-zero in level progress bar at max level ([e6db447](https://github.com/great-elephant/elezone/commit/e6db447943818d3cbaf9a2981fe3153e215b3c08))
* **gamification:** serialize logActivity to stop lost Sparks updates ([ddf5c63](https://github.com/great-elephant/elezone/commit/ddf5c63b32d8e55527804dc7c176c82aec80d5d2))
* **library:** clear stale orphaned flag once an item is anchorable again ([27caac1](https://github.com/great-elephant/elezone/commit/27caac1c67f4c1621babeb6200a1d97b9dd4df4e))
* **ocr:** fix crop coordinate mapping when screenshot is scrollbar-trimmed ([9218b57](https://github.com/great-elephant/elezone/commit/9218b57c99e95a46c3faeb7af5d194f69a5e8f6f))
* **ocr:** serialize offscreen recognize calls to stop progress cross-delivery ([d3ff7ef](https://github.com/great-elephant/elezone/commit/d3ff7efac25f360200c7efe47e913071c0f91944))
* **pomodoro:** clear stale breathing ring when the cycle is set to all-zero ([b59f049](https://github.com/great-elephant/elezone/commit/b59f0498ef1810a3d040690d501548e91d5b35f3))
* **pomodoro:** resuming a paused session no longer restarts the breathing cycle ([4337a92](https://github.com/great-elephant/elezone/commit/4337a92773912c7290234b07c888c74ca9127d42))
* **popup:** show full task text on hover via tooltip ([a987c91](https://github.com/great-elephant/elezone/commit/a987c913a2ea32d6a2c3dfa29273b3dfd0750b7d))
* **popup:** use accent color for Add All button instead of red ([6612277](https://github.com/great-elephant/elezone/commit/6612277f965bdd265f362a155b961ab65f2950a3))
* **read-aloud:** dictionary speak no longer kills mini-player session ([533bffd](https://github.com/great-elephant/elezone/commit/533bffda99c80dd680747307b383f604493c8910))
* **read-aloud:** media-key play/pause and volume restart could kill the session ([62b54f0](https://github.com/great-elephant/elezone/commit/62b54f0d7b51da3497cb5af24250c44cf40b9ea5))
* **read-aloud:** pause stops audio immediately, resume no longer kills mini-player ([04c2b5d](https://github.com/great-elephant/elezone/commit/04c2b5de66a2153ce3fbc5fa266b32cb2d4c0854))
* **read-aloud:** prevent OCR and highlight-tooltip speak from killing mini-player ([9e84862](https://github.com/great-elephant/elezone/commit/9e8486296d6bd73f17e5cb3073d454bc79238713))
* **reminders:** clear stale notification on missing item, dedupe test path, prevent pileup ([6823cbf](https://github.com/great-elephant/elezone/commit/6823cbfa7aee37c3b391d59e4ec3c07d3eedd61d))
* **reminders:** don't re-notify a due item that's already mid-answer ([d72d5b9](https://github.com/great-elephant/elezone/commit/d72d5b939c94a60a164abc6f65c1bc5d72580c29))
* **roast:** don't count the still-in-progress day as a missed day ([40aded4](https://github.com/great-elephant/elezone/commit/40aded4e1b2f6791ec72b47849b9b77098e3cdc7))
* **study:** persist SRS scheduling and dedupe multiple-choice options ([c255774](https://github.com/great-elephant/elezone/commit/c2557740912ab4af12c5a0296e4206ff1840a5f4))
* **sync:** stop Drive sync from silently losing data on failed requests ([e5fb58a](https://github.com/great-elephant/elezone/commit/e5fb58af7f64b1f6524e36eaa982760370eb5658))
* **translation-panel:** account for scrollbar width when clamping drag boundaries ([dcde6a5](https://github.com/great-elephant/elezone/commit/dcde6a5b94e749643b80891af9d32ee12c2c9007))

## [0.3.0](https://github.com/great-elephant/elezone/compare/0.2.0...0.3.0) (2026-07-04)

### Features

* add a deck color picker to the save popover ([6660eec](https://github.com/great-elephant/elezone/commit/6660eecc7d50998254cf45e64a3b20f72340f2b0))
* add combo streak, ember burst, and pop to reward feedback ([b6bb741](https://github.com/great-elephant/elezone/commit/b6bb74147ca6436ab46da482a408bac0e5dbe1a0))
* add configurable roast intensity, English only ([874a05f](https://github.com/great-elephant/elezone/commit/874a05f15f840be4da8694efd7725ae66eaf46d7))
* add finished state, resume, sleep timer, and SPA handling to read-aloud ([a30d775](https://github.com/great-elephant/elezone/commit/a30d7751b0ba756109d74515abd1c85d7e8e8ef4))
* add karaoke word highlighting and click-a-word-to-define to read-aloud ([6abbe2a](https://github.com/great-elephant/elezone/commit/6abbe2ac4acc4691bd710ccbb83151d1c9aa6e53))
* add OCR support for PDFs via a standalone crop window ([de0b253](https://github.com/great-elephant/elezone/commit/de0b253395a859772e2c8ae3f8efc0fc729dc521))
* add read-aloud button to dictionary save popover ([d629b00](https://github.com/great-elephant/elezone/commit/d629b00ea8e5ad9e9028eb8646b6074a1c150641))
* add selection save chip and in-the-moment learning feedback ([2cfc5bd](https://github.com/great-elephant/elezone/commit/2cfc5bda1ebf2e34b2f526e59b35cf4359952b57))
* add shadowing mode, repeat control, and save-sentence to read-aloud ([93b7850](https://github.com/great-elephant/elezone/commit/93b7850b25f76ddf31107c25fffda7d9ed441484))
* add ways to start read-aloud (shortcut, Listen chip, paragraph play) ([84b6e93](https://github.com/great-elephant/elezone/commit/84b6e93e03a471bc3fe4fbcebf53a32bb02aa157))
* auto-pick read-aloud voices and add an in-player voice switcher ([a1a521c](https://github.com/great-elephant/elezone/commit/a1a521cbc841ccb566c5e1aca0f7afed989189f6))
* extend focus-mode spotlight to cover the sentence's translation ([6358012](https://github.com/great-elephant/elezone/commit/63580126bee5c48339ffacbcce1dd34550e03c6e))
* gate Listen chip to article pages and brand it with the logo ([cf4e445](https://github.com/great-elephant/elezone/commit/cf4e44580194a9888246a349ee09d4d778fc0ed3))
* improve accessibility and collapse settings into sections ([34aff62](https://github.com/great-elephant/elezone/commit/34aff6208a1a541ca428cab0593333e362274d54))
* keep the study and summary screens within one viewport ([15b0d96](https://github.com/great-elephant/elezone/commit/15b0d965e0c0e1b76771f77ec806989a76e6256e))
* open the dashboard from the popup logo instead of a button ([1fc59da](https://github.com/great-elephant/elezone/commit/1fc59da33c980066492f321676e4416625b8d11e))
* overhaul OCR crop overlay — freeze correctly, dedupe sessions, fix races ([ed99407](https://github.com/great-elephant/elezone/commit/ed99407bce76151e34fbc872e11d94e84658fb41))
* polish read-aloud accessibility and hit targets ([0fee1e6](https://github.com/great-elephant/elezone/commit/0fee1e60d4af2c635e535f69256710abd5454864))
* polish read-aloud highlight, scroll, and add a focus mode ([ab60b89](https://github.com/great-elephant/elezone/commit/ab60b893b8ddf9a6a181aaf1fc30e3800b8f7776))
* redesign the Session Complete screen with an accuracy ring ([d9e3fa0](https://github.com/great-elephant/elezone/commit/d9e3fa0907792c487ae388bd0e052a4588666deb))
* remove save-sentence, sleep timer, and click-to-define from read-aloud ([3524675](https://github.com/great-elephant/elezone/commit/35246758410cfcc2210f7a55ae941a2d55278d7e))
* replace the read-aloud widget with a full mini-player ([8373f7a](https://github.com/great-elephant/elezone/commit/8373f7a3cf1c1d02c36b2745de1b87f972647b5b))
* show the save chip when selecting text in the OCR popup ([b93074d](https://github.com/great-elephant/elezone/commit/b93074d9716c92a4f489a3bef788b7ef1dc9359f))
* split the popup into Read Aloud and Translate cards, mirror the player ([b18f30b](https://github.com/great-elephant/elezone/commit/b18f30b2a826325ff2e06965abfffecf6c93dadb))

### Bug Fixes

* clarify on-device AI status badge and flag Gemini Nano as experimental ([08ff012](https://github.com/great-elephant/elezone/commit/08ff0128e14e5d999a97acb7f0c8054b8ec1d70a))
* correct read-aloud sentence highlighting, scrolling, and translation overlay lookup ([29a7c63](https://github.com/great-elephant/elezone/commit/29a7c63e5426081aad1bbfbe4fa84059dc5ba07c))
* exclude corrected answers from the combo streak ([be9da64](https://github.com/great-elephant/elezone/commit/be9da64ea1cacbdd1f1ac4da484bda4364d545ca))
* filter related-articles, byline, and link-heavy noise from content discovery ([74ed8d0](https://github.com/great-elephant/elezone/commit/74ed8d0b9030682db2d6d4fb1ac2f650c549733f))
* **read-aloud:** fix session-teardown races and shadowing gap highlight ([e97a875](https://github.com/great-elephant/elezone/commit/e97a8757900bca853eda775854568c65a1241021))
* **read-aloud:** remove unreliable Listen/Resume chip and tidy popup ([3cf989b](https://github.com/great-elephant/elezone/commit/3cf989baac5445491a8872ac7f35cc39004fa2a7))
* track focus time using real elapsed time instead of message count ([be1dd73](https://github.com/great-elephant/elezone/commit/be1dd73507b17729c478f4fd691a536d3ada11ef))

## [0.2.0](https://github.com/great-elephant/elezone/compare/0.1.0...0.2.0) (2026-06-26)

### Features

* add start focus icon to todo tasks ([b3f2930](https://github.com/great-elephant/elezone/commit/b3f2930831b79beeada169662d8f6af6914250eb))
* allow 0 minute breaks and play battle chime if skipped ([76951f8](https://github.com/great-elephant/elezone/commit/76951f8bc1d4c16094b1b367415239a7d5660fc3))
* enhance Focus Zone and Reading Assistant UI ([286a297](https://github.com/great-elephant/elezone/commit/286a297aed36382ddc2bcb4f44acab6d136525c4))
* **focus:** separate general focus from task-specific focus ([99b2a45](https://github.com/great-elephant/elezone/commit/99b2a4523cd91ed6c0d81d329e8d413daf2c3dc0))
* support page repetition for read aloud ([c02cbc0](https://github.com/great-elephant/elezone/commit/c02cbc0e849d61d72b68824686a4058a0606caa8))
* track and display actual start/end time for pomodoro tasks on hover ([459b4f4](https://github.com/great-elephant/elezone/commit/459b4f453422cc47999c5fe01f85a95b26e066db))

### Bug Fixes

* prepend reverted tasks to the top of the todo list ([48c2045](https://github.com/great-elephant/elezone/commit/48c2045fba56b8896c3632ceb1b3e37e8069d906))
* redesign tough love system to be more forgiving and update immediately ([69161de](https://github.com/great-elephant/elezone/commit/69161de838f28976c944406b5ecea71e4ea1cff3))
* reset breathing state to prevent layout shift ([2b046b0](https://github.com/great-elephant/elezone/commit/2b046b028d18d75c2df464a6751ac83809f44674))
