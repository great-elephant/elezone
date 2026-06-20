// Ambient declarations for Chrome's built-in AI APIs (Chrome 138+).
// These ship as GLOBAL classes (window/self/globalThis) — NOT under the
// removed `window.ai.*` namespace. Always access via `globalThis.X` so a
// missing global yields `undefined` instead of a ReferenceError.
//
// This file has no imports/exports on purpose: it is a global ambient script,
// so every type below is visible project-wide.

type AIAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

interface AICreateMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded: number }) => void,
  ): void
}

interface LanguageModelMessage {
  role: 'user' | 'assistant'
  content: string
}

interface LanguageModelSession {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>
  destroy(): void
}

interface LanguageModelCreateOptions {
  systemPrompt?: string          // system instruction — separate from initialPrompts
  initialPrompts?: LanguageModelMessage[]  // user/assistant turns only
  temperature?: number
  topK?: number
  expectedOutputs?: Array<{ type: string; languages: string[] }>
  monitor?: (monitor: AICreateMonitor) => void
  signal?: AbortSignal
}

interface LanguageModelFactory {
  availability(options?: { expectedOutputs?: Array<{ type: string; languages: string[] }> }): Promise<AIAvailability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>
}

interface TranslatorInstance {
  translate(text: string): Promise<string>
  destroy(): void
}

interface TranslatorCreateOptions {
  sourceLanguage: string
  targetLanguage: string
  monitor?: (monitor: AICreateMonitor) => void
  signal?: AbortSignal
}

interface TranslatorFactory {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<AIAvailability>
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>
}

declare var LanguageModel: LanguageModelFactory | undefined
declare var Translator: TranslatorFactory | undefined
