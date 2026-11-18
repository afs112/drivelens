#!/usr/bin/env python3
"""Comprehensive verification suite for DriveLens (stdlib only).

Checks:
  a) Live HTTP server verification via serve.create_server on ('127.0.0.1', 0):
     fetches /index.html, /src/constants.js, every <link rel="stylesheet"> in index.html,
     and recursively every transitive relative ES module import from /src/main.js.
     Asserts HTTP 200, non-empty response body, and strict MIME types.
  b) Static ES Module Graph & Export Verification across src/**/*.js:
     resolves relative imports on disk (case-sensitively) and verifies every
     imported symbol is exported by the target module.
  c) HTML <-> JS DOM ID & Tag/Syntax Balance Verification:
     verifies every #id queried via getElementById(...) or querySelector('#...')
     in src/main.js exists in index.html; verifies HTML tag balance in index.html;
     verifies balanced {}, (), [] and valid tokens in all .js and .css files.
  d) Documentation presence & non-empty verification (ARCHITECTURE.md, README.md).
"""

from html.parser import HTMLParser
import http.client
import io
import json
import os
from pathlib import Path
import posixpath
import re
import struct
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = Path(__file__).resolve().parent

VOID_HTML_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

REGEX_PREV_KEYWORDS = {
    "return", "throw", "case", "default", "delete", "void", "typeof",
    "await", "yield", "in", "instanceof", "of", "new", "else", "do", "export",
}

REGEX_PREV_PUNCTS = {
    "(", "[", "{", ",", ";", ":", "?", "=", "+=", "-=", "*=", "/=", "%=",
    "**=", "&&=", "||=", "??=", "<<=", ">>=", ">>>=", "&=", "|=", "^=",
    "=>", "!", "~", "+", "-", "*", "/", "%", "**", "<<", ">>", ">>>",
    "<", "<=", ">", ">=", "==", "!=", "===", "!==", "&", "|", "^",
    "&&", "||", "??", "...",
}

STMT_PAREN_KEYWORDS = {"if", "while", "for", "with", "catch"}


class Token:
    __slots__ = ("kind", "value", "line", "col", "_after_stmt_paren")

    def __init__(self, kind, value, line, col):
        self.kind = kind
        self.value = value
        self.line = line
        self.col = col
        self._after_stmt_paren = False

    def __repr__(self):
        return f"Token({self.kind}, {self.value!r}, {self.line}:{self.col})"


def tokenize_js(source, filename="<js>"):
    """Tokenize JS source accurately, handling strings, comments, regexes, and template literals."""
    tokens = []
    n = len(source)
    i = 0
    line = 1
    col = 1

    # Stack entries: ('brace', '{'), ('paren', is_stmt_header), ('bracket', '['), ('tpl', None)
    stack = []
    prev_sig = None  # Previous non-comment token
    mode = "code"  # 'code' or 'template'

    def advance(ch):
        nonlocal i, line, col
        if ch == "\n":
            line += 1
            col = 1
        else:
            col += 1
        i += 1

    def can_start_regex(prev):
        if prev is None:
            return True
        if prev.kind == "IDENT" and prev.value in REGEX_PREV_KEYWORDS:
            return True
        if prev.kind == "PUNCT":
            if prev.value in REGEX_PREV_PUNCTS:
                return True
            if prev.value == ")":
                # Regex can follow `if (...) /re/`, not `(a + b) / c`
                return getattr(prev, "_after_stmt_paren", False)
            if prev.value == "}":
                return True
        return False

    while i < n:
        if mode == "template":
            start_line, start_col = line, col
            buf = []
            closed = False
            while i < n:
                ch = source[i]
                if ch == "\\":
                    buf.append(ch)
                    advance(ch)
                    if i < n:
                        buf.append(source[i])
                        advance(source[i])
                elif ch == "`":
                    advance(ch)
                    closed = True
                    tokens.append(Token("TEMPLATE", "".join(buf), start_line, start_col))
                    prev_sig = tokens[-1]
                    mode = "code"
                    break
                elif ch == "$" and i + 1 < n and source[i + 1] == "{":
                    advance("$")
                    advance("{")
                    stack.append(("tpl", start_line, start_col))
                    tok = Token("PUNCT", "${", start_line, start_col)
                    tokens.append(tok)
                    prev_sig = tok
                    mode = "code"
                    closed = True
                    break
                else:
                    buf.append(ch)
                    advance(ch)
            if not closed:
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unterminated template literal")
            continue

        ch = source[i]
        # Whitespace
        if ch in " \t\r\n\f\v":
            advance(ch)
            continue

        start_line, start_col = line, col

        # Line comment
        if ch == "/" and i + 1 < n and source[i + 1] == "/":
            advance("/")
            advance("/")
            while i < n and source[i] != "\n":
                advance(source[i])
            continue

        # Block comment
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            advance("/")
            advance("*")
            closed = False
            while i < n:
                if source[i] == "*" and i + 1 < n and source[i + 1] == "/":
                    advance("*")
                    advance("/")
                    closed = True
                    break
                advance(source[i])
            if not closed:
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unterminated block comment")
            continue

        # String literal
        if ch in ("'", '"'):
            quote = ch
            buf = [ch]
            advance(ch)
            closed = False
            while i < n:
                c = source[i]
                if c == "\\":
                    buf.append(c)
                    advance(c)
                    if i < n:
                        if source[i] == "\r" and i + 1 < n and source[i + 1] == "\n":
                            buf.append("\r\n")
                            advance("\r")
                            advance("\n")
                        else:
                            buf.append(source[i])
                            advance(source[i])
                elif c == "\n":
                    break
                elif c == quote:
                    buf.append(c)
                    advance(c)
                    closed = True
                    break
                else:
                    buf.append(c)
                    advance(c)
            if not closed:
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unterminated string literal")
            tok = Token("STRING", "".join(buf), start_line, start_col)
            tokens.append(tok)
            prev_sig = tok
            continue

        # Template literal start
        if ch == "`":
            advance("`")
            mode = "template"
            continue

        # Regex literal vs division
        if ch == "/" and can_start_regex(prev_sig):
            buf = ["/"]
            advance("/")
            in_class = False
            closed = False
            while i < n:
                c = source[i]
                if c == "\\":
                    buf.append(c)
                    advance(c)
                    if i < n and source[i] != "\n":
                        buf.append(source[i])
                        advance(source[i])
                    else:
                        break
                elif c == "\n":
                    break
                elif c == "[" and not in_class:
                    in_class = True
                    buf.append(c)
                    advance(c)
                elif c == "]" and in_class:
                    in_class = False
                    buf.append(c)
                    advance(c)
                elif c == "/" and not in_class:
                    buf.append(c)
                    advance(c)
                    while i < n and source[i].isalpha():
                        buf.append(source[i])
                        advance(source[i])
                    closed = True
                    break
                else:
                    buf.append(c)
                    advance(c)
            if not closed:
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unterminated regex literal")
            tok = Token("REGEX", "".join(buf), start_line, start_col)
            tokens.append(tok)
            prev_sig = tok
            continue

        # Identifier / Keyword
        if ch.isalpha() or ch in "_$":
            buf = []
            while i < n and (source[i].isalnum() or source[i] in "_$"):
                buf.append(source[i])
                advance(source[i])
            tok = Token("IDENT", "".join(buf), start_line, start_col)
            tokens.append(tok)
            prev_sig = tok
            continue

        # Number
        if ch.isdigit() or (ch == "." and i + 1 < n and source[i + 1].isdigit()):
            buf = []
            while i < n and (source[i].isalnum() or source[i] in "._"):
                buf.append(source[i])
                advance(source[i])
            tok = Token("NUMBER", "".join(buf), start_line, start_col)
            tokens.append(tok)
            prev_sig = tok
            continue

        # Multi-char punctuators (longest match first)
        matched_punct = None
        for op in (
            ">>>=", ">>>", "===", "!==", "&&=", "||=", "??=", "<<=", ">>=",
            "**=", "...", "=>", "++", "--", "&&", "||", "??", "==", "!=",
            "<=", ">=", "<<", ">>", "**", "+=", "-=", "*=", "/=", "%=",
            "&=", "|=", "^=", "?.",
        ):
            if source.startswith(op, i):
                matched_punct = op
                break
        if matched_punct:
            for c in matched_punct:
                advance(c)
            tok = Token("PUNCT", matched_punct, start_line, start_col)
            tokens.append(tok)
            prev_sig = tok
            continue

        # Single-char delimiters & punctuators
        advance(ch)
        if ch == "{":
            stack.append(("brace", start_line, start_col))
            tok = Token("PUNCT", "{", start_line, start_col)
        elif ch == "}":
            if not stack:
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unmatched '}}'")
            top_kind, top_line, top_col = stack.pop()
            if top_kind == "tpl":
                tok = Token("PUNCT", "}", start_line, start_col)
                tokens.append(tok)
                prev_sig = tok
                mode = "template"
                continue
            if top_kind != "brace":
                raise SyntaxError(
                    f"{filename}:{start_line}:{start_col}: Mismatched '}}' (opened {top_kind} at {top_line}:{top_col})"
                )
            tok = Token("PUNCT", "}", start_line, start_col)
        elif ch == "(":
            is_stmt = bool(prev_sig and prev_sig.kind == "IDENT" and prev_sig.value in STMT_PAREN_KEYWORDS)
            stack.append(("paren", start_line, start_col, is_stmt))
            tok = Token("PUNCT", "(", start_line, start_col)
        elif ch == ")":
            if not stack or stack[-1][0] != "paren":
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unmatched ')'")
            _, _, _, is_stmt = stack.pop()
            tok = Token("PUNCT", ")", start_line, start_col)
            tok._after_stmt_paren = is_stmt
        elif ch == "[":
            stack.append(("bracket", start_line, start_col))
            tok = Token("PUNCT", "[", start_line, start_col)
        elif ch == "]":
            if not stack or stack[-1][0] != "bracket":
                raise SyntaxError(f"{filename}:{start_line}:{start_col}: Unmatched ']'")
            stack.pop()
            tok = Token("PUNCT", "]", start_line, start_col)
        else:
            tok = Token("PUNCT", ch, start_line, start_col)

        tokens.append(tok)
        prev_sig = tok

    if stack:
        top = stack[-1]
        raise SyntaxError(f"{filename}:{top[1]}:{top[2]}: Unclosed {top[0]}")

    return tokens


def check_css_balance(source, filename="<css>"):
    """Verify CSS comments, strings, and balanced {}, (), [] delimiters."""
    n = len(source)
    i = 0
    line = 1
    col = 1
    stack = []
    pairs = {"}": "{", ")": "(", "]": "["}

    def advance(ch):
        nonlocal i, line, col
        if ch == "\n":
            line += 1
            col = 1
        else:
            col += 1
        i += 1

    while i < n:
        ch = source[i]
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            sl, sc = line, col
            advance("/")
            advance("*")
            closed = False
            while i < n:
                if source[i] == "*" and i + 1 < n and source[i + 1] == "/":
                    advance("*")
                    advance("/")
                    closed = True
                    break
                advance(source[i])
            if not closed:
                raise SyntaxError(f"{filename}:{sl}:{sc}: Unterminated CSS comment")
            continue

        if ch in ("'", '"'):
            quote = ch
            sl, sc = line, col
            advance(ch)
            closed = False
            while i < n:
                c = source[i]
                if c == "\\":
                    advance(c)
                    if i < n:
                        advance(source[i])
                elif c == "\n":
                    break
                elif c == quote:
                    advance(c)
                    closed = True
                    break
                else:
                    advance(c)
            if not closed:
                raise SyntaxError(f"{filename}:{sl}:{sc}: Unterminated CSS string")
            continue

        if ch in "{([":
            stack.append((ch, line, col))
        elif ch in "})]":
            if not stack or stack[-1][0] != pairs[ch]:
                raise SyntaxError(f"{filename}:{line}:{col}: Unmatched CSS '{ch}'")
            stack.pop()
        advance(ch)

    if stack:
        ch, sl, sc = stack[-1]
        raise SyntaxError(f"{filename}:{sl}:{sc}: Unclosed CSS '{ch}'")


def unquote_string(tok_val):
    if len(tok_val) >= 2 and tok_val[0] == tok_val[-1] and tok_val[0] in ("'", '"'):
        inner = tok_val[1:-1]
        simple_escapes = {
            "n": "\n",
            "r": "\r",
            "t": "\t",
            "b": "\b",
            "f": "\f",
            "v": "\v",
            "0": "\0",
            "\\": "\\",
            "'": "'",
            '"': '"',
        }

        def repl(m):
            esc = m.group(1)
            if esc in simple_escapes:
                return simple_escapes[esc]
            if esc.startswith("u{") and esc.endswith("}"):
                return chr(int(esc[2:-1], 16))
            if esc.startswith("u") and len(esc) == 5:
                return chr(int(esc[1:], 16))
            if esc.startswith("x") and len(esc) == 3:
                return chr(int(esc[1:], 16))
            return esc

        return re.sub(r"\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", repl, inner)
    return tok_val


def extract_imports_and_exports(tokens):
    """Extract static import statements and exported symbols from a JS token list.

    Returns:
      imports: list of dicts {specifier, names: list[str], line: int}
      exports: set[str]
      reexports: list of dicts {specifier, star: bool, names: list[tuple[str, str]], line: int}
    """
    imports = []
    exports = set()
    reexports = []

    depth = 0  # Combined {}, (), [] nesting depth (excluding template '${}')
    tpl_depth = 0
    i = 0
    n = len(tokens)

    def update_depth(tok):
        nonlocal depth, tpl_depth
        if tok.kind == "PUNCT":
            if tok.value == "${":
                tpl_depth += 1
                depth += 1
            elif tok.value in "{([":
                depth += 1
            elif tok.value in "})]":
                depth = max(0, depth - 1)
                if tok.value == "}" and tpl_depth > 0:
                    pass

    def skip_balanced_from(idx):
        """Given idx pointing at '{', '(', or '[', return index just after its match."""
        d = 0
        while idx < n:
            v = tokens[idx].value if tokens[idx].kind == "PUNCT" else None
            if v in ("{", "(", "[", "${"):
                d += 1
            elif v in ("}", ")", "]"):
                d -= 1
                if d <= 0:
                    return idx + 1
            idx += 1
        return idx

    def parse_braced_specifiers(idx):
        """Parse `{ a, b as c }` starting at `{`. Returns (pairs[(orig, local)], next_idx)."""
        pairs = []
        idx += 1  # skip '{'
        while idx < n and not (tokens[idx].kind == "PUNCT" and tokens[idx].value == "}"):
            if tokens[idx].kind == "PUNCT" and tokens[idx].value == ",":
                idx += 1
                continue
            if tokens[idx].kind == "IDENT":
                orig = tokens[idx].value
                idx += 1
                alias = orig
                if (
                    idx + 1 < n
                    and tokens[idx].kind == "IDENT"
                    and tokens[idx].value == "as"
                    and tokens[idx + 1].kind == "IDENT"
                ):
                    alias = tokens[idx + 1].value
                    idx += 2
                pairs.append((orig, alias))
            else:
                idx += 1
        if idx < n and tokens[idx].kind == "PUNCT" and tokens[idx].value == "}":
            idx += 1
        return pairs, idx

    def extract_pattern_names(idx):
        """Extract bound identifier names from a var/const/let declarator pattern."""
        names = []
        if idx >= n:
            return names, idx
        tok = tokens[idx]
        if tok.kind == "IDENT":
            return [tok.value], idx + 1
        if tok.kind == "PUNCT" and tok.value in ("{", "["):
            end_idx = skip_balanced_from(idx)
            # Scan inside destructuring pattern at relative pattern depth
            j = idx + 1
            while j < end_idx - 1:
                t = tokens[j]
                if t.kind == "PUNCT" and t.value == "=":
                    # Skip default value expression until ',' or end at current pattern depth
                    pdepth = 0
                    j += 1
                    while j < end_idx - 1:
                        pv = tokens[j].value if tokens[j].kind == "PUNCT" else None
                        if pv in ("{", "(", "[", "${"):
                            pdepth += 1
                        elif pv in ("}", ")", "]"):
                            pdepth -= 1
                        elif pv == "," and pdepth == 0:
                            break
                        j += 1
                    continue
                if t.kind == "IDENT":
                    # In `{ a: b }`, `b` is bound; in `{ a }`, `a` is bound.
                    if j + 1 < end_idx - 1 and tokens[j + 1].kind == "PUNCT" and tokens[j + 1].value == ":":
                        j += 2
                        continue
                    if t.value not in ("true", "false", "null", "undefined"):
                        names.append(t.value)
                j += 1
            return names, end_idx
        return names, idx + 1

    while i < n:
        tok = tokens[i]
        prev_tok = tokens[i - 1] if i > 0 else None
        is_member_access = bool(prev_tok and prev_tok.kind == "PUNCT" and prev_tok.value in (".", "?."))

        if depth == 0 and not is_member_access and tok.kind == "IDENT" and tok.value == "import":
            # Ignore dynamic import(...) or import.meta
            if i + 1 < n and tokens[i + 1].kind == "PUNCT" and tokens[i + 1].value in ("(", "."):
                i += 1
                continue

            stmt_line = tok.line
            j = i + 1
            imported_names = []
            specifier = None

            if j < n and tokens[j].kind == "STRING":
                specifier = unquote_string(tokens[j].value)
                j += 1
            else:
                # Parse import clause until `from <STRING>`
                while j < n:
                    tj = tokens[j]
                    if tj.kind == "IDENT" and tj.value == "from" and j + 1 < n and tokens[j + 1].kind == "STRING":
                        specifier = unquote_string(tokens[j + 1].value)
                        j += 2
                        break
                    if tj.kind == "PUNCT" and tj.value == "{":
                        pairs, j = parse_braced_specifiers(j)
                        for orig, _alias in pairs:
                            imported_names.append(orig)
                        continue
                    if tj.kind == "PUNCT" and tj.value == "*":
                        # `* as ns`
                        if j + 2 < n and tokens[j + 1].kind == "IDENT" and tokens[j + 1].value == "as":
                            j += 3
                        else:
                            j += 1
                        continue
                    if tj.kind == "IDENT":
                        imported_names.append("default")
                        j += 1
                        continue
                    if tj.kind == "PUNCT" and tj.value == ",":
                        j += 1
                        continue
                    if tj.kind == "PUNCT" and tj.value == ";":
                        j += 1
                        break
                    j += 1

            if specifier is not None:
                imports.append({"specifier": specifier, "names": imported_names, "line": stmt_line})
            i = j
            continue

        if depth == 0 and not is_member_access and tok.kind == "IDENT" and tok.value == "export":
            stmt_line = tok.line
            j = i + 1
            if j < n and tokens[j].kind == "IDENT" and tokens[j].value == "default":
                exports.add("default")
                i = j + 1
                continue

            if j < n and tokens[j].kind == "IDENT" and tokens[j].value == "async":
                if j + 1 < n and tokens[j + 1].kind == "IDENT" and tokens[j + 1].value == "function":
                    j += 1

            if j < n and tokens[j].kind == "IDENT" and tokens[j].value == "function":
                j += 1
                if j < n and tokens[j].kind == "PUNCT" and tokens[j].value == "*":
                    j += 1
                if j < n and tokens[j].kind == "IDENT":
                    exports.add(tokens[j].value)
                    i = j + 1
                    continue

            if j < n and tokens[j].kind == "IDENT" and tokens[j].value == "class":
                j += 1
                if j < n and tokens[j].kind == "IDENT":
                    exports.add(tokens[j].value)
                    i = j + 1
                    continue

            if j < n and tokens[j].kind == "IDENT" and tokens[j].value in ("const", "let", "var"):
                j += 1
                while j < n:
                    names, j = extract_pattern_names(j)
                    exports.update(names)
                    # Skip initializer if '='
                    if j < n and tokens[j].kind == "PUNCT" and tokens[j].value == "=":
                        j += 1
                        init_depth = 0
                        while j < n:
                            tv = tokens[j].value if tokens[j].kind == "PUNCT" else None
                            if tv in ("{", "(", "[", "${"):
                                init_depth += 1
                            elif tv in ("}", ")", "]"):
                                init_depth -= 1
                            elif init_depth == 0 and tv in (",", ";"):
                                break
                            elif (
                                init_depth == 0
                                and j + 1 < n
                                and tokens[j].line != tokens[j - 1].line
                                and tokens[j].kind == "IDENT"
                                and tokens[j].value in ("export", "import", "function", "class", "const", "let", "var")
                            ):
                                break
                            j += 1
                    if j < n and tokens[j].kind == "PUNCT" and tokens[j].value == ",":
                        j += 1
                        continue
                    break
                i = j
                continue

            if j < n and tokens[j].kind == "PUNCT" and tokens[j].value == "{":
                pairs, j = parse_braced_specifiers(j)
                if j < n and tokens[j].kind == "IDENT" and tokens[j].value == "from" and j + 1 < n and tokens[j + 1].kind == "STRING":
                    specifier = unquote_string(tokens[j + 1].value)
                    reexports.append({"specifier": specifier, "star": False, "names": pairs, "line": stmt_line})
                    for _orig, exported_name in pairs:
                        exports.add(exported_name)
                    i = j + 2
                else:
                    for _local_name, exported_name in pairs:
                        exports.add(exported_name)
                    i = j
                continue

            if j < n and tokens[j].kind == "PUNCT" and tokens[j].value == "*":
                j += 1
                if j + 2 < n and tokens[j].kind == "IDENT" and tokens[j].value == "as" and tokens[j + 1].kind == "IDENT":
                    exported_ns = tokens[j + 1].value
                    j += 2
                    if j < n and tokens[j].kind == "IDENT" and tokens[j].value == "from" and j + 1 < n and tokens[j + 1].kind == "STRING":
                        specifier = unquote_string(tokens[j + 1].value)
                        exports.add(exported_ns)
                        reexports.append({"specifier": specifier, "star": False, "names": [], "line": stmt_line})
                        i = j + 2
                        continue
                elif j < n and tokens[j].kind == "IDENT" and tokens[j].value == "from" and j + 1 < n and tokens[j + 1].kind == "STRING":
                    specifier = unquote_string(tokens[j + 1].value)
                    reexports.append({"specifier": specifier, "star": True, "names": [], "line": stmt_line})
                    i = j + 2
                    continue

        update_depth(tok)
        i += 1

    return imports, exports, reexports


def resolve_disk_path_case_sensitive(from_file: Path, specifier: str):
    """Resolve a relative or root-relative module specifier to a real Path, verifying exact filename case."""
    if specifier.startswith(("http://", "https://", "data:")):
        return None, "external"
    if specifier.startswith("/"):
        candidate = ROOT_DIR / specifier.lstrip("/")
    elif specifier.startswith(("./", "../")):
        candidate = (from_file.parent / specifier).resolve()
    else:
        return None, f"bare specifier '{specifier}' (browser native ESM requires './', '../', or '/')"

    try:
        rel = candidate.relative_to(ROOT_DIR)
    except ValueError:
        return None, f"escapes project root: {specifier}"

    # Verify each path component exists with exact casing (catches Windows/Linux case mismatches)
    cur = ROOT_DIR
    for part in rel.parts:
        if not cur.is_dir():
            return None, f"missing directory '{cur.relative_to(ROOT_DIR)}' for '{specifier}'"
        entries = os.listdir(cur)
        if part not in entries:
            ci_match = [e for e in entries if e.lower() == part.lower()]
            if ci_match:
                return None, f"case mismatch for '{specifier}': expected '{ci_match[0]}', got '{part}'"
            return None, f"target file not found on disk: '{rel.as_posix()}'"
        cur = cur / part

    if not cur.is_file():
        return None, f"target is not a file: '{rel.as_posix()}'"
    return cur, None


class IndexHtmlParser(HTMLParser):
    """Parse index.html for stylesheets, module scripts, IDs, and tag balance."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stylesheets = []
        self.module_scripts = []
        self.ids = set()
        self.tag_stack = []
        self.tag_errors = []

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        attr_map = {k.lower(): v for k, v in attrs}
        if "id" in attr_map and attr_map["id"]:
            self.ids.add(attr_map["id"])

        if t == "link":
            rel = (attr_map.get("rel") or "").lower().split()
            href = attr_map.get("href") or ""
            if "stylesheet" in rel and href:
                self.stylesheets.append(href)
        elif t == "script":
            stype = (attr_map.get("type") or "").lower()
            src = attr_map.get("src") or ""
            if stype == "module" and src:
                self.module_scripts.append(src)

        if t not in VOID_HTML_TAGS:
            self.tag_stack.append((t, self.getpos()))

    def handle_startendtag(self, tag, attrs):
        attr_map = {k.lower(): v for k, v in attrs}
        if "id" in attr_map and attr_map["id"]:
            self.ids.add(attr_map["id"])
        t = tag.lower()
        if t == "link":
            rel = (attr_map.get("rel") or "").lower().split()
            href = attr_map.get("href") or ""
            if "stylesheet" in rel and href:
                self.stylesheets.append(href)

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in VOID_HTML_TAGS:
            return
        if not self.tag_stack:
            self.tag_errors.append(f"Line {self.getpos()[0]}: Unexpected closing tag </{t}>")
            return
        open_tag, open_pos = self.tag_stack[-1]
        if open_tag != t:
            self.tag_errors.append(
                f"Line {self.getpos()[0]}: Mismatched </{t}>, expected </{open_tag}> (opened at line {open_pos[0]})"
            )
            # Pop until matching tag if present to continue finding errors
            for idx in range(len(self.tag_stack) - 1, -1, -1):
                if self.tag_stack[idx][0] == t:
                    del self.tag_stack[idx:]
                    return
            return
        self.tag_stack.pop()


class _CapturableBytesIO(io.BytesIO):
    """BytesIO that retains its captured bytes after StreamRequestHandler.finish() closes wfile."""

    def __init__(self):
        super().__init__()
        self.captured = b""

    def close(self):
        if not self.closed:
            self.captured = self.getvalue()
        super().close()


class _RequestStubSocket:
    """In-memory socket stub providing makefile() and sendall() for NoCacheStaticHandler."""

    def __init__(self, raw_request):
        self._rfile = io.BytesIO(raw_request)
        self._wfile = _CapturableBytesIO()

    def makefile(self, mode, buffering=None):
        if "r" in mode:
            return self._rfile
        return self._wfile

    def sendall(self, data):
        self._wfile.write(data)

    def setsockopt(self, *args, **kwargs):
        pass

    def close(self):
        pass

    def get_response_bytes(self):
        return self._wfile.captured if self._wfile.closed else self._wfile.getvalue()


class _ResponseStubSocket:
    def __init__(self, raw_response):
        self._bio = io.BytesIO(raw_response)

    def makefile(self, mode, buffering=None):
        return self._bio


def _is_sandbox_loopback_block(exc):
    if isinstance(exc, urllib.error.HTTPError):
        return False
    if isinstance(exc, ConnectionAbortedError):
        return True
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (ConnectionAbortedError, OSError)):
            winerr = getattr(reason, "winerror", None)
            if winerr == 10053 or isinstance(reason, ConnectionAbortedError):
                return True
        msg = str(exc)
        if "10053" in msg or "aborted" in msg.lower():
            return True
    return False


def verify_http_server():
    """Part (a): Verify serve.create_server('127.0.0.1', 0) & crawl HTTP resources."""
    sys.path.insert(0, str(ROOT_DIR))
    import serve

    server = serve.create_server(host="127.0.0.1", port=0, directory=str(ROOT_DIR))
    host, port = server.server_address
    if host != "127.0.0.1" or not isinstance(port, int) or port <= 0:
        server.server_close()
        return [], "failed", [f"create_server('127.0.0.1', 0) returned invalid address: {server.server_address!r}"]

    base_url = f"http://127.0.0.1:{port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    class SilentNoCacheHandler(serve.NoCacheStaticHandler):
        def log_message(self, format, *args):
            pass

    def dispatch_in_process(url_path):
        raw_req = (
            f"GET {url_path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("ascii")
        req_sock = _RequestStubSocket(raw_req)
        SilentNoCacheHandler(req_sock, ("127.0.0.1", 0), server, directory=str(ROOT_DIR))
        raw_resp = req_sock.get_response_bytes()
        resp = http.client.HTTPResponse(_ResponseStubSocket(raw_resp))
        resp.begin()
        try:
            return (
                resp.status,
                resp.headers.get("Content-Type", ""),
                resp.headers.get("Cache-Control", ""),
                resp.read(),
            )
        finally:
            resp.close()

    transport_mode = f"live loopback TCP (127.0.0.1:{port})"

    def fetch(url_path):
        nonlocal transport_mode
        if "in-process" in transport_mode:
            return dispatch_in_process(url_path)
        req = urllib.request.Request(base_url + url_path, method="GET")
        try:
            with opener.open(req, timeout=10) as resp:
                return (
                    resp.status,
                    resp.headers.get("Content-Type", ""),
                    resp.headers.get("Cache-Control", ""),
                    resp.read(),
                )
        except Exception as exc:
            if _is_sandbox_loopback_block(exc):
                transport_mode = (
                    f"serve.create_server bound on 127.0.0.1:{port}; "
                    f"sandbox blocked loopback TCP (WinError 10053) -> in-process NoCacheStaticHandler dispatch"
                )
                return dispatch_in_process(url_path)
            raise

    fetched_urls = []
    errors = []

    def check_headers_and_record(url_path, st, ct, cc, body, expected_ct_prefix):
        if st != 200 or not body:
            errors.append(f"HTTP {url_path} returned status={st}, len={len(body)}")
            return False
        if not ct.lower().startswith(expected_ct_prefix):
            errors.append(f"HTTP {url_path} invalid Content-Type: {ct!r} (expected {expected_ct_prefix!r})")
            return False
        if "no-cache" not in cc.lower():
            errors.append(f"HTTP {url_path} missing no-cache Cache-Control header: {cc!r}")
            return False
        fetched_urls.append((url_path, st, ct, len(body)))
        return True

    try:
        # 1. Fetch /index.html
        try:
            st, ct, cc, body = fetch("/index.html")
            if not check_headers_and_record("/index.html", st, ct, cc, body, "text/html"):
                return fetched_urls, transport_mode, errors
            html_text = body.decode("utf-8")
        except Exception as exc:
            errors.append(f"Failed to fetch /index.html: {exc}")
            return fetched_urls, transport_mode, errors

        parser = IndexHtmlParser()
        parser.feed(html_text)
        parser.close()

        # 2. Fetch /src/constants.js
        try:
            st, ct, cc, body = fetch("/src/constants.js")
            check_headers_and_record("/src/constants.js", st, ct, cc, body, "application/javascript")
        except Exception as exc:
            errors.append(f"Failed to fetch /src/constants.js: {exc}")

        # 3. Fetch every <link rel="stylesheet"> from index.html
        for href in parser.stylesheets:
            if href.startswith(("http://", "https://")):
                continue
            url_path = urllib.parse.urlsplit(urllib.parse.urljoin("/", href)).path
            try:
                st, ct, cc, body = fetch(url_path)
                check_headers_and_record(url_path, st, ct, cc, body, "text/css")
            except Exception as exc:
                errors.append(f"Failed to fetch stylesheet {url_path}: {exc}")

        # 4. Recursively fetch transitive relative JS imports starting from /src/main.js
        visited_js = set()
        queue = ["/src/main.js"]
        for msrc in parser.module_scripts:
            if not msrc.startswith(("http://", "https://")):
                norm = urllib.parse.urlsplit(urllib.parse.urljoin("/", msrc)).path
                if norm not in queue:
                    queue.append(norm)

        while queue:
            url_path = queue.pop(0)
            if url_path in visited_js:
                continue
            visited_js.add(url_path)

            try:
                st, ct, cc, body = fetch(url_path)
            except Exception as exc:
                errors.append(f"HTTP GET {url_path} failed: {exc}")
                continue

            if not check_headers_and_record(url_path, st, ct, cc, body, "application/javascript"):
                continue

            try:
                js_text = body.decode("utf-8")
                toks = tokenize_js(js_text, filename=url_path)
                imports, _, reexports = extract_imports_and_exports(toks)
            except SyntaxError as exc:
                errors.append(f"JS tokenize error while crawling {url_path}: {exc}")
                continue

            cur_dir = posixpath.dirname(url_path)
            for item in imports + reexports:
                spec = item["specifier"]
                if spec.startswith(("http://", "https://")):
                    continue
                if spec.startswith("/"):
                    next_path = posixpath.normpath(spec)
                elif spec.startswith(("./", "../")):
                    next_path = posixpath.normpath(posixpath.join(cur_dir, spec))
                else:
                    errors.append(f"{url_path}:{item['line']}: Bare import specifier {spec!r}")
                    continue
                if not next_path.startswith("/"):
                    next_path = "/" + next_path
                if next_path not in visited_js:
                    queue.append(next_path)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    return fetched_urls, transport_mode, errors


def verify_static_modules():
    """Part (b) + JS syntax/balance: Inspect all src/**/*.js."""
    js_files = []
    src_dir = ROOT_DIR / "src"
    if src_dir.is_dir():
        js_files.extend(sorted(src_dir.rglob("*.js")))

    parsed = {}  # Path -> {imports, exports, reexports, tokens}
    errors = []

    for path in js_files:
        rel = path.relative_to(ROOT_DIR).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            errors.append(f"Failed to read {rel}: {exc}")
            continue

        try:
            toks = tokenize_js(text, filename=rel)
        except SyntaxError as exc:
            errors.append(f"JS syntax/balance error in {exc}")
            continue

        imports, exports, reexports = extract_imports_and_exports(toks)
        parsed[path.resolve()] = {
            "rel": rel,
            "imports": imports,
            "exports": exports,
            "reexports": reexports,
            "tokens": toks,
        }

    # Resolve export * from '...' transitively (bounded fixed-point)
    for _ in range(len(parsed) + 1):
        changed = False
        for p, info in parsed.items():
            for rx in info["reexports"]:
                if not rx["star"]:
                    continue
                target, err = resolve_disk_path_case_sensitive(p, rx["specifier"])
                if target and target.resolve() in parsed:
                    target_exports = parsed[target.resolve()]["exports"]
                    for sym in target_exports:
                        if sym != "default" and sym not in info["exports"]:
                            info["exports"].add(sym)
                            changed = True
        if not changed:
            break

    # Verify every import & reexport resolves on disk and target exports each symbol
    checked_edges = 0
    for p, info in parsed.items():
        rel = info["rel"]
        for imp in info["imports"]:
            spec = imp["specifier"]
            target, err = resolve_disk_path_case_sensitive(p, spec)
            if err == "external":
                continue
            if err:
                errors.append(f"{rel}:{imp['line']}: {err}")
                continue
            target_res = target.resolve()
            if target_res not in parsed:
                errors.append(f"{rel}:{imp['line']}: Imported module {spec!r} not in parsed module set")
                continue
            checked_edges += 1
            target_exports = parsed[target_res]["exports"]
            for sym in imp["names"]:
                if sym not in target_exports:
                    errors.append(
                        f"{rel}:{imp['line']}: Symbol {sym!r} imported from {spec!r} "
                        f"is NOT exported by {parsed[target_res]['rel']} (exports: {sorted(target_exports)})"
                    )

        for rx in info["reexports"]:
            spec = rx["specifier"]
            target, err = resolve_disk_path_case_sensitive(p, spec)
            if err == "external":
                continue
            if err:
                errors.append(f"{rel}:{rx['line']}: {err}")
                continue
            target_res = target.resolve()
            if target_res not in parsed:
                errors.append(f"{rel}:{rx['line']}: Re-exported module {spec!r} not in parsed module set")
                continue
            checked_edges += 1
            target_exports = parsed[target_res]["exports"]
            for orig, _alias in rx["names"]:
                if orig not in target_exports:
                    errors.append(
                        f"{rel}:{rx['line']}: Re-exported symbol {orig!r} from {spec!r} "
                        f"is NOT exported by {parsed[target_res]['rel']}"
                    )

    return parsed, checked_edges, errors


def verify_html_css_and_dom_ids(parsed_js):
    """Part (c): Verify index.html tag balance, CSS balance, and main.js #id DOM queries."""
    errors = []
    index_path = ROOT_DIR / "index.html"
    if not index_path.is_file():
        errors.append("index.html is missing")
        return set(), [], [], errors

    html_text = index_path.read_text(encoding="utf-8")
    if not html_text.strip():
        errors.append("index.html is empty")
        return set(), [], [], errors

    parser = IndexHtmlParser()
    parser.feed(html_text)
    parser.close()

    errors.extend(f"index.html: {e}" for e in parser.tag_errors)
    for open_tag, pos in parser.tag_stack:
        errors.append(f"index.html: Unclosed <{open_tag}> opened at line {pos[0]}")

    # Check linked stylesheets & module scripts exist on disk
    for href in parser.stylesheets:
        if href.startswith(("http://", "https://")):
            continue
        target, err = resolve_disk_path_case_sensitive(index_path, href if href.startswith(("./", "../", "/")) else "./" + href)
        if err:
            errors.append(f"index.html stylesheet {href!r}: {err}")

    for msrc in parser.module_scripts:
        if msrc.startswith(("http://", "https://")):
            continue
        target, err = resolve_disk_path_case_sensitive(index_path, msrc if msrc.startswith(("./", "../", "/")) else "./" + msrc)
        if err:
            errors.append(f"index.html module script {msrc!r}: {err}")

    # Verify CSS files balance
    css_files = sorted((ROOT_DIR / "styles").rglob("*.css")) if (ROOT_DIR / "styles").is_dir() else []
    if not css_files:
        errors.append("No CSS files found in styles/")
    for css_path in css_files:
        rel = css_path.relative_to(ROOT_DIR).as_posix()
        try:
            css_text = css_path.read_text(encoding="utf-8")
            if not css_text.strip():
                errors.append(f"{rel} is empty")
            else:
                check_css_balance(css_text, filename=rel)
        except SyntaxError as exc:
            errors.append(f"CSS syntax/balance error in {exc}")

    # Verify every #id queried via getElementById('...') or querySelector('#...') in src/main.js
    main_path = (ROOT_DIR / "src" / "main.js").resolve()
    queried_ids = []
    if main_path not in parsed_js:
        errors.append("src/main.js is missing or failed JS parsing")
    else:
        toks = parsed_js[main_path]["tokens"]
        for i in range(len(toks) - 3):
            if (
                toks[i].kind == "IDENT"
                and toks[i].value in ("getElementById", "querySelector", "querySelectorAll")
                and toks[i + 1].kind == "PUNCT"
                and toks[i + 1].value == "("
                and toks[i + 2].kind == "STRING"
                and toks[i + 3].kind == "PUNCT"
                and toks[i + 3].value == ")"
            ):
                arg = unquote_string(toks[i + 2].value).strip()
                if toks[i].value == "getElementById":
                    queried_ids.append((arg, toks[i].line, "getElementById"))
                    if arg not in parser.ids:
                        errors.append(
                            f"src/main.js:{toks[i].line}: getElementById({arg!r}) not found in index.html"
                        )
                else:
                    if arg.startswith("#"):
                        # Extract leading #id (ignoring trailing combinators if any)
                        m = re.match(r"^#([A-Za-z_][A-Za-z0-9_-]*)$", arg)
                        if m:
                            qid = m.group(1)
                            queried_ids.append((qid, toks[i].line, toks[i].value))
                            if qid not in parser.ids:
                                errors.append(
                                    f"src/main.js:{toks[i].line}: {toks[i].value}({arg!r}) not found in index.html"
                                )

    return parser.ids, queried_ids, css_files, errors


def verify_docs():
    """Part (d): Verify ARCHITECTURE.md and README.md exist and are non-empty."""
    errors = []
    docs_info = {}
    for name in ("ARCHITECTURE.md", "README.md"):
        p = ROOT_DIR / name
        if not p.is_file():
            errors.append(f"Missing documentation file: {name}")
            continue
        text = p.read_text(encoding="utf-8")
        if not text.strip():
            errors.append(f"Documentation file is empty: {name}")
            continue
        docs_info[name] = len(text)
    return docs_info, errors


def verify_start_bat():
    """Part (e): Verify start.bat is 100% pure ASCII and strictly CRLF."""
    errors = []
    bat_path = ROOT_DIR / "start.bat"
    if not bat_path.is_file():
        return {"bytes": 0, "crlf_lines": 0}, ["Missing start.bat"]

    data = bat_path.read_bytes()
    if not data.strip():
        errors.append("start.bat is empty")

    non_ascii = [(idx, b) for idx, b in enumerate(data) if b >= 128]
    if non_ascii:
        errors.append(f"start.bat contains {len(non_ascii)} non-ASCII byte(s) (first at offset {non_ascii[0][0]}: 0x{non_ascii[0][1]:02x})")

    lf_count = data.count(b"\n")
    crlf_count = data.count(b"\r\n")
    if lf_count == 0 or lf_count != crlf_count:
        errors.append(f"start.bat line endings are not strictly CRLF (LF={lf_count}, CRLF={crlf_count})")

    return {"bytes": len(data), "crlf_lines": crlf_count}, errors


def verify_api_meta():
    """Part (f): Test in-process GET/POST /api/meta on serve.NoCacheStaticHandler and clean up."""
    sys.path.insert(0, str(ROOT_DIR))
    import serve

    class SilentNoCacheHandler(serve.NoCacheStaticHandler):
        def log_message(self, format, *args):
            pass

    server = serve.create_server(host="127.0.0.1", port=0, directory=str(ROOT_DIR))
    test_folder = f"__verify_tmp_meta_{os.getpid()}__"
    meta_dir = ROOT_DIR / ".local-meta"
    meta_dir_existed = meta_dir.exists()
    meta_file = meta_dir / f"{test_folder}.json"
    errors = []
    checks_run = 0

    def dispatch(method, url_path, body_obj=None):
        body_bytes = b""
        headers = f"Host: 127.0.0.1\r\nConnection: close\r\n"
        if body_obj is not None:
            body_bytes = json.dumps(body_obj, ensure_ascii=False).encode("utf-8")
            headers += f"Content-Type: application/json; charset=utf-8\r\nContent-Length: {len(body_bytes)}\r\n"
        raw_req = f"{method} {url_path} HTTP/1.1\r\n{headers}\r\n".encode("ascii") + body_bytes
        req_sock = _RequestStubSocket(raw_req)
        SilentNoCacheHandler(req_sock, ("127.0.0.1", 0), server, directory=str(ROOT_DIR))
        raw_resp = req_sock.get_response_bytes()
        resp = http.client.HTTPResponse(_ResponseStubSocket(raw_resp))
        resp.begin()
        try:
            return (
                resp.status,
                resp.headers.get("Content-Type", ""),
                resp.headers.get("Cache-Control", ""),
                resp.read(),
            )
        finally:
            resp.close()

    try:
        # 1. GET non-existent folder -> default empty schema + membersData
        checks_run += 1
        st, ct, cc, raw = dispatch("GET", f"/api/meta?folder={test_folder}")
        data = json.loads(raw.decode("utf-8"))
        if st != 200 or not ct.lower().startswith("application/json") or "no-cache" not in cc.lower():
            errors.append(f"GET initial /api/meta invalid status/headers: {st}, {ct!r}, {cc!r}")
        elif not data.get("ok") or data.get("tagSchema") != {"version": 1, "tags": {}} or data.get("membersData") != {}:
            errors.append(f"GET initial /api/meta unexpected payload: {data!r}")

        # 2. POST member 1 + tag-a (updatedAt=1000)
        checks_run += 1
        post1 = {
            "folderId": test_folder,
            "memberId": "nick_alice",
            "memberRecord": {
                "version": 1,
                "member": {"id": "nick_alice", "name": "Alice", "color": "#38bdf8"},
                "items": {"photo1": {"rating": 5, "favorite": True, "note": "great", "tags": {}, "updatedAt": 1000}},
            },
            "tagSchema": {
                "version": 1,
                "tags": {
                    "tag-a": {"id": "tag-a", "name": "Featured", "color": "emerald", "deleted": False, "updatedAt": 1000},
                },
            },
        }
        st, ct, _, raw = dispatch("POST", "/api/meta", post1)
        data = json.loads(raw.decode("utf-8"))
        if st != 200 or not data.get("ok"):
            errors.append(f"POST #1 /api/meta failed: status={st}, body={data!r}")
        elif not meta_file.is_file():
            errors.append(f"POST #1 did not create {meta_file}")

        # 3. POST member 2 + stale tag-a (updatedAt=500) + deleted tombstone tag-b (updatedAt=2000)
        checks_run += 1
        post2 = {
            "folderId": test_folder,
            "memberId": "nick_bob",
            "memberRecord": {
                "version": 1,
                "member": {"id": "nick_bob", "name": "Bob", "color": "#f472b6"},
                "items": {"photo1": {"rating": 4, "favorite": False, "note": "nice", "tags": {}, "updatedAt": 2000}},
            },
            "tagSchema": {
                "version": 1,
                "tags": {
                    "tag-a": {"id": "tag-a", "name": "OldName", "color": "red", "deleted": False, "updatedAt": 500},
                    "tag-b": {"id": "tag-b", "name": "Deprecated", "color": "slate", "deleted": True, "updatedAt": 2000},
                },
            },
        }
        st, _, _, raw = dispatch("POST", "/api/meta", post2)
        data = json.loads(raw.decode("utf-8"))
        tags_out = (data.get("tagSchema") or {}).get("tags") or {}
        members_out = data.get("membersData") or {}
        if st != 200 or not data.get("ok"):
            errors.append(f"POST #2 /api/meta failed: status={st}, body={data!r}")
        elif tags_out.get("tag-a", {}).get("name") != "Featured" or tags_out.get("tag-a", {}).get("updatedAt") != 1000:
            errors.append(f"POST #2 LWW merge failed for tag-a: {tags_out.get('tag-a')!r}")
        elif tags_out.get("tag-b", {}).get("deleted") is not True or tags_out.get("tag-b", {}).get("updatedAt") != 2000:
            errors.append(f"POST #2 tombstone preservation failed for tag-b: {tags_out.get('tag-b')!r}")
        elif set(members_out.keys()) != {"nick_alice", "nick_bob"}:
            errors.append(f"POST #2 membersData mismatch: {sorted(members_out.keys())}")

        # 4. GET persisted folder -> matches merged tagSchema & both members
        checks_run += 1
        st, ct, _, raw = dispatch("GET", f"/api/meta?folder={test_folder}")
        data = json.loads(raw.decode("utf-8"))
        if st != 200 or not data.get("ok"):
            errors.append(f"GET persisted /api/meta failed: status={st}, body={data!r}")
        elif (
            data.get("tagSchema", {}).get("tags", {}).get("tag-a", {}).get("name") != "Featured"
            or data.get("tagSchema", {}).get("tags", {}).get("tag-b", {}).get("deleted") is not True
            or set((data.get("membersData") or {}).keys()) != {"nick_alice", "nick_bob"}
        ):
            errors.append(f"GET persisted /api/meta mismatch: {data!r}")

        # 5. Invalid POST payload (missing folderId) -> 400 JSON
        checks_run += 1
        st, ct, _, raw = dispatch("POST", "/api/meta", {"memberId": "x"})
        data = json.loads(raw.decode("utf-8"))
        if st != 400 or data.get("ok") is not False or not ct.lower().startswith("application/json"):
            errors.append(f"POST invalid payload expected 400 ok=False, got status={st}, ct={ct!r}, body={data!r}")
    except Exception as exc:
        errors.append(f"/api/meta in-process verification exception: {exc}")
    finally:
        server.server_close()
        if meta_file.exists():
            meta_file.unlink()
        if not meta_dir_existed and meta_dir.is_dir():
            try:
                if not any(meta_dir.iterdir()):
                    meta_dir.rmdir()
            except OSError:
                pass

    return {"checks": checks_run, "cleaned_up": not meta_file.exists()}, errors


def verify_no_credentials_or_secrets():
    """Part (g): Ensure zero credential config files or sensitive strings exist in project files."""
    errors = []
    forbidden_file_patterns = [
        r"^config\.js$",
        r"^config\..*\.js$",
        r"^config.*\.json$",
        r"^\.env(\..+)?$",
        r"credentials",
        r"client_secret",
        r"secret",
        r"\.pem$",
        r"\.key$",
        r"\.p12$",
        r"\.pfx$",
    ]
    secret_patterns = [
        ("OAuth Client ID", re.compile(r"\d{10,}-[a-z0-9]{15,}\.apps\.googleusercontent\.com", re.IGNORECASE)),
        ("Google API Key", re.compile(r"AIza[0-9A-Za-z_-]{20,}")),
        ("Google OAuth Secret", re.compile(r"GOCSPX-[0-9A-Za-z_-]+")),
        ("GCP generated project ID", re.compile(r"gen-lang-client-\d+")),
        ("Personal email address", re.compile(r"[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|qq|163|126)\.com", re.IGNORECASE)),
        ("Local Windows user path", re.compile(r"[A-Za-z]:\\Users\\[A-Za-z0-9._-]+")),
        ("Local POSIX user path", re.compile(r"/(Users|home)/[A-Za-z0-9._-]+")),
        ("Private key header", re.compile(r"BEGIN [A-Z ]*PRIVATE KEY")),
        ("GitHub token", re.compile(r"(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}")),
    ]

    scanned_files = 0
    for path in sorted(ROOT_DIR.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT_DIR).as_posix()
        parts = path.relative_to(ROOT_DIR).parts
        if any(p in (".git", "__pycache__", ".local-meta") for p in parts):
            continue
        for pat in forbidden_file_patterns:
            if re.search(pat, path.name, re.IGNORECASE):
                errors.append(f"Forbidden credential/config file present: {rel}")
        scanned_files += 1
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for label, rx in secret_patterns:
            m = rx.search(text)
            if m:
                errors.append(f"Sensitive match ({label}) in {rel}: {m.group(0)!r}")

    return {"scanned_files": scanned_files}, errors


def _parse_i18n_messages(tokens):
    """Extract MESSAGES.en and MESSAGES.zh key->(value, line) dicts from src/i18n.js tokens."""
    n = len(tokens)
    dicts = {}
    duplicates = []

    def tok_key(tok):
        if tok.kind == "STRING":
            return unquote_string(tok.value)
        if tok.kind == "IDENT":
            return tok.value
        return None

    # Locate `MESSAGES = {`
    msg_brace_idx = None
    for i in range(n - 2):
        if (
            tokens[i].kind == "IDENT"
            and tokens[i].value == "MESSAGES"
            and tokens[i + 1].kind == "PUNCT"
            and tokens[i + 1].value == "="
            and tokens[i + 2].kind == "PUNCT"
            and tokens[i + 2].value == "{"
        ):
            msg_brace_idx = i + 2
            break

    if msg_brace_idx is None:
        return None, ["Could not locate `MESSAGES = { ... }` in src/i18n.js"]

    idx = msg_brace_idx + 1
    while idx < n and not (tokens[idx].kind == "PUNCT" and tokens[idx].value == "}"):
        if tokens[idx].kind == "PUNCT" and tokens[idx].value == ",":
            idx += 1
            continue
        lang = tok_key(tokens[idx])
        if (
            lang
            and idx + 2 < n
            and tokens[idx + 1].kind == "PUNCT"
            and tokens[idx + 1].value == ":"
            and tokens[idx + 2].kind == "PUNCT"
            and tokens[idx + 2].value == "{"
        ):
            idx += 3
            lang_map = {}
            while idx < n and not (tokens[idx].kind == "PUNCT" and tokens[idx].value == "}"):
                if tokens[idx].kind == "PUNCT" and tokens[idx].value == ",":
                    idx += 1
                    continue
                k = tok_key(tokens[idx])
                if k is not None and idx + 2 < n and tokens[idx + 1].kind == "PUNCT" and tokens[idx + 1].value == ":":
                    val_tok = tokens[idx + 2]
                    val = unquote_string(val_tok.value) if val_tok.kind == "STRING" else val_tok.value
                    if k in lang_map:
                        duplicates.append(f"src/i18n.js:{tokens[idx].line}: Duplicate key {k!r} in MESSAGES.{lang}")
                    lang_map[k] = (val, tokens[idx].line)
                    idx += 3
                    continue
                idx += 1
            dicts[lang] = lang_map
            if idx < n and tokens[idx].kind == "PUNCT" and tokens[idx].value == "}":
                idx += 1
            continue
        idx += 1

    return dicts, duplicates


def verify_i18n(parsed_js):
    """Part (h): Verify English default i18n, EN/ZH parity, all t() keys, and zero CJK outside src/i18n.js."""
    errors = []
    cjk_rx = re.compile(r"[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]")

    # 1. index.html <html lang="en">
    index_path = ROOT_DIR / "index.html"
    if not index_path.is_file():
        errors.append("index.html is missing")
    else:
        html_text = index_path.read_text(encoding="utf-8")
        if not re.search(r"<html\b[^>]*\blang\s*=\s*['\"]en['\"]", html_text, re.IGNORECASE):
            errors.append('index.html must declare <html lang="en">')

    # 2. Parse src/i18n.js & verify strict 'en' default (no navigator.language), zero CJK in MESSAGES.en, & EN/ZH parity
    i18n_path = (ROOT_DIR / "src" / "i18n.js").resolve()
    en_dict = {}
    zh_dict = {}
    if i18n_path not in parsed_js:
        errors.append("src/i18n.js is missing or failed JS parsing")
    else:
        i18n_text = i18n_path.read_text(encoding="utf-8")
        i18n_toks = parsed_js[i18n_path]["tokens"]

        for i in range(len(i18n_toks) - 2):
            if (
                i18n_toks[i].kind == "IDENT"
                and i18n_toks[i].value == "navigator"
                and i18n_toks[i + 1].kind == "PUNCT"
                and i18n_toks[i + 1].value in (".", "?.")
                and i18n_toks[i + 2].kind == "IDENT"
                and i18n_toks[i + 2].value == "language"
            ):
                errors.append(f"src/i18n.js:{i18n_toks[i].line}: Must not read navigator.language")

        has_get_lang = "getLang" in parsed_js[i18n_path]["exports"]
        if not has_get_lang:
            errors.append("src/i18n.js: Missing export getLang")
        elif not re.search(r"function\s+getLang\s*\([^)]*\)\s*\{[\s\S]*?['\"]en['\"]", i18n_text):
            errors.append("src/i18n.js: getLang() does not fall back to 'en'")

        dicts, parse_errs = _parse_i18n_messages(i18n_toks)
        errors.extend(parse_errs)
        if dicts is not None:
            if "en" not in dicts or "zh" not in dicts:
                errors.append(f"src/i18n.js: MESSAGES must define both 'en' and 'zh' (found {sorted(dicts.keys())})")
            else:
                en_dict = dicts["en"]
                zh_dict = dicts["zh"]
                missing_in_zh = sorted(set(en_dict) - set(zh_dict))
                missing_in_en = sorted(set(zh_dict) - set(en_dict))
                for k in missing_in_zh:
                    errors.append(f"src/i18n.js: Key {k!r} in MESSAGES.en is missing from MESSAGES.zh")
                for k in missing_in_en:
                    errors.append(f"src/i18n.js: Key {k!r} in MESSAGES.zh is missing from MESSAGES.en")
                for k, (val, lineno) in en_dict.items():
                    if cjk_rx.search(val):
                        errors.append(f"src/i18n.js:{lineno}: Unexpected CJK character in MESSAGES.en[{k!r}]")
                for k in sorted(set(en_dict) & set(zh_dict)):
                    en_params = set(re.findall(r"\{(\w+)\}", en_dict[k][0]))
                    zh_params = set(re.findall(r"\{(\w+)\}", zh_dict[k][0]))
                    if en_params != zh_params:
                        errors.append(
                            f"src/i18n.js: Placeholder mismatch for {k!r}: en={sorted(en_params)}, zh={sorted(zh_params)}"
                        )

    # 3. Scan every src/**/*.js for literal t('...') / t("...") calls and verify presence in both en & zh
    t_calls = 0
    for path_res, info in parsed_js.items():
        toks = info["tokens"]
        rel = info["rel"]
        for i in range(len(toks) - 3):
            if toks[i].kind != "IDENT" or toks[i].value != "t":
                continue
            if i > 0 and (
                (toks[i - 1].kind == "PUNCT" and toks[i - 1].value in (".", "?."))
                or (toks[i - 1].kind == "IDENT" and toks[i - 1].value == "function")
            ):
                continue
            if (
                toks[i + 1].kind == "PUNCT"
                and toks[i + 1].value == "("
                and toks[i + 2].kind == "STRING"
                and toks[i + 3].kind == "PUNCT"
                and toks[i + 3].value in (",", ")")
            ):
                key = unquote_string(toks[i + 2].value)
                t_calls += 1
                if en_dict and key not in en_dict:
                    errors.append(f"{rel}:{toks[i].line}: t({key!r}) missing from MESSAGES.en")
                if zh_dict and key not in zh_dict:
                    errors.append(f"{rel}:{toks[i].line}: t({key!r}) missing from MESSAGES.zh")

    # 4. Scan EVERY non-binary text file under ROOT_DIR except src/i18n.js for zero CJK characters
    binary_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2"}
    zero_cjk_files = 0
    for path in sorted(ROOT_DIR.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT_DIR).as_posix()
        parts = path.relative_to(ROOT_DIR).parts
        if any(p in (".git", "__pycache__", ".local-meta") for p in parts):
            continue
        if rel == "src/i18n.js":
            continue
        if path.suffix.lower() in binary_exts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        zero_cjk_files += 1
        for lineno, line in enumerate(text.splitlines(), 1):
            if cjk_rx.search(line):
                errors.append(f"{rel}:{lineno}: Unexpected CJK character outside src/i18n.js")

    return {
        "en_keys": len(en_dict),
        "zh_keys": len(zh_dict),
        "t_calls": t_calls,
        "zero_cjk_files": zero_cjk_files,
    }, errors


def verify_pwa():
    """Part (i): Verify manifest.webmanifest, PNG icons, sw.js precache assets, and serve.py PWA MIME types."""
    errors = []
    checks = 0

    # 1. Validate manifest.webmanifest & icon assets on disk
    manifest_path = ROOT_DIR / "manifest.webmanifest"
    if not manifest_path.is_file():
        errors.append("Missing manifest.webmanifest")
    else:
        checks += 1
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"Invalid JSON in manifest.webmanifest: {exc}")
            manifest = None

        if isinstance(manifest, dict):
            if manifest.get("display") != "standalone":
                errors.append(f"manifest.webmanifest display must be 'standalone', got {manifest.get('display')!r}")
            if manifest.get("start_url") != "./":
                errors.append(f"manifest.webmanifest start_url must be './', got {manifest.get('start_url')!r}")

            icons = manifest.get("icons")
            if not isinstance(icons, list) or not icons:
                errors.append("manifest.webmanifest must define a non-empty 'icons' array")
            else:
                expected_png_dims = {
                    "icons/icon-192.png": (192, 192),
                    "icons/icon-512.png": (512, 512),
                }
                seen_icon_paths = set()
                for entry in icons:
                    src = entry.get("src", "") if isinstance(entry, dict) else ""
                    target, err = resolve_disk_path_case_sensitive(manifest_path, src)
                    if err:
                        errors.append(f"manifest.webmanifest icon {src!r}: {err}")
                        continue
                    rel_icon = target.relative_to(ROOT_DIR).as_posix()
                    seen_icon_paths.add(rel_icon)
                    if target.suffix.lower() == ".png":
                        raw = target.read_bytes()
                        if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
                            errors.append(f"{rel_icon}: invalid PNG magic/IHDR header")
                        else:
                            w, h = struct.unpack(">II", raw[16:24])
                            if rel_icon in expected_png_dims and (w, h) != expected_png_dims[rel_icon]:
                                errors.append(
                                    f"{rel_icon}: expected dimensions {expected_png_dims[rel_icon]}, got {(w, h)}"
                                )
                            sizes = str(entry.get("sizes", ""))
                            if f"{w}x{h}" not in sizes.split():
                                errors.append(
                                    f"manifest.webmanifest icon {src!r} sizes={sizes!r} does not match PNG {w}x{h}"
                                )

                for req_icon in ("icons/icon-192.png", "icons/icon-512.png", "icons/icon.svg"):
                    if req_icon not in seen_icon_paths:
                        errors.append(f"manifest.webmanifest missing required icon: {req_icon}")

    # 2. Validate sw.js syntax & PRECACHE_ASSETS on disk
    sw_path = ROOT_DIR / "sw.js"
    precache_count = 0
    if not sw_path.is_file():
        errors.append("Missing sw.js")
    else:
        checks += 1
        sw_text = sw_path.read_text(encoding="utf-8")
        try:
            sw_toks = tokenize_js(sw_text, filename="sw.js")
        except SyntaxError as exc:
            errors.append(f"sw.js syntax/balance error: {exc}")
            sw_toks = []

        # Locate `PRECACHE_ASSETS = [ ... ]`
        arr_start = None
        for i in range(len(sw_toks) - 2):
            if (
                sw_toks[i].kind == "IDENT"
                and sw_toks[i].value == "PRECACHE_ASSETS"
                and sw_toks[i + 1].kind == "PUNCT"
                and sw_toks[i + 1].value == "="
                and sw_toks[i + 2].kind == "PUNCT"
                and sw_toks[i + 2].value == "["
            ):
                arr_start = i + 3
                break

        if arr_start is None:
            errors.append("sw.js missing PRECACHE_ASSETS = [...] array")
        else:
            j = arr_start
            while j < len(sw_toks) and not (sw_toks[j].kind == "PUNCT" and sw_toks[j].value == "]"):
                if sw_toks[j].kind == "STRING":
                    asset = unquote_string(sw_toks[j].value)
                    precache_count += 1
                    if asset != "./":
                        target, err = resolve_disk_path_case_sensitive(sw_path, asset)
                        if err:
                            errors.append(f"sw.js:{sw_toks[j].line}: PRECACHE_ASSETS entry {asset!r} -> {err}")
                j += 1

    # 3. Verify serve.py HTTP MIME types for /manifest.webmanifest, /sw.js, and /icons/icon-192.png
    checks += 1
    sys.path.insert(0, str(ROOT_DIR))
    import serve

    server = serve.create_server(host="127.0.0.1", port=0, directory=str(ROOT_DIR))
    host, port = server.server_address
    base_url = f"http://127.0.0.1:{port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    class SilentNoCacheHandler(serve.NoCacheStaticHandler):
        def log_message(self, format, *args):
            pass

    def dispatch_in_process(url_path):
        raw_req = (
            f"GET {url_path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("ascii")
        req_sock = _RequestStubSocket(raw_req)
        SilentNoCacheHandler(req_sock, ("127.0.0.1", 0), server, directory=str(ROOT_DIR))
        raw_resp = req_sock.get_response_bytes()
        resp = http.client.HTTPResponse(_ResponseStubSocket(raw_resp))
        resp.begin()
        try:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
        finally:
            resp.close()

    def fetch_pwa(url_path):
        req = urllib.request.Request(base_url + url_path, method="GET")
        try:
            with opener.open(req, timeout=10) as resp:
                return resp.status, resp.headers.get("Content-Type", ""), resp.read()
        except Exception as exc:
            if _is_sandbox_loopback_block(exc):
                return dispatch_in_process(url_path)
            raise

    try:
        expected_endpoints = [
            ("/manifest.webmanifest", "application/manifest+json"),
            ("/sw.js", "application/javascript"),
            ("/icons/icon-192.png", "image/png"),
            ("/icons/icon-512.png", "image/png"),
            ("/icons/icon.svg", "image/svg+xml"),
        ]
        for url_path, expected_ct in expected_endpoints:
            try:
                st, ct, body = fetch_pwa(url_path)
                if st != 200 or not body:
                    errors.append(f"PWA HTTP {url_path} returned status={st}, len={len(body)}")
                elif not ct.lower().startswith(expected_ct):
                    errors.append(f"PWA HTTP {url_path} invalid Content-Type: {ct!r} (expected {expected_ct!r})")
            except Exception as exc:
                errors.append(f"PWA HTTP GET {url_path} failed: {exc}")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    return {"checks": checks, "precache_assets": precache_count}, errors


def verify_mobile_ux(parsed_js):
    """Part (j): Verify mobile/touch responsive markup, CSS safe-area rules, touch handlers, sw v2, and README preservation."""
    errors = []
    checks = 0

    # 1. index.html viewport-fit=cover and <nav id="mobileNavBar"
    checks += 1
    index_path = ROOT_DIR / "index.html"
    if not index_path.is_file():
        errors.append("Missing index.html")
    else:
        html_text = index_path.read_text(encoding="utf-8")
        if not re.search(
            r'<meta\b[^>]*name\s*=\s*["\']viewport["\'][^>]*content\s*=\s*["\'][^"\']*viewport-fit=cover',
            html_text,
            re.IGNORECASE,
        ):
            errors.append("index.html viewport <meta> missing viewport-fit=cover")
        if not re.search(r'<nav\b[^>]*\bid\s*=\s*["\']mobileNavBar["\']', html_text, re.IGNORECASE):
            errors.append('index.html missing <nav id="mobileNavBar">')

    # 2. CSS safe-area variables, mobile nav bar, drawer header, and 16px mobile input font-size
    checks += 1
    css_expectations = {
        "styles/tokens.css": ["--safe-top", "--safe-bottom", "--mobile-nav-height", "touch-action: manipulation"],
        "styles/layout.css": ["--safe-top", "--safe-bottom", ".mobile-nav-bar", ".mobile-drawer-header"],
        "styles/components.css": ["--safe-top", "--safe-bottom", "font-size: 16px"],
        "styles/compare.css": ["--safe-top", "--safe-bottom", "touch-action: none"],
    }
    for rel_css, required_tokens in css_expectations.items():
        p = ROOT_DIR / rel_css
        if not p.is_file():
            errors.append(f"Missing CSS file: {rel_css}")
            continue
        css_text = p.read_text(encoding="utf-8")
        for needle in required_tokens:
            if needle not in css_text:
                errors.append(f"{rel_css} missing expected mobile rule/token: {needle!r}")

    # 3. Touch event handlers in renderGallery.js, renderLightbox.js, and renderCompare.js
    checks += 1
    touch_modules = [
        "src/ui/renderGallery.js",
        "src/ui/renderLightbox.js",
        "src/ui/renderCompare.js",
    ]
    for rel_js in touch_modules:
        p_res = (ROOT_DIR / rel_js).resolve()
        if p_res not in parsed_js:
            errors.append(f"{rel_js} missing or failed JS parsing")
            continue
        toks = parsed_js[p_res]["tokens"]
        found_events = {
            unquote_string(tok.value)
            for tok in toks
            if tok.kind == "STRING" and unquote_string(tok.value) in ("touchstart", "touchmove", "touchend")
        }
        missing = [ev for ev in ("touchstart", "touchmove", "touchend") if ev not in found_events]
        if missing:
            errors.append(f"{rel_js} missing touch handler(s): {missing}")

    # 4. sw.js defines CACHE_NAME = 'drivelens-shell-v4'
    checks += 1
    sw_path = ROOT_DIR / "sw.js"
    if not sw_path.is_file():
        errors.append("Missing sw.js")
    else:
        sw_toks = tokenize_js(sw_path.read_text(encoding="utf-8"), filename="sw.js")
        has_v4 = any(
            sw_toks[i].kind == "IDENT"
            and sw_toks[i].value == "CACHE_NAME"
            and sw_toks[i + 1].kind == "PUNCT"
            and sw_toks[i + 1].value == "="
            and sw_toks[i + 2].kind == "STRING"
            and unquote_string(sw_toks[i + 2].value) == "drivelens-shell-v4"
            for i in range(len(sw_toks) - 2)
        )
        if not has_v4:
            errors.append("sw.js does not define CACHE_NAME = 'drivelens-shell-v4'")

    # 5. albumCache.js and renderGallery.js exports
    checks += 1
    album_cache_res = (ROOT_DIR / "src" / "storage" / "albumCache.js").resolve()
    if album_cache_res not in parsed_js:
        errors.append("src/storage/albumCache.js missing or failed JS parsing")
    else:
        ac_exports = parsed_js[album_cache_res]["exports"]
        for sym in ("getCachedAlbum", "setCachedAlbum", "clearAllAlbumCaches"):
            if sym not in ac_exports:
                errors.append(f"src/storage/albumCache.js missing export {sym}")

    gallery_res = (ROOT_DIR / "src" / "ui" / "renderGallery.js").resolve()
    if gallery_res not in parsed_js:
        errors.append("src/ui/renderGallery.js missing or failed JS parsing")
    else:
        gal_exports = parsed_js[gallery_res]["exports"]
        for sym in ("computeWaterfallColumns", "previewGalleryRowHeight", "relayoutGalleryOnResize"):
            if sym not in gal_exports:
                errors.append(f"src/ui/renderGallery.js missing export {sym}")

    # 5. README.md preserves exact user-edited ## Design Inspiration & Independence section
    checks += 1
    readme_path = ROOT_DIR / "README.md"
    if not readme_path.is_file():
        errors.append("Missing README.md")
    else:
        readme_text = readme_path.read_text(encoding="utf-8").replace("\r\n", "\n")
        expected_inspiration = (
            "## Design Inspiration & Independence\n\n"
            "- **UX Inspiration**: DriveLens's darkroom-grade palette, rapid keyboard rating workflow (`1\u20135`, `0`, `F`, `T`), and side-by-side comparison mode draw UX inspiration from [julyx10/lap](https://github.com/julyx10/lap).\n"
            "- **Independent Project**: DriveLens is designed and built from scratch as an independent pure-frontend web application. DriveLens is built specifically for zero-install browser/PWA viewing and conflict-free multiplayer culling directly on **Google Drive** shared folders."
        )
        if expected_inspiration not in readme_text:
            errors.append("README.md modified or missing exact '## Design Inspiration & Independence' section")

    return {"checks": checks}, errors


def main():
    print(f"=== DriveLens Verification ({ROOT_DIR}) ===")
    all_errors = []

    # (b) Static ES Module Graph & JS syntax/balance
    parsed_js, checked_edges, static_errors = verify_static_modules()
    print(f"[b] Static JS modules parsed: {len(parsed_js)} files, {checked_edges} import/re-export edges")
    if static_errors:
        print(f"    FAIL ({len(static_errors)} errors):")
        for e in static_errors:
            print(f"      - {e}")
        all_errors.extend(static_errors)
    else:
        print("    PASS: All JS files tokenized cleanly, braces balanced, all imports & symbols verified.")

    # (c) HTML <-> JS DOM ID, HTML tag balance, CSS balance
    html_ids, queried_ids, css_files, dom_errors = verify_html_css_and_dom_ids(parsed_js)
    print(
        f"[c] HTML/CSS/DOM check: {len(html_ids)} HTML IDs, "
        f"{len(queried_ids)} main.js ID queries, {len(css_files)} CSS files"
    )
    if dom_errors:
        print(f"    FAIL ({len(dom_errors)} errors):")
        for e in dom_errors:
            print(f"      - {e}")
        all_errors.extend(dom_errors)
    else:
        print("    PASS: index.html tags balanced, all main.js DOM IDs present, all CSS balanced.")

    # (a) HTTP server verification
    fetched_urls, transport_mode, http_errors = verify_http_server()
    print(f"[a] HTTP server crawl ({transport_mode}): fetched {len(fetched_urls)} resources")
    if http_errors:
        print(f"    FAIL ({len(http_errors)} errors):")
        for e in http_errors:
            print(f"      - {e}")
        all_errors.extend(http_errors)
    else:
        print("    PASS: All HTTP 200, non-empty bodies, Cache-Control no-cache, valid JS/CSS Content-Types.")

    # (d) Docs check
    docs_info, docs_errors = verify_docs()
    print(f"[d] Docs check: { {k: f'{v} chars' for k, v in docs_info.items()} }")
    if docs_errors:
        print(f"    FAIL ({len(docs_errors)} errors):")
        for e in docs_errors:
            print(f"      - {e}")
        all_errors.extend(docs_errors)
    else:
        print("    PASS: ARCHITECTURE.md and README.md exist and are non-empty.")

    # (e) start.bat ASCII + CRLF check
    bat_info, bat_errors = verify_start_bat()
    print(f"[e] start.bat check: {bat_info['bytes']} bytes, {bat_info['crlf_lines']} CRLF lines")
    if bat_errors:
        print(f"    FAIL ({len(bat_errors)} errors):")
        for e in bat_errors:
            print(f"      - {e}")
        all_errors.extend(bat_errors)
    else:
        print("    PASS: start.bat is 100% pure ASCII with strict CRLF line endings.")

    # (f) /api/meta in-process GET/POST + LWW merge + cleanup check
    meta_info, meta_errors = verify_api_meta()
    print(f"[f] /api/meta in-process test: {meta_info['checks']} checks, cleaned_up={meta_info['cleaned_up']}")
    if meta_errors:
        print(f"    FAIL ({len(meta_errors)} errors):")
        for e in meta_errors:
            print(f"      - {e}")
        all_errors.extend(meta_errors)
    else:
        print("    PASS: GET/POST /api/meta, LWW tagSchema merge, tombstone retention, 400 validation, and .local-meta cleanup verified.")

    # (g) Zero credentials & zero sensitive strings check
    sec_info, sec_errors = verify_no_credentials_or_secrets()
    print(f"[g] Credential/secret hygiene check: scanned {sec_info['scanned_files']} file(s)")
    if sec_errors:
        print(f"    FAIL ({len(sec_errors)} errors):")
        for e in sec_errors:
            print(f"      - {e}")
        all_errors.extend(sec_errors)
    else:
        print("    PASS: Zero credential config files and zero sensitive strings detected.")

    # (h) i18n parity, English default, t() call coverage, zero-CJK source check
    i18n_info, i18n_errors = verify_i18n(parsed_js)
    print(
        f"[h] i18n check: en={i18n_info['en_keys']} keys, zh={i18n_info['zh_keys']} keys, "
        f"{i18n_info['t_calls']} t() calls, {i18n_info['zero_cjk_files']} zero-CJK non-i18n files"
    )
    if i18n_errors:
        print(f"    FAIL ({len(i18n_errors)} errors):")
        for e in i18n_errors:
            print(f"      - {e}")
        all_errors.extend(i18n_errors)
    else:
        print("    PASS: <html lang='en'>, strict 'en' fallback, 100% EN/ZH parity, zero CJK in MESSAGES.en and all files outside src/i18n.js.")

    # (i) PWA manifest, icons, service worker, and MIME check
    pwa_info, pwa_errors = verify_pwa()
    print(f"[i] PWA check: {pwa_info['checks']} checks, {pwa_info['precache_assets']} precache assets")
    if pwa_errors:
        print(f"    FAIL ({len(pwa_errors)} errors):")
        for e in pwa_errors:
            print(f"      - {e}")
        all_errors.extend(pwa_errors)
    else:
        print("    PASS: manifest.webmanifest, 192/512 PNG IHDRs, sw.js precache assets, and PWA MIME headers verified.")

    # (j) Mobile & touch responsive UX check
    mob_info, mob_errors = verify_mobile_ux(parsed_js)
    print(f"[j] Mobile/touch UX check: {mob_info['checks']} checks")
    if mob_errors:
        print(f"    FAIL ({len(mob_errors)} errors):")
        for e in mob_errors:
            print(f"      - {e}")
        all_errors.extend(mob_errors)
    else:
        print("    PASS: viewport-fit=cover, #mobileNavBar, safe-area & 16px CSS, touch gestures, sw v2, and README section preserved.")

    print("=" * 56)
    if all_errors:
        print(f"VERIFICATION FAILED: {len(all_errors)} total error(s).")
        sys.exit(1)
    print("ALL VERIFICATION CHECKS PASSED (exit code 0).")
    sys.exit(0)


if __name__ == "__main__":
    main()
