import stockfishAsmWorkerUrl from 'stockfish/bin/stockfish-18-asm.js?url';
import stockfishWorkerUrl from 'stockfish/bin/stockfish-18-lite-single.js?url';
import stockfishWasmUrl from 'stockfish/bin/stockfish-18-lite-single.wasm?url';

type StockfishMode = 'wasm' | 'asm';

type EngineHandle = {
  worker: Worker;
  mode: StockfishMode;
  ready: Promise<void>;
};

type StockfishController = {
  getBestMove: (fen: string, depth: number) => Promise<string | null>;
  terminate: () => void;
};

const readyTimeoutMs = 4000;
const searchTimeoutMs = 3500;

let engine: EngineHandle | null = null;
let queue: Promise<unknown> = Promise.resolve();

function makeWorker(mode: StockfishMode) {
  if (mode === 'asm') return new Worker(stockfishAsmWorkerUrl);
  return new Worker(`${stockfishWorkerUrl}#${encodeURIComponent(stockfishWasmUrl)},worker`);
}

function createEngine(mode: StockfishMode): EngineHandle {
  const worker = makeWorker(mode);

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`stockfish_${mode}_ready_timeout`));
    }, readyTimeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };

    const onMessage = (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string' || event.data !== 'readyok') return;
      cleanup();
      resolve();
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error || new Error(event.message));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage('uci');
    worker.postMessage('isready');
  });

  return { worker, mode, ready };
}

async function getEngine() {
  if (engine) return engine;

  try {
    engine = createEngine('wasm');
    await engine.ready;
    return engine;
  } catch {
    engine?.worker.terminate();
    engine = createEngine('asm');
    await engine.ready;
    return engine;
  }
}

async function runBestMove(fen: string, depth: number) {
  const currentEngine = await getEngine();

  return new Promise<string | null>((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, searchTimeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      currentEngine.worker.removeEventListener('message', onMessage);
    };

    const onMessage = (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string' || !event.data.startsWith('bestmove ')) return;
      cleanup();

      const bestMove = event.data.split(/\s+/)[1];
      resolve(bestMove && bestMove !== '(none)' ? bestMove : null);
    };

    currentEngine.worker.addEventListener('message', onMessage);
    currentEngine.worker.postMessage(`position fen ${fen}`);
    currentEngine.worker.postMessage(`go depth ${Math.max(1, Math.min(12, depth))}`);
  });
}

export const stockfish: StockfishController = {
  getBestMove(fen: string, depth: number) {
    queue = queue.catch(() => undefined).then(() => runBestMove(fen, depth));
    return queue as Promise<string | null>;
  },
  terminate() {
    engine?.worker.terminate();
    engine = null;
    queue = Promise.resolve();
  }
};

export function getBestMove(fen: string, depth = 4) {
  return stockfish.getBestMove(fen, depth);
}

export type AnalysisLine = { multipv: number; scoreCp?: number; mate?: number; pvUci: string[] };

async function runAnalyzeLines(fen: string, depth: number, multiPv: number): Promise<AnalysisLine[]> {
  const currentEngine = await getEngine();
  const lines = new Map<number, AnalysisLine>();

  return new Promise<AnalysisLine[]>((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve([...lines.values()].sort((a, b) => a.multipv - b.multipv));
    }, searchTimeoutMs * 2);

    const cleanup = () => {
      window.clearTimeout(timeout);
      currentEngine.worker.removeEventListener('message', onMessage);
    };

    const onMessage = (event: MessageEvent<string>) => {
      const data = event.data;
      if (typeof data !== 'string') return;
      if (data.startsWith('info') && data.includes(' pv ')) {
        const mpvMatch = data.match(/multipv (\d+)/);
        const cpMatch = data.match(/score cp (-?\d+)/);
        const mateMatch = data.match(/score mate (-?\d+)/);
        const pvMatch = data.match(/ pv (.+)$/);
        if (!mpvMatch || !pvMatch) return;
        const multipv = Number(mpvMatch[1]);
        lines.set(multipv, {
          multipv,
          scoreCp: cpMatch ? Number(cpMatch[1]) : undefined,
          mate: mateMatch ? Number(mateMatch[1]) : undefined,
          pvUci: pvMatch[1].trim().split(/\s+/).slice(0, 6)
        });
        return;
      }
      if (data.startsWith('bestmove')) {
        cleanup();
        resolve([...lines.values()].sort((a, b) => a.multipv - b.multipv));
      }
    };

    currentEngine.worker.addEventListener('message', onMessage);
    currentEngine.worker.postMessage(`setoption name MultiPV value ${multiPv}`);
    currentEngine.worker.postMessage(`position fen ${fen}`);
    currentEngine.worker.postMessage(`go depth ${Math.max(1, Math.min(16, depth))}`);
  });
}

export function analyzeLines(fen: string, depth = 14, multiPv = 3) {
  queue = queue.catch(() => undefined).then(() => runAnalyzeLines(fen, depth, multiPv));
  return queue as Promise<AnalysisLine[]>;
}
