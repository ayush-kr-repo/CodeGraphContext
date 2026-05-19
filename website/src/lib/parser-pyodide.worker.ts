import { Parser, Language, Query } from "web-tree-sitter";
import treeSitterWasmUrl from "web-tree-sitter/tree-sitter.wasm?url";

// Pyodide WebAssembly instance state

let parser: any = null;
let initPromise: Promise<void> | null = null;
let pyodideInstance: any = null;
const wasmLanguageCache = new Map<string, any>();

async function initParser() {
  if (parser) return;
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init({
        locateFile(scriptName: string) {
          if (scriptName.endsWith('tree-sitter.wasm')) {
            return treeSitterWasmUrl;
          }
          return `${location.origin}/wasm/${scriptName}`;
        }
      });
      parser = new Parser();
    })();
  }
  await initPromise;
}

async function getLanguageForFile(path: string) {
  if (!parser) await initParser();
  const extMatch = path.match(/\.([a-zA-Z0-9]+)$/);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();

  let wasmName = '';
  switch (ext) {
    case 'py': wasmName = 'tree-sitter-python.wasm'; break;
    case 'js':
    case 'jsx': wasmName = 'tree-sitter-javascript.wasm'; break;
    case 'ts':
    case 'tsx': wasmName = 'tree-sitter-tsx.wasm'; break;
    case 'java': wasmName = 'tree-sitter-java.wasm'; break;
    case 'c':
    case 'h': wasmName = 'tree-sitter-c.wasm'; break;
    case 'cpp':
    case 'hpp':
    case 'cc': wasmName = 'tree-sitter-cpp.wasm'; break;
    case 'cs': wasmName = 'tree-sitter-c_sharp.wasm'; break;
    case 'go': wasmName = 'tree-sitter-go.wasm'; break;
    case 'rs': wasmName = 'tree-sitter-rust.wasm'; break;
    case 'rb': wasmName = 'tree-sitter-ruby.wasm'; break;
    case 'php': wasmName = 'tree-sitter-php.wasm'; break;
    case 'swift': wasmName = 'tree-sitter-swift.wasm'; break;
    case 'kt':
    case 'kts': wasmName = 'tree-sitter-kotlin.wasm'; break;
    case 'dart': wasmName = 'tree-sitter-dart.wasm'; break;
    case 'pl':
    case 'pm': wasmName = 'tree-sitter-perl.wasm'; break;
    default: return null;
  }

  if (wasmLanguageCache.has(wasmName)) {
    return wasmLanguageCache.get(wasmName);
  }

  try {
    const response = await fetch(`${location.origin}/wasm/${wasmName}`);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const lang = await Language.load(new Uint8Array(buffer));
    wasmLanguageCache.set(wasmName, lang);
    return lang;
  } catch (err) {
    return null;
  }
}

// Custom language parser query strings
const QUERIES: Record<string, { definitions: string; imports: string; calls: string; inherits: string; variables: string }> = {
  python: {
    definitions: `
      (class_definition     name: (identifier) @def.name) @def.node
      (function_definition  name: (identifier) @def.name) @def.node
    `,
    imports: `
      (import_statement      (dotted_name (identifier) @import.module) )
      (import_from_statement module_name: (dotted_name (identifier) @import.module))
    `,
    calls: `
      (call function: (identifier)          @call.name)
      (call function: (attribute attribute: (identifier) @call.name))
    `,
    inherits: `
      (class_definition
        superclasses: (argument_list
          [ (identifier) @inherit.base
            (attribute attribute: (identifier) @inherit.base) ]))
    `,
    variables: `
      (assignment
        left: [(identifier) @var.name (attribute attribute: (identifier) @var.name)]) @var.node
    `,
  },
  typescript: {
    definitions: `
      (function_declaration   name: (identifier) @def.name) @def.node
      (class_declaration      name: (type_identifier) @def.name) @def.node
      (method_definition      name: (property_identifier) @def.name) @def.node
      (interface_declaration  name: (type_identifier) @def.name) @def.node
    `,
    imports: `
      (import_statement source: (string (string_fragment) @import.module))
    `,
    calls: `
      (call_expression function: (identifier)                 @call.name)
      (call_expression function: (member_expression
                         property: (property_identifier)       @call.name))
    `,
    inherits: ``,
    variables: `
      (lexical_declaration (variable_declarator name: (identifier) @var.name))
    `,
  },
  javascript: {
    definitions: `
      (function_declaration   name: (identifier) @def.name) @def.node
      (class_declaration      name: (identifier) @def.name) @def.node
      (method_definition      name: (property_identifier) @def.name) @def.node
    `,
    imports: `
      (import_statement source: (string (string_fragment) @import.module))
    `,
    calls: `
      (call_expression function: (identifier)           @call.name)
      (call_expression function: (member_expression
                         property: (property_identifier) @call.name))
    `,
    inherits: ``,
    variables: `
      (lexical_declaration (variable_declarator name: (identifier) @var.name))
    `,
  },
  java: {
    definitions: `
      (class_declaration      name: (identifier) @def.name) @def.node
      (interface_declaration  name: (identifier) @def.name) @def.node
      (enum_declaration       name: (identifier) @def.name) @def.node
      (method_declaration     name: (identifier) @def.name) @def.node
    `,
    imports: `
      (import_declaration (scoped_identifier (identifier) @import.module))
    `,
    calls: `
      (method_invocation name: (identifier) @call.name)
      (object_creation_expression type: (type_identifier) @call.name)
    `,
    inherits: `
      (class_declaration
        (superclass (type_identifier) @inherit.base))
      (class_declaration
        (super_interfaces (type_list (type_identifier) @inherit.base)))
      (interface_declaration
        (extends_interfaces (type_list (type_identifier) @inherit.base)))
    `,
    variables: `
      (field_declaration declarator: (variable_declarator name: (identifier) @var.name))
    `,
  },
  c: {
    definitions: `
      (function_definition declarator:
        (function_declarator declarator: (identifier) @def.name)) @def.node
      (struct_specifier name: (type_identifier) @def.name) @def.node
      (enum_specifier   name: (type_identifier) @def.name) @def.node
    `,
    imports: `
      (preproc_include path: [(string_literal) (system_lib_string)] @import.module)
    `,
    calls: `
      (call_expression function: (identifier) @call.name)
    `,
    inherits: ``,
    variables: `
      (declaration declarator: (identifier) @var.name)
    `,
  },
  cpp: {
    definitions: `
      (function_definition declarator:
        (function_declarator declarator:
          [(identifier)(qualified_identifier)] @def.name)) @def.node
      (class_specifier  name: (type_identifier) @def.name) @def.node
      (struct_specifier name: (type_identifier) @def.name) @def.node
      (enum_specifier   name: (type_identifier) @def.name) @def.node
    `,
    imports: `
      (preproc_include path: [(string_literal)(system_lib_string)] @import.module)
    `,
    calls: `
      (call_expression function:
        [(identifier) @call.name
         (field_expression field: (field_identifier) @call.name)
         (qualified_identifier name: (identifier) @call.name)
        ])
    `,
    inherits: `
      (class_specifier
        (base_class_clause
          (type_identifier) @inherit.base))
    `,
    variables: `
      (declaration declarator: [(identifier) @var.name (field_identifier) @var.name])
    `,
  },
  go: {
    definitions: `
      (function_declaration  name: (identifier) @def.name) @def.node
      (method_declaration    name: (field_identifier) @def.name) @def.node
      (type_declaration (type_spec name: (type_identifier) @def.name)) @def.node
    `,
    imports: `
      (import_spec path: (interpreted_string_literal) @import.module)
    `,
    calls: `
      (call_expression function: (identifier)        @call.name)
      (call_expression function: (selector_expression
                         field: (field_identifier)   @call.name))
    `,
    inherits: ``,
    variables: `
      (var_spec name: (identifier) @var.name)
      (short_var_declaration left: (expression_list (identifier) @var.name))
    `,
  },
  rust: {
    definitions: `
      (function_item  name: (identifier) @def.name) @def.node
      (struct_item    name: (type_identifier) @def.name) @def.node
      (enum_item      name: (type_identifier) @def.name) @def.node
      (trait_item     name: (type_identifier) @def.name) @def.node
      (impl_item      type: (type_identifier) @def.name) @def.node
    `,
    imports: `
      (use_declaration argument: (scoped_identifier name: (identifier) @import.module))
      (use_declaration argument: (identifier) @import.module)
    `,
    calls: `
      (call_expression function:
        [(identifier) @call.name
         (field_expression field: (field_identifier) @call.name)
         (scoped_identifier name: (identifier) @call.name)
        ])
    `,
    inherits: ``,
    variables: `
      (let_declaration pattern: (identifier) @var.name)
      (const_declaration name: (identifier) @var.name)
    `,
  },
  ruby: {
    definitions: `
      (class  name: (constant) @def.name) @def.node
      (module name: (constant) @def.name) @def.node
      (method name: (identifier) @def.name) @def.node
      (singleton_method name: (identifier) @def.name) @def.node
    `,
    imports: `
      (call method: (identifier) @_req
            arguments: (argument_list (string (string_content) @import.module)))
    `,
    calls: `
      (call method: (identifier) @call.name)
    `,
    inherits: `
      (class (superclass (constant) @inherit.base))
    `,
    variables: `
      (assignment left: (identifier) @var.name)
    `,
  },
  php: {
    definitions: `
      (class_declaration     name: (name) @def.name) @def.node
      (interface_declaration name: (name) @def.name) @def.node
      (function_definition   name: (name) @def.name) @def.node
      (method_declaration    name: (name) @def.name) @def.node
    `,
    imports: `
      (include_expression (string) @import.module)
      (require_expression (string) @import.module)
      (include_once_expression (string) @import.module)
      (require_once_expression (string) @import.module)
    `,
    calls: `
      (function_call_expression function: (name) @call.name)
      (member_call_expression   name: (name) @call.name)
    `,
    inherits: `
      (class_declaration (base_clause (name) @inherit.base))
    `,
    variables: `
      (variable_declaration (variable_name (name) @var.name))
    `,
  },
  kotlin: {
    definitions: `
      (class_declaration    (type_identifier) @def.name) @def.node
      (object_declaration   (type_identifier) @def.name) @def.node
      (function_declaration (simple_identifier) @def.name) @def.node
    `,
    imports: `
      (import_header (identifier) @import.module)
    `,
    calls: `
      (call_expression (simple_identifier) @call.name)
      (call_expression
        (navigation_expression
          (navigation_suffix (simple_identifier) @call.name)))
    `,
    inherits: `
      (class_declaration
        (delegation_specifier
          (user_type (type_identifier) @inherit.base)))
    `,
    variables: ``,
  },
  dart: {
    definitions: `
      (class_definition  name: (identifier) @def.name) @def.node
      (mixin_declaration name: (identifier) @def.name) @def.node
    `,
    imports: ``,
    calls: ``,
    inherits: ``,
    variables: ``,
  },
  csharp: {
    definitions: `
      (class_declaration       name: (identifier) @def.name) @def.node
      (interface_declaration   name: (identifier) @def.name) @def.node
      (struct_declaration      name: (identifier) @def.name) @def.node
      (enum_declaration        name: (identifier) @def.name) @def.node
      (method_declaration      name: (identifier) @def.name) @def.node
      (constructor_declaration name: (identifier) @def.name) @def.node
    `,
    imports: `
      (using_directive (identifier) @import.module)
      (using_directive (qualified_name (identifier) @import.module))
    `,
    calls: `
      (invocation_expression function: (identifier) @call.name)
      (invocation_expression
        function: (member_access_expression name: (identifier) @call.name))
      (object_creation_expression type: (identifier) @call.name)
    `,
    inherits: `
      (class_declaration     (base_list (identifier) @inherit.base))
      (interface_declaration (base_list (identifier) @inherit.base))
    `,
    variables: ``,
  },
  swift: {
    definitions: `
      (class_declaration    name: (type_identifier) @def.name) @def.node
      (protocol_declaration name: (type_identifier) @def.name) @def.node
      (function_declaration name: (simple_identifier) @def.name) @def.node
    `,
    imports: `
      (import_declaration (identifier) @import.module)
    `,
    calls: `
      (call_expression (simple_identifier) @call.name)
    `,
    inherits: ``,
    variables: ``,
  },
  perl: {
    definitions: `
      (subroutine (identifier) @def.name) @def.node
    `,
    imports: `
      (use_statement (package) @import.module)
      (require_expression (string) @import.module)
    `,
    calls: `
      (call_expression (identifier) @call.name)
    `,
    inherits: ``,
    variables: ``,
  }
};

function getLanguageQueryKey(path: string): string | null {
  const ext = path.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'js': case 'jsx': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'java': return 'java';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'hpp': case 'cc': return 'cpp';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'kt': case 'kts': return 'kotlin';
    case 'dart': return 'dart';
    case 'cs': return 'csharp';
    case 'swift': return 'swift';
    case 'pl': case 'pm': return 'perl';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Worker State
// ---------------------------------------------------------------------------
const pendingFileQueue: { path: string, content: string }[] = [];
let totalFiles = 0;
let processedCount = 0;
const parsedFilesData: any[] = [];
let indexOptions: any = {};

self.onmessage = async (e: MessageEvent) => {
  const { type, files } = e.data;

  if (type === 'ADD_FILES') {
    pendingFileQueue.push(...files);
    totalFiles += files.length;
  } else if (type === 'START') {
    indexOptions = e.data.options || {};
    try {
      self.postMessage({ type: 'PROGRESS', payload: { msg: "Initializing WASM Tree-sitter...", percent: 10 } });
      await initParser();
      processNextBatch();
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', payload: err.message });
    }
  }
};

async function processNextBatch() {
  if (pendingFileQueue.length === 0) {
    // Standard JS-native parsing completed, now compile with Python WASM
    self.postMessage({ type: 'PROGRESS', payload: { msg: "Spinning up Deep Python Engine...", percent: 70 } });
    await runPythonEngine();
    return;
  }

  const batch = pendingFileQueue.splice(0, 15);
  for (const f of batch) {
    processedCount++;
    if (processedCount % 5 === 0) {
      self.postMessage({
        type: 'PROGRESS',
        payload: {
          msg: `Parsing syntax tree: ${f.path.split('/').pop()}`,
          percent: 10 + Math.floor((processedCount / totalFiles) * 55)
        }
      });
    }

    const queryKey = getLanguageQueryKey(f.path);
    if (!queryKey) {
      // Still index files with no parser as empty definitions to preserve tree containment
      parsedFilesData.push({
        path: f.path,
        functions: [],
        classes: [],
        variables: [],
        imports: [],
        calls: [],
        inherits: []
      });
      continue;
    }

    const lang = await getLanguageForFile(f.path);
    if (!lang) continue;

    parser!.setLanguage(lang);
    try {
      const tree = parser!.parse(f.content);
      const root = tree.rootNode;
      const q = QUERIES[queryKey];
      
      const fileData: any = {
        path: f.path,
        functions: [],
        classes: [],
        variables: [],
        imports: [],
        calls: [],
        inherits: []
      };

      // 1. Definitions
      if (q.definitions) {
        const query = new Query(lang, q.definitions);
        const captures = query.captures(root);
        const nodeToMeta = new Map<number, any>();
        
        for (const cap of captures) {
          if (cap.name === 'def.node') {
            nodeToMeta.set(cap.node.id, {
              name: "",
              type: cap.node.type,
              line: cap.node.startPosition.row + 1,
              endLine: cap.node.endPosition.row + 1,
              source: f.content.substring(cap.node.startIndex, cap.node.endIndex)
            });
          }
        }

        // Pass 2: Map definition names
        for (const cap of captures) {
          if (cap.name === 'def.name') {
            let cur = cap.node.parent;
            while (cur) {
              if (nodeToMeta.has(cur.id)) {
                nodeToMeta.get(cur.id).name = cap.node.text;
                break;
              }
              cur = cur.parent;
            }
          }
        }

        for (const meta of nodeToMeta.values()) {
          if (meta.name) {
            if (meta.type.includes('class') || meta.type.includes('interface')) {
              fileData.classes.push({
                name: meta.name,
                line_number: meta.line,
                end_line: meta.endLine,
                source: meta.source
              });
            } else {
              fileData.functions.push({
                name: meta.name,
                line_number: meta.line,
                end_line: meta.endLine,
                source: meta.source
              });
            }
          }
        }
      }

      // 2. Imports
      if (q.imports) {
        const query = new Query(lang, q.imports);
        const captures = query.captures(root);
        for (const cap of captures) {
          if (cap.name === 'import.module') {
            fileData.imports.push({
              name: cap.node.text,
              line_number: cap.node.startPosition.row + 1
            });
          }
        }
      }

      // 3. Calls
      if (q.calls) {
        const query = new Query(lang, q.calls);
        const captures = query.captures(root);
        for (const cap of captures) {
          if (cap.name === 'call.name') {
            fileData.calls.push({
              name: cap.node.text,
              line_number: cap.node.startPosition.row + 1
            });
          }
        }
      }

      // 4. Inherits
      if (q.inherits) {
        const query = new Query(lang, q.inherits);
        const captures = query.captures(root);
        for (const cap of captures) {
          if (cap.name === 'inherit.base') {
            fileData.inherits.push(cap.node.text);
          }
        }
      }

      // 5. Variables
      if (indexOptions.indexVariables && q.variables) {
        const query = new Query(lang, q.variables);
        const captures = query.captures(root);
        for (const cap of captures) {
          if (cap.name === 'var.name') {
            fileData.variables.push({
              name: cap.node.text,
              line_number: cap.node.startPosition.row + 1
            });
          }
        }
      }

      parsedFilesData.push(fileData);
    } catch (err) {
      console.warn("Parse failure for file:", f.path, err);
    }
  }

  // Next iteration
  setTimeout(processNextBatch, 0);
}

async function runPythonEngine() {
  try {
    // Dynamic import to fetch Pyodide ESM lazily inside the ESM worker
    const pyodideModule: any = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.mjs");
    pyodideInstance = await pyodideModule.loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/"
    });

    self.postMessage({ type: 'PROGRESS', payload: { msg: "Running cross-file semantic analysis...", percent: 85 } });

    // Inject our data and Python compilation engine
    pyodideInstance.globals.set("FILES_DATA_JSON", JSON.stringify(parsedFilesData));
    
    // Core Python Resolution Engine (mirrors desktop cgc linking logic exactly)
    const pythonScript = `
import json

def build_graph(files_str):
    files = json.loads(files_str)
    
    nodes = []
    links = []
    
    node_id_seq = 1
    file_id_map = {}
    folder_nodes = {}
    symbol_index = {} # name -> list of node IDs
    
    def add_node(name, node_type, file_path, val, extra=None):
        nonlocal node_id_seq
        nid = node_id_seq
        node_id_seq += 1
        node_obj = {
            "id": nid,
            "name": name,
            "type": node_type,
            "file": file_path,
            "val": val
        }
        if extra:
            node_obj.update(extra)
            
        nodes.append(node_obj)
        
        # Index symbol
        symbol_key = f"{node_type}:{name}"
        symbol_index.setdefault(symbol_key, []).append(nid)
        symbol_index.setdefault(name, []).append(nid)
        return nid

    def get_or_create_folders(path):
        norm = path.replace('\\\\', '/')
        dir_part = norm.rsplit('/', 1)[0] if '/' in norm else ''
        if not dir_part:
            return 1 # attach to repository root
            
        parts = [p for p in dir_part.split('/') if p]
        parent_id = 1
        acc = ''
        for p in parts:
            acc = f"{acc}/{p}" if acc else p
            if acc in folder_nodes:
                parent_id = folder_nodes[acc]
            else:
                fid = add_node(p, 'Directory', acc, 12)
                links.append({"source": parent_id, "target": fid, "type": "CONTAINS"})
                folder_nodes[acc] = fid
                parent_id = fid
        return parent_id

    # Create Repo root
    repo_root_id = add_node("Repository", "Repository", "root", 15)

    # 1. Create File and Symbol nodes
    for f in files:
        path = f['path']
        filename = path.replace('\\\\', '/').split('/')[-1]
        
        # Add File node
        file_id = add_node(filename, 'File', path, 10)
        file_id_map[path] = file_id
        
        # Attach File to folder hierarchy
        parent_folder_id = get_or_create_folders(path)
        links.append({"source": parent_folder_id, "target": file_id, "type": "CONTAINS"})
        
        # Add Classes
        for cls in f.get('classes', []):
            cls_id = add_node(cls['name'], 'Class', path, 8, {
                "properties": {
                    "line_number": cls.get('line_number'),
                    "end_line": cls.get('end_line'),
                    "source": cls.get('source')
                }
            })
            links.append({"source": file_id, "target": cls_id, "type": "CONTAINS"})
            
        # Add Functions
        for func in f.get('functions', []):
            # Calculate complexity scores on Python side
            source_code = func.get('source', '')
            comp = 1 + source_code.count('if ') + source_code.count('for ') + source_code.count('while ') + source_code.count('except ')
            
            func_id = add_node(func['name'], 'Function', path, 6, {
                "properties": {
                    "line_number": func.get('line_number'),
                    "end_line": func.get('end_line'),
                    "cyclomatic_complexity": comp,
                    "source": source_code
                }
            })
            links.append({"source": file_id, "target": func_id, "type": "CONTAINS"})

        # Add Variables
        for var in f.get('variables', []):
            var_id = add_node(var['name'], 'Variable', path, 4, {
                "properties": {
                    "line_number": var.get('line_number')
                }
            })
            links.append({"source": file_id, "target": var_id, "type": "CONTAINS"})

    # Helper to resolve symbol targets
    def resolve_symbol(name, node_type, caller_file):
        # Prefer exact type matches first
        key = f"{node_type}:{name}"
        candidates = symbol_index.get(key, [])
        if not candidates:
            candidates = symbol_index.get(name, [])
        if not candidates:
            return None
            
        # Preference: Node in same file
        for c in candidates:
            if nodes[c-1]['file'] == caller_file:
                return c
        return candidates[0]

    # 2. Establish semantic links (CALLS, INHERITS)
    for f in files:
        path = f['path']
        file_id = file_id_map.get(path)
        if not file_id:
            continue
            
        # Add inherits
        for cls in f.get('classes', []):
            cls_node_id = resolve_symbol(cls['name'], 'Class', path)
            if not cls_node_id:
                continue
            for base in f.get('inherits', []):
                base_node_id = resolve_symbol(base, 'Class', path)
                if base_node_id:
                    links.append({"source": cls_node_id, "target": base_node_id, "type": "INHERITS"})

        # Add calls
        for call in f.get('calls', []):
            # Resolve call target
            target_id = resolve_symbol(call['name'], 'Function', path) or resolve_symbol(call['name'], 'Class', path)
            if target_id and target_id != file_id:
                links.append({"source": file_id, "target": target_id, "type": "CALLS"})

    # Extract clean file list
    all_files = list(file_id_map.keys())

    return json.dumps({
        "nodes": nodes,
        "links": links,
        "files": all_files
    })

# Run the execution inside Pyodide
build_graph(FILES_DATA_JSON)
`;

    const finalResult = pyodideInstance.runPython(pythonScript);
    const graphData = JSON.parse(finalResult);

    self.postMessage({ type: 'PROGRESS', payload: { msg: "Finalizing data structures...", percent: 100 } });
    self.postMessage({ type: 'DONE', payload: graphData });
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', payload: err.message });
  }
}
