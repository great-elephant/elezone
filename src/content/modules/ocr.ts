import { createWorker, Worker } from 'tesseract.js';

let worker: Worker | null = null;

export async function initOcr(onProgress?: (status: string, progress: number) => void) {
  if (worker) return worker;

  worker = await createWorker('eng', 1, {
    logger: m => {
      if (onProgress) {
        onProgress(m.status, m.progress);
      }
    }
  });

  return worker;
}

export async function recognizeText(imageBase64: string, onProgress?: (status: string, progress: number) => void): Promise<string> {
  const w = await initOcr(onProgress);
  const { data: { text } } = await w.recognize(imageBase64);
  return text.trim();
}
