import { createWorker, Worker } from 'tesseract.js';

let worker: Worker | null = null;
let currentLang = '';
// The worker's `logger` closure below is wired up once, at creation time, but
// gets reused across every later recognizeText() call for the same language
// (see the cache check just below). Without this indirection, all of that
// worker's real progress events would keep firing into the FIRST caller's
// onProgress forever — including its stale requestId — so a later caller's
// own progress updates would silently look "stale" and get dropped upstream.
let activeOnProgress: ((status: string, progress: number) => void) | undefined;

export async function initOcr(
  lang: string,
  onProgress?: (status: string, progress: number) => void
): Promise<Worker> {
  activeOnProgress = onProgress;
  if (worker && currentLang === lang) return worker;

  if (worker) {
    onProgress?.('Restarting worker...', 0);
    await worker.terminate();
    worker = null;
  }

  onProgress?.('Loading Tesseract engine...', 0);

  const localLangs = ['eng', 'chi_sim', 'chi_tra'];
  const isLocal = localLangs.includes(lang);

  const langPath = isLocal 
    ? chrome.runtime.getURL('tesseract') 
    : 'https://tessdata.projectnaptha.com/4.0.0';

  const newWorker = await createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
    corePath: chrome.runtime.getURL('tesseract/tesseract-core-simd-lstm.wasm.js'),
    langPath,
    gzip: !isLocal,       // Local files are uncompressed, remote are gzipped
    workerBlobURL: false,
    logger: m => {
      activeOnProgress?.(m.status, m.progress ?? 0);
    }
  });

  onProgress?.('OCR ready!', 1);
  worker = newWorker;
  currentLang = lang;
  return worker;
}

export async function recognizeText(
  imageBase64: string,
  lang: string = 'chi_sim',
  onProgress?: (status: string, progress: number) => void
): Promise<string> {
  const w = await initOcr(lang, onProgress);
  onProgress?.('Recognizing text...', 0);
  const { data: { text } } = await w.recognize(imageBase64);
  return text.trim();
}
