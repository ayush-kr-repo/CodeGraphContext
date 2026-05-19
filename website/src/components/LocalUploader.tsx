import { useState } from "react";
import { FolderUp, FileArchive, Github, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseFilesIntoGraph } from "@/lib/parser";
import { parseFilesWithPyodide } from "@/lib/parser-pyodide";
import JSZip from "jszip";
import { motion } from "framer-motion";

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', 'out', 'coverage', 
  '.next', '.nuxt', '__pycache__', 'venv', '.venv', 'env', '.env', '.tox',
  'eggs', 'target', '.gradle', '.idea', 'cmake-build-debug', 'bin', 'obj',
  'packages', 'vendor', 'Pods', '.build', 'DerivedData', '.dart_tool',
  '.vscode'
]);

const sanitizePath = (pathStr: string, repoName?: string): string => {
  if (!pathStr) return '';
  
  // Normalize Windows slashes
  let p = pathStr.replace(/\\/g, '/');
  
  // If it's already relative, just return it
  if (p.startsWith('.') || (!p.startsWith('/') && !p.match(/^[a-zA-Z]:\//))) {
    return p.startsWith('./') ? p : './' + p;
  }
  
  // Detect if we can make it relative using the repoName
  if (repoName) {
    const parts = p.split('/');
    const repoIndex = parts.lastIndexOf(repoName);
    if (repoIndex !== -1) {
      return './' + parts.slice(repoIndex).join('/');
    }
  }
  
  // Generic cleanup for absolute paths
  const segments = p.split('/').filter(Boolean);
  if (segments.length > 3) {
    if (p.startsWith('/home/') || p.startsWith('/Users/') || p.includes('/runner/work/')) {
      return './' + segments.slice(-3).join('/');
    }
  }
  
  return p;
};

const isPathIgnored = (path: string) => {
  const parts = path.split(/[\/\\]/);
  return parts.some(part => IGNORED_DIRS.has(part));
};

export default function LocalUploader({ onComplete }: { onComplete: (data: unknown) => void }) {
  const [isParsing, setIsParsing] = useState(false);
  const [progress, setProgress] = useState({ text: "", value: 0 });
  const [activeTab, setActiveTab] = useState<'folder' | 'zip' | 'cgc' | 'github'>('folder');
  const [githubUrl, setGithubUrl] = useState("");
  const [indexVariables, setIndexVariables] = useState(false);
  const [indexerMode, setIndexerMode] = useState<'fast' | 'deep'>('fast');

  const processFiles = async (files: { path: string, content: string }[]) => {
    // Build fileContents map before the worker clears content for memory
    const fileContents: Record<string, string> = {};
    for (const f of files) {
      fileContents[f.path] = f.content;
    }

    setProgress({ text: `Parsing AST for ${files.length} files...`, value: 50 });
    await new Promise(r => setTimeout(r, 800));
    
    let graphData;
    if (indexerMode === 'deep') {
      setProgress({ text: "Initializing Python Engine...", value: 65 });
      graphData = await parseFilesWithPyodide(
        files, 
        (msg, val) => setProgress({ text: msg, value: val }),
        { indexVariables }
      );
    } else {
      setProgress({ text: "Initializing WebAssembly tree-sitter...", value: 80 });
      graphData = await parseFilesIntoGraph(
        files, 
        (msg, val) => setProgress({ text: msg, value: val }),
        { indexVariables }
      );
    }
    
    setProgress({ text: "Complete!", value: 100 });
    await new Promise(r => setTimeout(r, 400));
    
    onComplete({ ...graphData, fileContents });
  };

  const handleFolderSelect = async () => {
    try {
      if (!("showDirectoryPicker" in window)) {
        alert("Your browser does not support the File System Access API.");
        return;
      }
      const dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<any> }).showDirectoryPicker();
      setIsParsing(true);
      setProgress({ text: "Reading local directory...", value: 10 });
      
      const files: any[] = [];
      async function readDir(handle: any, prefix = "") {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file' && entry.name.match(/\.(js|ts|jsx|tsx|py|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|kts|dart)$/)) {
            const file = await entry.getFile();
            files.push({ path: `${prefix}/${entry.name}`, content: await file.text() });
          } else if (entry.kind === 'directory' && !IGNORED_DIRS.has(entry.name)) {
            await readDir(entry, `${prefix}/${entry.name}`);
          }
        }
      }
      
      await readDir(dirHandle);
      await processFiles(files);
    } catch (err) {
      console.error(err);
      setIsParsing(false);
    }
  };

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsParsing(true);
    try {
      setProgress({ text: "Unzipping locally...", value: 10 });
      const buffer = await file.arrayBuffer();
      const jszip = await JSZip.loadAsync(buffer);
      
      const files: any[] = [];
      const promises: Promise<void>[] = [];
      
      jszip.forEach((path, entry) => {
        if (!entry.dir && path.match(/\.(js|ts|jsx|tsx|py|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|kts|dart)$/) && !isPathIgnored(path)) {
          promises.push(entry.async("text").then(content => { files.push({ path, content }); }));
        }
      });
      
      setProgress({ text: `Extracting ${promises.length} files...`, value: 30 });
      await Promise.all(promises);
      
      await processFiles(files);
    } catch (err) {
      console.error(err);
      setIsParsing(false);
    }
  };

  const handleCgcUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsParsing(true);
    try {
      setProgress({ text: "Unzipping CGC bundle...", value: 10 });
      const buffer = await file.arrayBuffer();
      const jszip = await JSZip.loadAsync(buffer);
      
      const nodesFile = jszip.file("nodes.jsonl");
      const edgesFile = jszip.file("edges.jsonl");
      
      if (!nodesFile || !edgesFile) {
        alert("Invalid CGC bundle: nodes.jsonl and edges.jsonl are required.");
        setIsParsing(false);
        return;
      }
      
      setProgress({ text: "Parsing CGC bundle...", value: 30 });
      
      let metadata: any = {};
      if (jszip.file("metadata.json")) {
        const metaText = await jszip.file("metadata.json")!.async("text");
        try {
          metadata = JSON.parse(metaText);
        } catch (e) {
          console.warn("Could not parse metadata.json", e);
        }
      }
      
      const repoName = metadata.repo || "Unknown Repository";
      setProgress({ text: `Extracting nodes for ${repoName}...`, value: 50 });
      
      const nodesText = await nodesFile.async("text");
      const nodeLines = nodesText.split("\n").filter(line => line.trim() !== "");
      const nodes = nodeLines.map((line, idx) => {
        try {
          const nodeData = JSON.parse(line);
          const labels = nodeData._labels || [];
          const id = nodeData._id;
          
          // Extract properties
          const properties: Record<string, any> = {};
          for (const key of Object.keys(nodeData)) {
            if (key !== '_labels' && key !== '_id') {
              properties[key] = nodeData[key];
            }
          }
          
          // Clean absolute paths in node properties
          for (const key of Object.keys(properties)) {
            if (typeof properties[key] === 'string') {
              const val = properties[key];
              if (val.startsWith('/') || val.match(/^[a-zA-Z]:\\/) || val.includes('\\') || val.includes('/')) {
                if (key === 'path' || key === 'file' || key === 'repo_path' || key === 'import_path') {
                  properties[key] = sanitizePath(val, repoName);
                }
              }
            }
          }
          
          let displayName = String(properties.name || properties.label || properties.path || 'Unknown');
          if (displayName.startsWith('/') || displayName.includes('\\') || displayName.includes('/')) {
            displayName = sanitizePath(displayName, repoName);
          }
          
          const type = labels[0] ? (labels[0].charAt(0).toUpperCase() + labels[0].slice(1)) : 'Other';
          
          return {
            id: String(id),
            name: displayName,
            label: displayName,
            type: type,
            file: String(properties.path || properties.file || ''),
            val: (labels.length > 0 && ['Repository', 'Class', 'Interface', 'Trait'].includes(labels[0])) ? 4 : 2,
            properties: properties
          };
        } catch (err) {
          console.error("Failed to parse node line at index", idx, err);
          return null;
        }
      }).filter(Boolean);
      
      setProgress({ text: "Extracting edges...", value: 70 });
      
      const edgesText = await edgesFile.async("text");
      const edgeLines = edgesText.split("\n").filter(line => line.trim() !== "");
      const links = edgeLines.map((line, idx) => {
        try {
          const edgeData = JSON.parse(line);
          return {
            id: `${edgeData.from}_to_${edgeData.to}_${edgeData.type}_${idx}`,
            source: String(edgeData.from),
            target: String(edgeData.to),
            type: String(edgeData.type).toUpperCase()
          };
        } catch (err) {
          console.error("Failed to parse edge line at index", idx, err);
          return null;
        }
      }).filter(Boolean);
      
      setProgress({ text: "Building tree index...", value: 90 });
      
      const filePaths: string[] = [];
      for (const n of nodes as any[]) {
        if (n.file && n.type.toLowerCase() === 'file') {
          filePaths.push(n.file);
        }
      }
      const sortedFiles = Array.from(new Set(filePaths)).sort();
      
      setProgress({ text: "Complete!", value: 100 });
      await new Promise(r => setTimeout(r, 400));
      
      onComplete({
        nodes,
        links,
        files: sortedFiles,
        fileContents: {},
        metadata
      });
    } catch (err) {
      console.error(err);
      setIsParsing(false);
    }
  };

  const handleGithubFetch = async () => {
    if (!githubUrl || !githubUrl.includes("github.com")) {
      alert("Please enter a valid GitHub URL.");
      return;
    }
    
    setIsParsing(true);
    setProgress({ text: "Fetching repository tree...", value: 10 });
    try {
      const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) throw new Error("Invalid GitHub URL");
      const [_, owner, repo] = match;
      
      const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
      let res = await fetch(treeUrl);
      
      // Fallback for master branch
      if (!res.ok) {
         const masterUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`;
         res = await fetch(masterUrl);
      }
      
      if (!res.ok) {
        throw new Error("Could not fetch repo (make sure it's public).");
      }
      
      const data = await res.json();
      const filePaths = data.tree
        .filter((t: any) => t.type === "blob")
        .map((t: any) => t.path)
        .filter((p: string) => p.match(/\.(js|ts|jsx|tsx|py|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|kts|dart)$/) && !isPathIgnored(p));
        
      setProgress({ text: `Downloading ${filePaths.length} files...`, value: 30 });
      
      const files: any[] = [];
      // Batch loading to prevent excessive concurrency
      for (let i = 0; i < filePaths.length; i += 10) {
        setProgress({ text: `Downloading ${i}/${filePaths.length}...`, value: 30 + Math.floor((i/filePaths.length) * 20) });
        const batch = filePaths.slice(i, i + 10);
        await Promise.all(batch.map(async (p: string) => {
           try {
             // Fetch via raw.githubusercontent which supports CORS
             let r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${p}`);
             if (!r.ok) r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/master/${p}`);
             if (r.ok) files.push({ path: p, content: await r.text() });
           } catch (e) { console.warn("Fetch failed", e); }
         }));
      }
      
      await processFiles(files);
    } catch (err) {
      console.error(err);
      setIsParsing(false);
      alert("Error: " + (err as Error).message);
    }
  };

  return (
    <div className="flex flex-col p-6 w-full h-full min-h-[400px] border border-white/10 dark:border-white/20 rounded-[2rem] bg-black/40 backdrop-blur-xl shadow-2xl relative overflow-hidden">
      
      {/* Tab Selectors */}
      <div className="flex bg-white/5 p-1.5 rounded-2xl mb-6 relative z-10 w-full shadow-inner border border-white/5">
        <button onClick={() => setActiveTab('folder')} className={`flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all duration-300 ${activeTab === 'folder' ? 'bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}>Folder</button>
        <button onClick={() => setActiveTab('zip')} className={`flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all duration-300 ${activeTab === 'zip' ? 'bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}>ZIP</button>
        <button onClick={() => setActiveTab('cgc')} className={`flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all duration-300 ${activeTab === 'cgc' ? 'bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}>CGC Bundle</button>
        <button onClick={() => setActiveTab('github')} className={`flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all duration-300 ${activeTab === 'github' ? 'bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}>GitHub</button>
      </div>

      {/* Indexer Mode Toggle Selector */}
      {activeTab !== 'cgc' && (
        <div className="flex flex-col bg-white/5 border border-white/10 rounded-2xl p-4 mb-6 relative z-10 w-full text-left gap-3 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-purple-400">
              Select Indexer Engine
            </span>
            <span className="text-[10px] px-2.5 py-0.5 rounded-full font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-widest font-bold">
              {indexerMode === 'fast' ? 'Instant' : 'Deep Semantic'}
            </span>
          </div>
          
          <div className="grid grid-cols-2 gap-2">
            <button 
              onClick={() => setIndexerMode('fast')} 
              className={`p-3 rounded-xl border text-left transition-all duration-300 flex flex-col gap-1 ${indexerMode === 'fast' ? 'bg-white/10 border-purple-500/50 text-white shadow-lg' : 'bg-transparent border-white/5 text-gray-400 hover:text-white hover:bg-white/5'}`}
            >
              <span className="text-xs font-bold">⚡ Fast Indexer (JS)</span>
              <span className="text-[10px] opacity-75">Instant startup, great for quick structure scan.</span>
            </button>
            
            <button 
              onClick={() => setIndexerMode('deep')} 
              className={`p-3 rounded-xl border text-left transition-all duration-300 flex flex-col gap-1 ${indexerMode === 'deep' ? 'bg-gradient-to-br from-purple-950/40 to-indigo-950/40 border-purple-500 text-white shadow-[0_0_15px_rgba(168,85,247,0.15)]' : 'bg-transparent border-white/5 text-gray-400 hover:text-white hover:bg-white/5'}`}
            >
              <span className="text-xs font-bold">🔮 Deep Indexer (Py)</span>
              <span className="text-[10px] opacity-75">Resolves complex cross-file scopes, imports, and inherits.</span>
            </button>
          </div>
        </div>
      )}

      {!isParsing ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center w-full relative z-10">
          
          {activeTab === 'folder' && (
            <motion.div key="folder" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center w-full">
              <div className="bg-gradient-to-br from-purple-500/20 to-indigo-500/20 p-5 rounded-full mb-6 border border-purple-500/30">
                <FolderUp className="w-10 h-10 text-purple-400" />
              </div>
              <h3 className="text-2xl font-bold mb-2 text-white">Select Directory</h3>
              <p className="text-gray-400 text-sm mb-8 max-w-[250px]">Select a local folder. Visualized locally in the browser.</p>
              <Button onClick={handleFolderSelect} className="bg-white text-black hover:bg-gray-200 rounded-full px-10 py-6 text-lg w-full max-w-[280px] shadow-[0_0_20px_rgba(255,255,255,0.1)]">
                Browse Files
              </Button>
            </motion.div>
          )}

          {activeTab === 'zip' && (
            <motion.div key="zip" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center w-full">
              <div className="bg-gradient-to-br from-blue-500/20 to-cyan-500/20 p-5 rounded-full mb-6 border border-blue-500/30">
                <FileArchive className="w-10 h-10 text-blue-400" />
              </div>
              <h3 className="text-2xl font-bold mb-2 text-white">Upload ZIP</h3>
              <p className="text-gray-400 text-sm mb-8 max-w-[250px]">Drop a compressed repository. Unzipped and parsed securely in memory.</p>
              <div className="relative w-full max-w-[280px]">
                <Button className="bg-white text-black relative cursor-pointer hover:bg-gray-200 rounded-full px-10 py-6 text-lg w-full shadow-[0_0_20px_rgba(255,255,255,0.1)]">
                  Select ZIP Archive
                  <input type="file" accept=".zip" onChange={handleZipUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                </Button>
              </div>
            </motion.div>
          )}

          {activeTab === 'cgc' && (
            <motion.div key="cgc" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center w-full">
              <div className="bg-gradient-to-br from-emerald-500/20 to-teal-500/20 p-5 rounded-full mb-6 border border-emerald-500/30">
                <FileArchive className="w-10 h-10 text-emerald-400" />
              </div>
              <h3 className="text-2xl font-bold mb-2 text-white">Upload CGC Bundle</h3>
              <p className="text-gray-400 text-sm mb-8 max-w-[250px]">Drop a .cgc pre-indexed bundle file. Loaded instantly in-memory.</p>
              <div className="relative w-full max-w-[280px]">
                <Button className="bg-white text-black relative cursor-pointer hover:bg-gray-200 rounded-full px-10 py-6 text-lg w-full shadow-[0_0_20px_rgba(255,255,255,0.1)]">
                  Select CGC Bundle
                  <input type="file" accept=".cgc" onChange={handleCgcUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                </Button>
              </div>
            </motion.div>
          )}

          {activeTab === 'github' && (
            <motion.div key="github" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center w-full">
              <div className="bg-gradient-to-br from-gray-600/30 to-gray-500/10 p-5 rounded-full mb-6 border border-gray-500/30">
                <Github className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-2xl font-bold mb-2 text-white">Fetch Repository</h3>
              <p className="text-gray-400 text-sm mb-8 max-w-[250px]">Pull raw files from a public GitHub repository.</p>
              <input 
                type="text" 
                placeholder="https://github.com/facebook/react" 
                value={githubUrl}
                onChange={e => setGithubUrl(e.target.value)}
                className="w-full bg-black/40 border border-white/20 text-white placeholder-gray-500 px-5 py-4 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
              <Button onClick={handleGithubFetch} className="bg-white hover:bg-gray-200 text-black w-full rounded-xl py-6 text-lg font-semibold shadow-[0_0_20px_rgba(255,255,255,0.1)]">
                Scan & Visualize
              </Button>
            </motion.div>
          )}
          
          {/* Index Options */}
          <div className="mt-8 flex items-center gap-2 cursor-pointer group" onClick={() => setIndexVariables(!indexVariables)}>
            <div className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${indexVariables ? 'bg-purple-500 border-purple-500' : 'border-white/20 bg-white/5'}`}>
              {indexVariables && <div className="w-1.5 h-1.5 bg-white rounded-full shadow-[0_0_5px_#fff]" />}
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400 group-hover:text-gray-300 transition-colors">
              Index High-Fidelity Variables (Higher Compute)
            </span>
          </div>
          
        </div>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center flex-1 w-full px-4 relative z-10">
          <Loader2 className="w-14 h-14 text-white animate-spin mb-6 drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]" />
          <h3 className="text-lg font-medium text-white mb-4 text-center">{progress.text}</h3>
          
          <div className="w-full bg-gray-800 rounded-full h-2 mt-2 overflow-hidden shadow-inner border border-white/5">
            <div 
              className="bg-gradient-to-r from-purple-400 to-indigo-400 h-2 rounded-full transition-all duration-300 ease-out relative" 
              style={{ width: `${progress.value}%`, boxShadow: '0 0 15px rgba(168, 85, 247, 0.8)' }}
            >
               <div className="absolute inset-0 bg-white/30 truncate" style={{animation: "shimmer 2s infinite linear"}}></div>
            </div>
          </div>
          <p className="text-xs text-gray-400 font-mono mt-3">{progress.value}%</p>
        </motion.div>
      )}
      
      {/* Decorative Blob */}
      <div className="absolute -bottom-32 -right-32 w-80 h-80 bg-purple-600/15 blur-3xl rounded-full z-0 pointer-events-none"></div>
    </div>
  );
}
