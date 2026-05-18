from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager
import anthropic
import sqlite3
import json
import os
import base64
from dotenv import load_dotenv

load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
FALLBACK_MODEL    = "claude-opus-4-6"
DEFAULT_MODEL     = os.getenv("CLAUDE_MODEL", "claude-opus-4-6")
DB_PATH           = os.path.join(os.path.dirname(__file__), "..", "dev_helper.db")

CLAUDE_MODELS = [
    {"id": "claude-opus-4-6", "name": "Claude Opus 4.6"},
]

# ─── Database ─────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS error_logs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            error_type    TEXT,
            error_message TEXT NOT NULL,
            context       TEXT,
            solution      TEXT,
            model         TEXT,
            timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

def log_to_db(error_type: str, message: str, context: dict, solution: str, model: str):
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO error_logs (error_type, error_message, context, solution, model) VALUES (?,?,?,?,?)",
            (error_type, message, json.dumps(context), solution, model)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB] Error logging: {e}")

# ─── App ──────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print(f"[DevHelper] DB ready at {DB_PATH}")
    yield

app = FastAPI(title="Dev-Helper V2", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request Models ───────────────────────────────────────────────────────────
class ErrorRequest(BaseModel):
    type:         str = "unknown"
    message:      str = ""
    stack:        str = ""
    dom_snippet:  str = ""
    url:          str = ""        # resource URL (for network/resource errors)
    page_url:     str = ""        # window.location.href — the HTML page where error occurred
    status:       int = 0
    method:       str = ""
    statusText:   str = ""
    filename:     str = ""        # event.filename from JS errors
    lineno:       int = None      # event.lineno
    model:        str = None
    # GitHub enrichment (optional — only sent when repo is connected)
    github_token: str = None
    repo:         str = None   # "owner/repo"

class ApplyFixRequest(BaseModel):
    github_token: str
    repo:         str          # "owner/repo"
    file_path:    str          # relative path in repo, e.g. "src/utils.js"
    fix_text:     str          # the raw ##FIX## section from Claude's response
    error_message:str = ""
    base_branch:  str = "main"
    model:        str = None

class GithubConnectRequest(BaseModel):
    github_token: str
    repo:         str   # accepts "owner/repo" OR full URL


def normalize_repo(repo: str) -> str:
    """
    Accept any of these formats and return "owner/repo":
      - SuDy0906/dummy
      - https://github.com/SuDy0906/dummy
      - https://github.com/SuDy0906/dummy.git
      - github.com/SuDy0906/dummy
    """
    repo = repo.strip().rstrip('/')
    # Strip .git suffix
    if repo.endswith('.git'):
        repo = repo[:-4]
    # Strip protocol + github.com prefix
    for prefix in ('https://github.com/', 'http://github.com/', 'github.com/'):
        if repo.startswith(prefix):
            repo = repo[len(prefix):]
            break
    return repo

# ─── GitHub Helpers ───────────────────────────────────────────────────────────
import httpx
import re

def extract_file_and_line(stack: str) -> tuple[str | None, int | None]:
    """
    Parse a browser stack trace and extract the first meaningful
    file path + line number.

    Handles both:
      at fn (https://example.com/src/utils.js:23:7)
      at fn (http://localhost:3000/src/app.jsx:12:5)
    Returns: ("src/utils.js", 23)  — path relative to origin, line number
    """
    if not stack:
        return None, None

    # Match any URL ending in a js/ts/jsx/tsx/vue/svelte file with line:col
    pattern = re.compile(
        r'https?://[^/]+/([^\s)]+\.(?:js|ts|jsx|tsx|mjs|vue|svelte)):(\d+):\d+'
    )
    for match in pattern.finditer(stack):
        file_path = match.group(1)          # e.g.  src/utils.js
        line_num  = int(match.group(2))     # e.g.  23
        # Skip bundled/vendor files — they're unreadable
        if any(skip in file_path for skip in ['node_modules', 'vendors', 'chunk', 'bundle', 'webpack']):
            continue
        return file_path, line_num

    return None, None


async def fetch_code_snippet(
    token: str, repo: str, file_path: str, error_line: int | None
) -> str | None:
    """
    Fetch a file from GitHub and return ±20 lines around error_line,
    with line numbers, so Claude can see the actual problematic code.
    """
    try:
        resp = await gh("GET", f"/repos/{repo}/contents/{file_path}", token)
        if resp.status_code != 200:
            return None

        content_b64 = resp.json().get("content", "")
        full_source  = base64.b64decode(content_b64).decode("utf-8", errors="replace")
        lines        = full_source.splitlines()
        total_lines  = len(lines)

        if error_line and 1 <= error_line <= total_lines:
            start = max(0, error_line - 21)          # 20 lines before
            end   = min(total_lines, error_line + 20) # 20 lines after
        else:
            start, end = 0, min(60, total_lines)      # first 60 lines if no line number

        numbered = [
            f"{'→ ' if (i + 1) == error_line else '  '}{i + 1:4d} | {line}"
            for i, line in enumerate(lines[start:end], start=start)
        ]
        return "\n".join(numbered)
    except Exception as e:
        print(f"[GitHub] Failed to fetch snippet: {e}")
        return None


async def find_file_from_page_url(
    token: str, repo: str, page_url: str, dom_snippet: str = ""
) -> tuple[str | None, int | None]:
    """
    Most reliable strategy: convert the browser page URL directly to a repo file.

    http://localhost:5500/          -> index.html
    http://localhost:5500/about     -> about.html
    http://localhost:3000/src/app   -> src/app.js (tries .js, .jsx, .ts, .tsx, .html)
    http://localhost:3000/          -> index.html

    Then scan that file for the DOM element identifier to pinpoint the exact line.
    """
    if not page_url:
        return None, None

    try:
        from urllib.parse import urlparse
        parsed   = urlparse(page_url)
        raw_path = parsed.path.lstrip('/')   # e.g. "" or "about" or "src/dashboard"

        # Candidates to try in order
        if not raw_path or raw_path == '/':
            candidates = ['index.html', 'index.htm', 'index.js']
        else:
            # Try exact path, then with common extensions
            base = raw_path.rstrip('/')
            candidates = [
                base,
                base + '.html',
                base + '.htm',
                base + '.js',
                base + '.jsx',
                base + '.ts',
                base + '.tsx',
                'index.html',   # fallback
            ]

        for candidate in candidates:
            resp = await gh("GET", f"/repos/{repo}/contents/{candidate}", token)
            if resp.status_code == 200:
                file_path   = candidate
                content_b64 = resp.json().get("content", "")
                source      = base64.b64decode(content_b64).decode("utf-8", errors="replace")

                # Find the exact line with the DOM element
                line_num = None
                if dom_snippet:
                    # Extract best search term from the DOM snippet (id > class > src)
                    id_m = re.search(r'\bid=["\']([^"\']{2,})["\']', dom_snippet)
                    search_term = id_m.group(1) if id_m else None

                    if not search_term:
                        cls_m = re.search(r'\bclass=["\']([^"\']{2,})["\']', dom_snippet)
                        if cls_m:
                            search_term = cls_m.group(1).split()[0]

                    if not search_term:
                        src_m = re.search(r'\b(?:src|href)=["\']([^"\']{3,})["\']', dom_snippet)
                        if src_m:
                            search_term = src_m.group(1).split('/')[-1].split('?')[0][:40]

                    if search_term:
                        for i, line in enumerate(source.splitlines(), start=1):
                            if search_term in line:
                                line_num = i
                                break

                print(f"[GitHub] page_url -> {file_path}:{line_num}")
                return file_path, line_num

        return None, None

    except Exception as e:
        print(f"[GitHub] page_url lookup error: {e}")
        return None, None


async def find_file_from_dom(
    token: str, repo: str, dom_snippet: str
) -> tuple[str | None, int | None]:
    """
    When there's no JS stack trace, try to locate the problematic file in the
    GitHub repo by searching for a unique identifier extracted from the DOM snippet.

    Strategy (in priority order):
      1. id attribute value       → most unique, e.g. id="avatar-img"
      2. src / href value         → URL or path, e.g. src="images/logo.png"
      3. class name(s)            → less unique but still useful
      4. First 40 chars of text   → last resort

    Uses GitHub Code Search API, then fetches the file to find the exact line.
    """
    if not dom_snippet:
        return None, None

    # --- Extract the best search term from the DOM snippet ---
    search_term = None

    id_m = re.search(r'\bid=["\']([^"\']{2,})["\']', dom_snippet)
    if id_m:
        search_term = id_m.group(1)

    if not search_term:
        src_m = re.search(r'\b(?:src|href)=["\']([^"\']{3,})["\']', dom_snippet)
        if src_m:
            # Use just the filename part of a URL/path — more repo-friendly
            raw = src_m.group(1)
            search_term = raw.split("/")[-1].split("?")[0][:50] or raw[:50]

    if not search_term:
        cls_m = re.search(r'\bclass=["\']([^"\']{2,})["\']', dom_snippet)
        if cls_m:
            # Use the first class name only
            search_term = cls_m.group(1).split()[0]

    if not search_term:
        # Strip tags and take first 40 meaningful chars
        stripped = re.sub(r'<[^>]+>', '', dom_snippet).strip()
        search_term = stripped[:40] if stripped else None

    if not search_term:
        return None, None

    print(f"[GitHub] Searching repo for DOM term: {search_term!r}")

    try:
        # GitHub Code Search — finds which file(s) contain the search term
        search_resp = await gh(
            "GET", "/search/code", token,
            params={"q": f'"{search_term}" repo:{repo}', "per_page": 5}
        )

        if search_resp.status_code == 422:
            # Term too short or invalid for search — try raw without quotes
            search_resp = await gh(
                "GET", "/search/code", token,
                params={"q": f'{search_term} repo:{repo}', "per_page": 5}
            )

        if search_resp.status_code != 200:
            print(f"[GitHub] Code search failed: {search_resp.status_code}")
            return None, None

        items = search_resp.json().get("items", [])
        if not items:
            print(f"[GitHub] No files found containing: {search_term!r}")
            return None, None

        # Take the first (most relevant) match
        file_path = items[0]["path"]
        print(f"[GitHub] Found file via DOM search: {file_path}")

        # Fetch the file and find the exact line number
        file_resp = await gh("GET", f"/repos/{repo}/contents/{file_path}", token)
        if file_resp.status_code != 200:
            return file_path, None

        content_b64 = file_resp.json().get("content", "")
        source      = base64.b64decode(content_b64).decode("utf-8", errors="replace")

        # Find the line containing the search term
        for i, line in enumerate(source.splitlines(), start=1):
            if search_term in line:
                return file_path, i

        return file_path, None  # file found but couldn't pin the line

    except Exception as e:
        print(f"[GitHub] DOM-based file search error: {e}")
        return None, None

async def gh(method: str, path: str, token: str, **kwargs):
    """Thin GitHub REST API wrapper."""
    async with httpx.AsyncClient() as client:
        resp = await client.request(
            method,
            f"https://api.github.com{path}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept":        "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=20.0,
            **kwargs
        )
        return resp

# ─── Endpoints ────────────────────────────────────────────────────────────────
@app.get("/models")
async def get_models():
    return {"models": CLAUDE_MODELS, "default": DEFAULT_MODEL}


@app.get("/history")
async def get_history():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, error_type, error_message, solution, model, timestamp "
        "FROM error_logs ORDER BY timestamp DESC LIMIT 50"
    ).fetchall()
    conn.close()
    return {"history": [dict(r) for r in rows]}


@app.delete("/history")
async def clear_history():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM error_logs")
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/github/user")
async def github_user(req: GithubConnectRequest):
    """Fetch GitHub profile info for the given PAT."""
    resp = await gh("GET", "/user", req.github_token)
    if resp.status_code == 200:
        d = resp.json()
        return {
            "ok":          True,
            "login":       d.get("login"),
            "name":        d.get("name") or d.get("login"),
            "avatar_url":  d.get("avatar_url"),
            "public_repos": d.get("public_repos", 0),
        }
    elif resp.status_code == 401:
        return {"ok": False, "error": "Invalid token. Make sure it starts with ghp_ and hasn't expired."}
    else:
        return {"ok": False, "error": f"GitHub error {resp.status_code}"}


@app.post("/github/repos")
async def github_repos(req: GithubConnectRequest):
    """List all repos the token has access to (personal + org), sorted by last updated."""
    repos = []
    page  = 1
    while True:
        resp = await gh(
            "GET", "/user/repos", req.github_token,
            params={"per_page": 100, "page": page, "sort": "updated", "affiliation": "owner,collaborator,organization_member"}
        )
        if resp.status_code != 200:
            break
        batch = resp.json()
        if not batch:
            break
        repos.extend([
            {
                "full_name":    r["full_name"],
                "name":         r["name"],
                "private":      r["private"],
                "language":     r.get("language") or "",
                "updated_at":   r.get("updated_at", ""),
                "default_branch": r.get("default_branch", "main"),
                "description":  r.get("description") or "",
            }
            for r in batch
        ])
        if len(batch) < 100:
            break
        page += 1

    return {"ok": True, "repos": repos}


@app.post("/github/connect")
async def github_connect(req: GithubConnectRequest):
    """Validate a GitHub PAT and repo, return repo info."""
    repo = normalize_repo(req.repo)
    resp = await gh("GET", f"/repos/{repo}", req.github_token)
    if resp.status_code == 200:
        data = resp.json()
        return {
            "ok":             True,
            "full_name":      data["full_name"],
            "default_branch": data["default_branch"],
            "private":        data["private"],
            "html_url":       data["html_url"],
        }
    elif resp.status_code == 401:
        return {"ok": False, "error": "Invalid GitHub token. Check that it hasn't expired."}
    elif resp.status_code == 404:
        return {"ok": False, "error": f"Repo '{repo}' not found. Check the repo name and token permissions (Contents: Read & Write)."}
    else:
        return {"ok": False, "error": f"GitHub error {resp.status_code}: {resp.text}"}


@app.post("/apply-fix")
async def apply_fix(req: ApplyFixRequest):
    """
    1. Fetch the file from GitHub
    2. Ask Claude to apply the fix to the full file content
    3. Create a new branch (devhelper/fix-<timestamp>)
    4. Commit the patched file to the new branch
    5. Return the branch URL
    """
    if not ANTHROPIC_API_KEY:
        return {"ok": False, "error": "ANTHROPIC_API_KEY not set in .env"}

    model = req.model or DEFAULT_MODEL
    if model not in [m["id"] for m in CLAUDE_MODELS]:
        model = DEFAULT_MODEL
    repo  = normalize_repo(req.repo)   # accept full URL or owner/repo

    # 1. Get repo default branch & HEAD SHA
    repo_resp = await gh("GET", f"/repos/{repo}", req.github_token)
    if repo_resp.status_code != 200:
        return {"ok": False, "error": f"Cannot access repo: {repo_resp.status_code}"}
    repo_data      = repo_resp.json()
    default_branch = repo_data["default_branch"]

    # 2. Fetch current file
    file_resp = await gh("GET", f"/repos/{req.repo}/contents/{req.file_path}",
                         req.github_token, params={"ref": default_branch})
    if file_resp.status_code == 404:
        return {"ok": False, "error": f"File '{req.file_path}' not found in repo on branch '{default_branch}'."}
    if file_resp.status_code != 200:
        return {"ok": False, "error": f"Could not fetch file: {file_resp.status_code}"}

    file_data        = file_resp.json()
    file_sha         = file_data["sha"]
    original_content = base64.b64decode(file_data["content"]).decode("utf-8", errors="replace")

    # 3. Ask Claude to apply the fix to the full file
    patch_prompt = f"""You are an expert code editor. Apply the following fix to the file below.
Return ONLY the complete, corrected file content — no explanations, no markdown fences, no extra text.

## Suggested Fix
{req.fix_text}

## Original File ({req.file_path})
```
{original_content}
```

Output the entire corrected file content now:"""

    try:
        client  = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        message = client.messages.create(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": patch_prompt}]
        )
        patched_content = message.content[0].text.strip()
    except Exception as e:
        return {"ok": False, "error": f"Claude error: {e}"}

    # 4. Create new branch from HEAD of default branch
    import time
    branch_name  = f"devhelper/fix-{int(time.time())}"
    ref_resp     = await gh("GET", f"/repos/{req.repo}/git/ref/heads/{default_branch}", req.github_token)
    if ref_resp.status_code != 200:
        return {"ok": False, "error": f"Cannot get branch HEAD: {ref_resp.status_code}"}
    head_sha = ref_resp.json()["object"]["sha"]

    create_branch = await gh("POST", f"/repos/{req.repo}/git/refs", req.github_token,
                             json={"ref": f"refs/heads/{branch_name}", "sha": head_sha})
    if create_branch.status_code not in (200, 201):
        return {"ok": False, "error": f"Cannot create branch: {create_branch.status_code} {create_branch.text}"}

    # 5. Commit patched file to new branch
    commit_msg = f"fix: apply DevHelper AI fix for: {req.error_message[:80]}"
    encoded    = base64.b64encode(patched_content.encode("utf-8")).decode("utf-8")
    update_resp = await gh("PUT", f"/repos/{req.repo}/contents/{req.file_path}",
                           req.github_token, json={
                               "message": commit_msg,
                               "content": encoded,
                               "sha":     file_sha,
                               "branch":  branch_name,
                           })
    if update_resp.status_code not in (200, 201):
        return {"ok": False, "error": f"Cannot commit file: {update_resp.status_code} {update_resp.text}"}

    branch_url = f"https://github.com/{req.repo}/tree/{branch_name}"
    compare_url = f"https://github.com/{req.repo}/compare/{default_branch}...{branch_name}"
    return {
        "ok":          True,
        "branch":      branch_name,
        "branch_url":  branch_url,
        "compare_url": compare_url,
    }


@app.post("/debug")
async def debug_error(req: ErrorRequest):
    """
    Stream a Claude response. SSE format:
      data: {"token": "..."}\n\n
      data: {"done": true}\n\n
      data: {"error": "..."}\n\n
    """
    if not ANTHROPIC_API_KEY:
        async def no_key():
            yield f'data: {json.dumps({"error": "ANTHROPIC_API_KEY not set in .env"})}\n\n'
        return StreamingResponse(no_key(), media_type="text/event-stream")

    model = req.model or DEFAULT_MODEL
    # Prevent 404s if the frontend sends a stale model from local storage
    if model not in [m["id"] for m in CLAUDE_MODELS]:
        model = DEFAULT_MODEL

    # ── Enrich prompt with real source code when GitHub repo is connected ──────
    code_snippet_section = ""
    detected_file        = None
    detected_line        = None

    if req.github_token and req.repo:
        repo_norm = normalize_repo(req.repo)

        # Step 1: JS stack trace → most precise (file + line in the trace)
        detected_file, detected_line = extract_file_and_line(req.stack)

        # Step 2: page_url → direct file lookup (best for DOM/resource errors)
        #   e.g. http://localhost:5500/ → index.html, then scan for dom element
        if not detected_file and req.page_url:
            print(f"[DevHelper] No stack file — trying page_url: {req.page_url}")
            detected_file, detected_line = await find_file_from_page_url(
                req.github_token, repo_norm, req.page_url, req.dom_snippet
            )

        # Step 3: GitHub Code Search fallback (slower, may miss non-indexed repos)
        if not detected_file and req.dom_snippet:
            print("[DevHelper] page_url failed — trying GitHub Code Search")
            detected_file, detected_line = await find_file_from_dom(
                req.github_token, repo_norm, req.dom_snippet
            )

        if detected_file:
            print(f"[DevHelper] Final file: {detected_file}:{detected_line}")

        # Fetch ±20 lines of actual source around the error
        if detected_file:
            snippet = await fetch_code_snippet(
                req.github_token, repo_norm, detected_file, detected_line
            )
            if snippet:
                line_hint = f" (error near line {detected_line})" if detected_line else ""
                code_snippet_section = f"""
## Problematic Source Code
File: `{detected_file}`{line_hint}
The line marked with -> is where the problematic code is:

```
{snippet}
```
"""

    # Pre-build FILE and BRANCH_HINT to avoid f-string expression confusion.
    # When we already know the file, embed it directly so Claude just echoes it back.
    if detected_file:
        file_instruction   = detected_file
        branch_instruction = "fix-" + detected_file.replace("/", "-").split(".")[0] + "-error"
    else:
        file_instruction   = "(Write ONLY the bare relative path e.g. app.js or src/utils.js - no quotes no backticks. If truly unknown write exactly: unknown)"
        branch_instruction = "(Write ONLY a short kebab-case slug max 5 words e.g. fix-null-user-profile)"

    prompt = f"""You are an expert web developer and debugger helping a developer fix a browser error.

## Error Details
- **Type**: {req.type}
- **Message**: {req.message}
- **URL / Resource**: {req.url}  (Method: {req.method or "GET"}, Status: {req.status} {req.statusText})
- **Stack Trace**:
{req.stack[:800] if req.stack else "N/A"}
- **DOM Snippet**:
{req.dom_snippet[:400] if req.dom_snippet else "N/A"}
{code_snippet_section}
## Instructions
Respond using EXACTLY this four-section format with the exact markers - no preamble, no extra text outside the sections:

##EXPLANATION##
(2-3 sentence plain-English explanation of what caused this error)

##FIX##
(The precise code fix - use a fenced code block. Reference exact line numbers if source code is provided above.)

##FILE##
{file_instruction}

##BRANCH_HINT##
{branch_instruction}"""

    async def generate():
        full_text = ""
        active_model = model
        try:
            client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
            try:
                async with client.messages.stream(
                    model=active_model,
                    max_tokens=1024,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    async for token in stream.text_stream:
                        full_text += token
                        yield f"data: {json.dumps({'token': token})}\n\n"
            except anthropic.NotFoundError:
                # Selected model not available on this API tier — auto-fallback to Haiku
                active_model = FALLBACK_MODEL
                yield f"data: {json.dumps({'info': f'Model not available, falling back to {FALLBACK_MODEL}'})}\n\n"
                async with client.messages.stream(
                    model=active_model,
                    max_tokens=1024,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    async for token in stream.text_stream:
                        full_text += token
                        yield f"data: {json.dumps({'token': token})}\n\n"

            log_to_db(req.type, req.message, req.model_dump(), full_text, active_model)
            yield f"data: {json.dumps({'done': True})}\n\n"

        except anthropic.AuthenticationError:
            yield f"data: {json.dumps({'error': 'Invalid Anthropic API key. Check your .env file.'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
