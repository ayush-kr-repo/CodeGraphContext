import JSZip from "jszip";

/**
 * Parses files using the Pyodide WebAssembly Python engine in a isolated Web Worker.
 * Matches your desktop CLI indexer exactly, with deep semantic context.
 */
export function parseFilesWithPyodide(
  files: { path: string, content: string }[], 
  onProgressTracker?: (progressMsg: string, percentage: number) => void,
  options: { indexVariables?: boolean } = { indexVariables: true }
): Promise<{ nodes: any[], links: any[], files: string[] }> {
  return new Promise((resolve, reject) => {
    // Create Pyodide Worker
    const worker = new Worker(new URL('./parser-pyodide.worker.ts', import.meta.url), { type: 'module' });
    
    worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'PROGRESS') {
        if (onProgressTracker) onProgressTracker(payload.msg, payload.percent);
      } else if (type === 'DONE') {
        resolve(payload);
        worker.terminate();
      } else if (type === 'ERROR') {
        reject(new Error(payload));
        worker.terminate();
      }
    };
    
    worker.onerror = (e) => {
      reject(e);
      worker.terminate();
    };

    // Send chunks of files to avoid postMessage sizing limits
    const CHUNK_SIZE = 50;
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      const chunk = files.slice(i, i + CHUNK_SIZE);
      worker.postMessage({ type: 'ADD_FILES', files: chunk });
    }
    
    worker.postMessage({ type: 'START', options });
  });
}
