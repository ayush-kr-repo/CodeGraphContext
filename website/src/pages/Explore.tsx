import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import CodeGraphViewer from "../components/CodeGraphViewer";
import LocalUploader from "../components/LocalUploader";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import JSZip from "jszip";

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

const Explore = () => {
  const [searchParams] = useSearchParams();
  const [graphData, setGraphData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connection parameters for "Playground" mode (CLI/Database)
  const backend = searchParams.get("backend") || "";
  const repoPath = searchParams.get("repo_path") || "";
  const cypherQuery = searchParams.get("cypher_query") || "";
  const bundleUrl = searchParams.get("bundle_url") || "";
  
  // Helper to bypass CORS for GitHub files and release assets
  const getCorsFriendlyUrl = (url: string): string => {
    if (!url) return "";
    if (url.includes("raw.githubusercontent.com")) {
      const match = url.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
      if (match) {
        const [_, owner, repo, branch, filepath] = match;
        return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filepath}`;
      }
    }
    if (url.includes("github.com") && (url.includes("/releases/download/") || url.includes("/raw/"))) {
      return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    }
    return url;
  };
  
  // If bundleUrl is present, we download and parse it client-side
  useEffect(() => {
    if (!bundleUrl) return;

    const fetchBundle = async () => {
      setLoading(true);
      setError(null);
      try {
        const targetUrl = getCorsFriendlyUrl(bundleUrl);
        const response = await fetch(targetUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch bundle from URL (${response.status})`);
        }
        
        const buffer = await response.arrayBuffer();
        const jszip = await JSZip.loadAsync(buffer);
        
        const nodesFile = jszip.file("nodes.jsonl");
        const edgesFile = jszip.file("edges.jsonl");
        
        if (!nodesFile || !edgesFile) {
          throw new Error("Invalid CGC bundle: nodes.jsonl and edges.jsonl are required.");
        }
        
        let metadata: any = {};
        if (jszip.file("metadata.json")) {
          const metaText = await jszip.file("metadata.json")!.async("text");
          try {
            metadata = JSON.parse(metaText);
          } catch (e) {
            console.warn("Could not parse metadata.json", e);
          }
        }
        
        const repoName = metadata.repo || "";
        
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
        
        const filePaths: string[] = [];
        for (const n of nodes as any[]) {
          if (n.file && n.type.toLowerCase() === 'file') {
            filePaths.push(n.file);
          }
        }
        const sortedFiles = Array.from(new Set(filePaths)).sort();
        
        setGraphData({
          nodes,
          links,
          files: sortedFiles,
          fileContents: {},
          metadata
        });
      } catch (err: any) {
        console.error("Fetch Bundle Error:", err);
        setError(err.message);
        toast.error("Failed to load bundle: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchBundle();
  }, [bundleUrl]);

  // If backend param is present, we automatically fetch from the local python server
  useEffect(() => {
    if (!backend && !cypherQuery) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/graph", backend || window.location.origin);
        if (repoPath) url.searchParams.append("repo_path", repoPath);
        if (cypherQuery) url.searchParams.append("cypher_query", cypherQuery);

        const response = await fetch(url.toString());
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.detail || `Server error (${response.status})`);
        }

        const data = await response.json();
        setGraphData(data);
      } catch (err: any) {
        console.error("Fetch Error:", err);
        setError(err.message);
        toast.error("Failed to connect to local index: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [backend, repoPath, cypherQuery]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-center px-6">
        <Loader2 className="w-12 h-12 animate-spin text-primary mb-4" />
        <p className="text-lg font-medium animate-pulse text-muted-foreground">
          {bundleUrl ? "Downloading and parsing pre-indexed CGC bundle..." : "Connecting to local database..."}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background px-6 text-center">
        <h1 className="text-2xl font-bold mb-2 text-red-500">Connection Error</h1>
        <p className="text-muted-foreground max-w-md mb-8">{error}</p>
        <button onClick={() => window.location.reload()} className="bg-primary text-primary-foreground px-6 py-2 rounded-lg">Retry</button>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background pt-24 pb-12 px-6 flex flex-col items-center">
      <AnimatePresence mode="wait">
        {!graphData ? (
          <motion.div 
            key="uploader"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-4xl mx-auto flex flex-col items-center mt-12"
          >
            <div className="text-center mb-12">
              <h1 className="text-4xl md:text-5xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
                Graph Explorer
              </h1>
              <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                Instantly visualize your code architecture. Scan local files via WebAssembly or connect to your local CLI index.
              </p>
            </div>
            
            <div className="w-full max-w-2xl">
              <LocalUploader onComplete={setGraphData} />
            </div>
          </motion.div>
        ) : (
          <CodeGraphViewer 
            key="viewer" 
            data={graphData} 
            onClose={() => setGraphData(null)}
          />
        )}
      </AnimatePresence>
    </main>
  );
};

export default Explore;
