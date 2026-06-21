import { createWorker, Worker } from 'tesseract.js';

let worker: Worker | null = null;
let currentLang = 'eng';

export async function initOcr(lang: string, onProgress?: (status: string, progress: number) => void) {
  if (worker && currentLang === lang) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }

  worker = await createWorker(lang, 1, {
    logger: m => {
      if (onProgress) {
        onProgress(m.status, m.progress);
      }
    }
  });
  currentLang = lang;

  return worker;
}

export async function recognizeText(imageBase64: string, lang: string = 'eng', onProgress?: (status: string, progress: number) => void): Promise<string> {
  const w = await initOcr(lang, onProgress);
  const { data: { text } } = await w.recognize(imageBase64);
  return text.trim();
}
