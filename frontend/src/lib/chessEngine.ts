import stockfishWorkerUrl from 'stockfish/bin/stockfish-18-lite-single.js?url';
import stockfishWasmUrl from 'stockfish/bin/stockfish-18-lite-single.wasm?url';

type StockfishController = {
  worker: Worker;
  ready: Promise<void>;
  getBestMove: (fen: string, depth: number) => Promise<string | null>;
  terminate: () => void;
};

function createStockfish(): StockfishController {
  const worker = new Worker(`${stockfishWorkerUrl}#${encodeURIComponent(stockfishWasmUrl)},worker`);
  let queue: Promise<unknown> = Promise.resolve();

  const ready = new Promise<void>((resolve) => {
    const onReady = (event: MessageEvent<string>) => {
      if (event.data === 'readyok') {
        worker.removeEventListener('message', onReady);
        resolve();
      }
    };

    worker.addEventListener('message', onReady);
    worker.postMessage('uci');
    worker.postMessage('isready');
  });

  function getBestMove(fen: string, depth: number) {
    queue = queue.catch(() => undefined).then(async () => {
      await ready;

      return new Promise<string | null>((resolve) => {
        const timeout = window.setTimeout(() => {
          worker.removeEventListener('message', onMessage);
          resolve(null);
        }, 2500);

        const onMessage = (event: MessageEvent<string>) => {
          if (!event.data.startsWith('bestmove ')) return;
          window.clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);

          const bestMove = event.data.split(/\s+/)[1];
          resolve(bestMove && bestMove !== '(none)' ? bestMove : null);
        };

        worker.addEventListener('message', onMessage);
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${Math.max(1, Math.min(12, depth))}`);
      });
    });

    return queue as Promise<string | null>;
  }

  return {
    worker,
    ready,
    getBestMove,
    terminate: () => worker.terminate()
  };
}

export const stockfish = createStockfish();

export function getBestMove(fen: string, depth = 4) {
  return stockfish.getBestMove(fen, depth);
}
