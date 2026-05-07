"""
scip_indexer.py
---------------
SCIP-based indexing pipeline. Only activated when SCIP_INDEXER=true in config.

SCIP (Semantic Code Intelligence Protocol) is a language-agnostic protocol that
uses actual compiler / type-checker tooling (e.g. Pyright for Python, tsc for
TypeScript) to produce a single `index.scip` protobuf file containing:
  - Every symbol definition (function, class, variable) with its file + line
  - Every symbol reference, mapping back to its definition
  - Type signatures, docstrings, and symbol kinds

This gives us compiler-level accuracy for CALLS and INHERITS edges instead of
the heuristic imports_map approach used in Tree-sitter mode.

Workflow (called by GraphBuilder.build_graph_from_path_async when enabled):
  1. ScipIndexer.run(path) → runs the appropriate scip-<lang> CLI, returns path to index.scip
  2. ScipIndexParser.parse(index_scip_path) → returns {nodes, edges} dicts
  3. indexing.persistence.GraphWriter writes nodes + edges via the same Cypher MERGE queries as Tree-sitter mode.
  4. Tree-sitter supplement pass adds: cyclomatic_complexity, source text, decorators.

Supported SCIP indexers and their install commands:
  python     → pip install scip-python   (uses Pyright)
  typescript → npm install -g @sourcegraph/scip-typescript
  javascript → npm install -g @sourcegraph/scip-typescript  (same binary, uses --infer-tsconfig for JS-only projects)
  go         → go install github.com/sourcegraph/scip-go/cmd/scip-go@latest
  rust       → cargo install scip-rust (or rustup component add rust-analyzer)
  java       → https://github.com/sourcegraph/scip-java

JavaScript indexing notes:
  - Pure JS projects (no tsconfig.json): scip-typescript index --infer-tsconfig
  - Mixed JS/TS projects (tsconfig.json present): scip-typescript index  (tsconfig covers .js via allowJs)
  - Add @types/* packages as devDependencies for better type inference quality.
"""

import os
# Fix for protobuf 4.x+ version mismatch with scip-python's generated protos
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..utils.debug_log import info_logger, warning_logger, error_logger, debug_log

# ---------------------------------------------------------------------------
# Language → SCIP indexer mapping
# ---------------------------------------------------------------------------

# Maps file extension → (language name, scip CLI binary name, install hint)
EXTENSION_TO_SCIP: Dict[str, Tuple[str, str, str]] = {
    ".py":   ("python",     "scip-python",     "pip install scip-python"),
    ".ipynb":("python",     "scip-python",     "pip install scip-python"),
    ".ts":   ("typescript", "scip-typescript", "npm install -g @sourcegraph/scip-typescript"),
    ".tsx":  ("typescript", "scip-typescript", "npm install -g @sourcegraph/scip-typescript"),
    ".js":   ("javascript", "scip-typescript", "npm install -g @sourcegraph/scip-typescript"),
    ".jsx":  ("javascript", "scip-typescript", "npm install -g @sourcegraph/scip-typescript"),
    ".mjs":  ("javascript", "scip-typescript", "npm install -g @sourcegraph/scip-typescript"),
    ".cjs":  ("javascript", "scip-typescript", "npm install -g @sourcegraph/scip-typescript"),
    ".go":   ("go",         "scip-go",         "go install github.com/sourcegraph/scip-go/...@latest"),
    ".rs":   ("rust",       "scip-rust",       "cargo install scip-rust"),
    ".java": ("java",       "scip-java",       "see https://github.com/sourcegraph/scip-java"),
    ".cpp":  ("cpp",        "scip-clang",      "brew install llvm"),
    ".hpp":  ("cpp",        "scip-clang",      "brew install llvm"),
    ".c":    ("c",          "scip-clang",      "brew install llvm"),
    ".h":    ("cpp",        "scip-clang",      "brew install llvm"),
}


def is_scip_available(lang: str) -> bool:
    """Check whether the SCIP indexer binary for this language is installed."""
    for ext, (l, binary, _) in EXTENSION_TO_SCIP.items():
        if l == lang:
            return shutil.which(binary) is not None
    return False


def detect_project_lang(path: Path, scip_languages: List[str]) -> Optional[str]:
    """
    Detect the primary language of a project folder by counting files.
    Only returns a language if it is in the user's SCIP_LANGUAGES list.
    """
    if not path.is_dir():
        ext = path.suffix
        lang = EXTENSION_TO_SCIP.get(ext, (None,))[0]
        return lang if lang in scip_languages else None

    counts: Dict[str, int] = {}
    for ext, (lang, _, _) in EXTENSION_TO_SCIP.items():
        if lang not in scip_languages:
            continue
        counts[lang] = counts.get(lang, 0) + sum(
            1 for _ in path.rglob(f"*{ext}")
        )

    if not counts:
        return None
    return max(counts, key=counts.__getitem__)


# ---------------------------------------------------------------------------
# SCIP runner
# ---------------------------------------------------------------------------

class ScipIndexer:
    """
    Runs the appropriate scip-<lang> CLI tool on a project directory and
    returns the path to the resulting index.scip file.
    """

    def run(self, project_path: Path, lang: str, output_dir: Path) -> Optional[Path]:
        """
        Run the SCIP indexer for `lang` on `project_path`.
        Returns path to index.scip, or None if the indexer failed / is not installed.
        """
        binary, install_hint = self._get_binary(lang)
        if not binary:
            warning_logger(
                f"SCIP indexer for '{lang}' not found. "
                f"Install with: {install_hint}"
            )
            return None

        output_file = output_dir / "index.scip"
        cmd = self._build_command(lang, binary, project_path, output_file)
        if not cmd:
            warning_logger(f"No SCIP command template defined for language: {lang}")
            return None

        info_logger(f"Running SCIP indexer: {' '.join(str(c) for c in cmd)}")
        try:
            result = subprocess.run(
                cmd,
                cwd=str(project_path),
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute hard limit
            )
            if result.returncode != 0:
                warning_logger(
                    f"SCIP indexer exited with code {result.returncode}.\n"
                    f"stderr: {result.stderr[:500]}"
                )
                return None

            if not output_file.exists():
                warning_logger(f"SCIP indexer ran but no index.scip produced at {output_file}")
                return None

            info_logger(f"SCIP index written to {output_file} ({output_file.stat().st_size // 1024} KB)")
            return output_file

        except subprocess.TimeoutExpired:
            warning_logger("SCIP indexer timed out after 5 minutes.")
            return None
        except Exception as e:
            warning_logger(f"SCIP indexer failed with exception: {e}")
            return None

    def _get_binary(self, lang: str) -> Tuple[Optional[str], str]:
        for ext, (l, binary, install_hint) in EXTENSION_TO_SCIP.items():
            if l == lang:
                found = shutil.which(binary)
                return found, install_hint
        return None, "unknown language"

    def _build_command(self, lang: str, binary: str, project_path: Path, output_file: Path) -> Optional[List]:
        """Build the CLI command for each supported SCIP indexer."""
        out = str(output_file)

        if lang == "python":
            # scip-python index . --output index.scip
            return [binary, "index", ".", "--output", out]

        elif lang == "typescript":
            # scip-typescript index --output index.scip
            # Requires tsconfig.json in the project root.
            return [binary, "index", "--output", out]

        elif lang == "javascript":
            # scip-typescript handles JavaScript too via the same binary.
            #
            # - Pure JS projects (no tsconfig.json): use --infer-tsconfig so
            #   scip-typescript auto-generates a temporary tsconfig covering all
            #   .js/.jsx/.mjs/.cjs files.  Requires package.json at the root.
            # - Mixed JS/TS projects (tsconfig.json present): use the standard
            #   command; the tsconfig should already have allowJs:true.
            has_tsconfig = (project_path / "tsconfig.json").exists()
            if has_tsconfig:
                info_logger(
                    "JavaScript project has tsconfig.json — running scip-typescript index "
                    "(ensure allowJs:true is set for full JS coverage)."
                )
                return [binary, "index", "--output", out]
            else:
                info_logger(
                    "JavaScript project has no tsconfig.json — running scip-typescript index "
                    "--infer-tsconfig (auto-generates a temporary tsconfig)."
                )
                return [binary, "index", "--infer-tsconfig", "--output", out]

        elif lang == "go":
            # scip-go --output index.scip
            return [binary, "--output", out]

        elif lang == "rust":
            # scip-rust index --output index.scip
            return [binary, "index", "--output", out]

        elif lang == "java":
            # scip-java index --build-tool gradle/maven --output index.scip
            return [binary, "index", "--output", out]

        elif lang in ("cpp", "c"):
            # scip-clang --index-output-path index.scip
            return [binary, f"--index-output-path={out}"]

        return None


# ---------------------------------------------------------------------------
# SCIP proto parser
# ---------------------------------------------------------------------------

class ScipIndexParser:
    """
    Parses a SCIP index.scip protobuf file and converts it into the same
    dict structures consumed by indexing.persistence.GraphWriter (same shape as Tree-sitter output).

    Output format mirrors what Tree-sitter produces:
      nodes: {"functions": [...], "classes": [...], "variables": [...], "imports": [...]}
      edges: [{"type": "CALLS"|"INHERITS"|"IMPORTS", "from_*": ..., "to_*": ...}, ...]

    NOTE: This requires the `scip` Python package:
      pip install scip-python  (includes the protobuf bindings)
    """

    def parse(self, index_scip_path: Path, project_path: Path) -> Dict[str, Any]:
        """
        Parse index.scip and return a dict:
        {
          "files": {
              "relative/path.py": {
                  "functions": [...],
                  "classes":   [...],
                  "variables": [...],
                  "imports":   [...],
                  "function_calls_scip": [  ← edges, not tree-sitter calls list
                      {"caller_symbol": ..., "callee_file": ..., "callee_line": ...}
                  ]
              }
          }
        }
        """
        try:
            from . import scip_pb2  # type: ignore
        except Exception as e:
            error_logger(
                "Failed to import codegraphcontext.tools.scip_pb2. "
                "Ensure protobuf>=3.20,<3.21 is installed in the CodeGraphContext environment. "
                f"Original error: {e}"
            )
            return {}

        try:
            with open(index_scip_path, "rb") as f:
                index = scip_pb2.Index()
                index.ParseFromString(f.read())
        except Exception as e:
            error_logger(f"Failed to parse SCIP index at {index_scip_path}: {e}")
            return {}

        # Build a global symbol → (file, line, kind) lookup table
        # from all definition occurrences across all documents
        symbol_def_table: Dict[str, Dict] = {}  # symbol_str → {file, line, kind, display_name, doc}

        # First pass: collect all definitions
        for doc in index.documents:
            for occ in doc.occurrences:
                if occ.symbol.startswith("local "):
                    continue
                # role bit 0 = Definition (SCIP 0.6.0+ uses symbol_roles)
                # Try symbol_roles first, then fallback to role if present
                role = getattr(occ, "symbol_roles", getattr(occ, "role", 0))
                if role & 1:
                    symbol_def_table[occ.symbol] = {
                        "file": doc.relative_path,
                        "line": occ.range[0] + 1 if occ.range else 0,
                    }

        # Enrich with metadata from the symbols table
        # SCIP 0.6.0+ stores symbols defined in the document inside doc.symbols
        for doc in index.documents:
            for sym_info in doc.symbols:
                if sym_info.symbol in symbol_def_table:
                    symbol_def_table[sym_info.symbol]["display_name"] = sym_info.display_name
                    symbol_def_table[sym_info.symbol]["documentation"] = "\n".join(sym_info.documentation)
                    symbol_def_table[sym_info.symbol]["kind"] = sym_info.kind

        # Also check external_symbols
        for sym_info in index.external_symbols:
            if sym_info.symbol in symbol_def_table:
                symbol_def_table[sym_info.symbol]["display_name"] = sym_info.display_name
                symbol_def_table[sym_info.symbol]["documentation"] = "\n".join(sym_info.documentation)
                symbol_def_table[sym_info.symbol]["kind"] = sym_info.kind

        # Final pass: infer kind from symbol string when SCIP reported kind=0.
        # scip-python often emits kind=0 even for classes and functions.
        #   - Symbol ending with '#'        → Class     (kind 7)
        #   - Symbol ending with '().'      → Function  (kind 17) or Method (kind 26)
        for sym, info in symbol_def_table.items():
            if info.get("kind", 0) == 0:
                if sym.endswith("#"):
                    info["kind"] = 7   # Class
                elif sym.endswith("()."):
                    # Treat as Method (26) if inside a class scope (#), else Function (17)
                    info["kind"] = 26 if "#" in sym else 17

        # Second pass: extract per-file nodes and reference edges
        files_data: Dict[str, Dict] = {}

        # Pre-read source lines for all docs for call-site verification
        doc_source_lines: Dict[str, List[str]] = {}
        for doc in index.documents:
            src_path = project_path / doc.relative_path
            try:
                doc_source_lines[doc.relative_path] = src_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:
                doc_source_lines[doc.relative_path] = []

        for doc in index.documents:
            rel_path = doc.relative_path
            abs_path = str((project_path / rel_path).resolve())
            source_lines = doc_source_lines.get(rel_path, [])

            file_data: Dict[str, Any] = {
                "functions": [],
                "classes": [],
                "variables": [],
                "imports": [],
                "function_calls_scip": [],
                "module_level_calls_scip": [],  # top-level (module scope) calls
                "path": abs_path,
                "lang": self._lang_from_path(rel_path),
                "is_dependency": False,
            }

            # Track which symbol is the enclosing definition at each line
            # so we know what "calls" what. Also store enclosing_range for
            # accurate scope containment checks.
            definition_symbols_in_doc = []
            for occ in doc.occurrences:
                role = getattr(occ, "symbol_roles", getattr(occ, "role", 0))
                if role & 1: # Definition
                    definition_symbols_in_doc.append(occ)

            for occ in doc.occurrences:
                sym = occ.symbol
                if sym.startswith("local "):
                    continue
                line = occ.range[0] + 1 if occ.range else 0
                # Try symbol_roles first, then fallback to role if present
                role = getattr(occ, "symbol_roles", getattr(occ, "role", 0))

                if role & 1:  # Definition
                    defn = symbol_def_table.get(sym, {})
                    kind = defn.get("kind", 0)
                    
                    # If kind is 0 (Unspecified), guess from symbol string
                    if kind == 0:
                        if sym.endswith("()."):
                            kind = 17  # Function
                        elif "#" in sym and not sym.endswith("."):
                             # If it ends with # (e.g. MyClass#) or has # then members
                             if sym.endswith("#"):
                                 kind = 7 # Class
                             elif sym.endswith("()."):
                                 kind = 26 # Method
                             else:
                                 # Possibly a field or nested class or parameter
                                 pass 

                    display = defn.get("display_name", "")
                    doc_str = defn.get("documentation", "")
                    name = self._name_from_symbol(sym)
                    args, return_type = self._parse_signature(display, kind)

                    node = {
                        "name": name,
                        "line_number": line,
                        "end_line": line,
                        "docstring": doc_str or None,
                        "lang": file_data["lang"],
                        "is_dependency": False,
                        # SCIP gives us these for free:
                        "return_type": return_type,
                        "args": args,
                    }

                    # kind values from SCIP 0.6.0+ proto:
                    # 26=Method, 17=Function -> Function node
                    # 7=Class               -> Class node
                    # 61=Variable, 15=Field -> Variable node
                    if kind in (26, 17):  # Method, Function
                        node["cyclomatic_complexity"] = 1  # filled by Tree-sitter supplement
                        node["decorators"] = []
                        node["context"] = None
                        node["class_context"] = None
                        file_data["functions"].append(node)
                    elif kind == 7:  # Class
                        node["bases"] = []
                        node["context"] = None
                        file_data["classes"].append(node)
                    elif kind in (61, 15):  # Variable, Field
                        node["value"] = None
                        node["type"] = return_type
                        node["context"] = None
                        node["class_context"] = None
                        file_data["variables"].append(node)

                else:  # Reference — filter to true call-sites, then build edges
                    if sym not in symbol_def_table:
                        continue

                    callee_info = symbol_def_table[sym]
                    callee_kind = callee_info.get("kind", 0)

                    # ── FIX 1: Only treat as a call when '(' immediately follows
                    # the referenced token in the source.  This eliminates false
                    # positives where a function is passed as an argument, returned,
                    # used as a decorator without args, etc.
                    # We also accept Class-kind references followed by '(' because
                    # that is a constructor / instantiation call.
                    r = list(occ.range)
                    ref_line_idx = r[0]
                    col_end = r[2] if len(r) > 2 else (r[1] if len(r) > 1 else 0)
                    src_line = source_lines[ref_line_idx] if ref_line_idx < len(source_lines) else ""
                    char_after = src_line[col_end:col_end + 1] if col_end < len(src_line) else ""

                    # Callable: functions/methods must be followed by '('; classes
                    # must also be followed by '(' (instantiation).
                    is_callable_ref = char_after == "("
                    if not is_callable_ref:
                        continue

                    # ── FIX 2: Enclosing caller — use improved scope check
                    caller_sym = self._find_enclosing_definition(
                        line, definition_symbols_in_doc
                    )

                    edge = {
                        "callee_symbol": sym,
                        "callee_file": str(
                            (project_path / callee_info["file"]).resolve()
                        ),
                        "callee_line": callee_info["line"],
                        "callee_name": self._name_from_symbol(sym),
                        "callee_kind": callee_kind,
                        "ref_line": line,
                        "caller_file": abs_path,
                    }

                    if caller_sym:
                        caller_info = symbol_def_table.get(caller_sym, {})
                        edge["caller_symbol"] = caller_sym
                        edge["caller_line"] = caller_info.get("line", 0)
                        file_data["function_calls_scip"].append(edge)
                    else:
                        # ── FIX 3: Module-level (top-level) call — no enclosing fn
                        # Record separately so scip_pipeline can write File->Fn edges.
                        edge["caller_symbol"] = None
                        edge["caller_line"] = 0
                        file_data["module_level_calls_scip"].append(edge)

            files_data[abs_path] = file_data

        info_logger(
            f"SCIP parse complete: {len(files_data)} files, "
            f"{sum(len(v.get('function_calls_scip',[])) for v in files_data.values())} reference edges"
        )
        return {"files": files_data, "symbol_table": symbol_def_table}

    def _name_from_symbol(self, symbol: str) -> str:
        """Extract the human-readable name from a SCIP symbol ID."""
        # SCIP symbols look like: "scip-python . . mymodule/MyClass#method()."
        import re
        s = symbol.rstrip(".#")
        s = re.sub(r"\(\)\.?$", "", s) # Remove trailing () or ().
        parts = re.split(r'[/#]', s)
        last = parts[-1] if parts else symbol
        return last or symbol

    def _lang_from_path(self, rel_path: str) -> str:
        """Guess language from file extension."""
        ext_map = {
            ".py": "python", ".ipynb": "python",
            ".ts": "typescript", ".tsx": "typescript",
            ".js": "javascript", ".jsx": "javascript",
            ".go": "go", ".rs": "rust",
            ".java": "java", ".cpp": "cpp", ".c": "c", ".h": "cpp",
        }
        suffix = Path(rel_path).suffix
        return ext_map.get(suffix, "unknown")

    def _parse_signature(self, display_name: str, kind: int) -> Tuple[List[str], Optional[str]]:
        """
        Extract parameter names and return type from a SCIP display_name string.
        e.g. "def method(self, x: int, y: str) -> Response"
             → (["self", "x", "y"], "Response")
        """
        args: List[str] = []
        return_type: Optional[str] = None

        if not display_name:
            return args, return_type

        # Return type after '->'
        if "->" in display_name:
            parts = display_name.rsplit("->", 1)
            return_type = parts[1].strip().rstrip(":")

        # Parameters between first ( and last )
        param_match = re.search(r"\(([^)]*)\)", display_name)
        if param_match:
            raw_params = param_match.group(1)
            for param in raw_params.split(","):
                param = param.strip()
                if not param:
                    continue
                # "x: int = 5" → "x"
                name = param.split(":")[0].split("=")[0].strip()
                # Remove * and ** prefixes
                name = name.lstrip("*")
                if name:
                    args.append(name)

        return args, return_type

    def _find_enclosing_definition(
        self, ref_line: int, definition_occurrences: list
    ) -> Optional[str]:
        """
        Given a reference at `ref_line`, find the symbol whose definition scope
        (enclosing_range) contains this line, preferring the innermost (largest
        start line). Falls back to nearest-before heuristic only when SCIP
        provides no enclosing_range data at all (older SCIP versions).
        Returns None if the call is at module scope.
        """
        # --- Pass 1: use enclosing_range when available ---
        best_enclosing: Optional[str] = None
        best_enclosing_start = -1
        any_enclosing_range_present = False
        for occ in definition_occurrences:
            # Skip module symbols (they end with '/' and act as the entire file scope)
            if occ.symbol.endswith("/"):
                continue
            er = list(getattr(occ, "enclosing_range", []))
            if not er:
                continue
            any_enclosing_range_present = True
            # SCIP enclosing_range format:
            #   3-element [line, col_start, col_end]        → same-line range
            #   4-element [start_line, start_col, end_line, end_col] → multi-line
            if len(er) == 4:
                enc_start = er[0] + 1  # 0-indexed → 1-indexed
                enc_end = er[2] + 1
            else:
                # single-line: [line, col_start, col_end] — only covers that line
                enc_start = er[0] + 1
                enc_end = enc_start
            if enc_start <= ref_line <= enc_end:
                if enc_start > best_enclosing_start:
                    best_enclosing = occ.symbol
                    best_enclosing_start = enc_start
        if best_enclosing:
            return best_enclosing

        # When SCIP provided enclosing_range data for this document, trust it
        # completely: no enclosing range covers ref_line → module scope call.
        if any_enclosing_range_present:
            return None

        # --- Pass 2: fallback — nearest function/method def before ref_line ---
        # Only used for SCIP versions that don't emit enclosing_range.
        best: Optional[str] = None
        best_line = -1
        for occ in definition_occurrences:
            sym = occ.symbol
            # Only consider callable definitions (functions/methods end with '().')
            if not sym.endswith("()."):
                continue
            # Skip module __init__ pseudo-symbol
            if sym.endswith("/__init__:"):
                continue
            occ_line = occ.range[0] + 1 if occ.range else 0
            if occ_line <= ref_line and occ_line > best_line:
                best = sym
                best_line = occ_line
        return best

