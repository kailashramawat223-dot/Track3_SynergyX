"""CampusMitra Flask backend.

Responsibilities:
- Detect the topic of a user question from a small keyword map (topics.json).
- Fetch the matching MBM University page AND follow linked notice/PDF URLs
  so the frontend AI has the full picture, not just a summary.
- If website fetch fails or content looks irrelevant, fall back to any
  in-memory PDF text the user has uploaded.
- Return ONLY raw context + a short source label. Never generate an answer.
"""
from __future__ import annotations

import io
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import pdfplumber
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from groq import Groq
from groq import (
    APIConnectionError as GroqAPIConnectionError,
    APIStatusError as GroqAPIStatusError,
    APITimeoutError as GroqAPITimeoutError,
)

load_dotenv()

BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
TOPICS_PATH = BASE_DIR / "topics.json"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")

# ---------------------------------------------------------------------------
# Groq configuration
# ---------------------------------------------------------------------------
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL_NAME = "llama-3.3-70b-versatile"

groq_client: Groq | None = None
if GROQ_API_KEY:
    groq_client = Groq(api_key=GROQ_API_KEY)
else:
    print(
        "WARNING: GROQ_API_KEY environment variable is not set. "
        "The /api/chat endpoint will return an error until it is configured."
    )

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_topics() -> dict[str, Any]:
    with TOPICS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)

TOPICS_CONFIG = load_topics()

# ---------------------------------------------------------------------------
# In-memory PDF store (as required by the spec — lost on restart)
# ---------------------------------------------------------------------------
_pdf_lock = threading.Lock()
PDF_STORE: list[dict[str, str]] = []  # [{name, text}]

# Cache of fetched page/pdf text so repeat questions don't hammer the site.
_page_cache: dict[str, str] = {}
_cache_lock = threading.Lock()

USER_AGENT = (
    "Mozilla/5.0 (compatible; CampusMitra/1.0; +https://gitlab.com/) "
    "Educational assistant for MBM University students"
)
REQUEST_TIMEOUT = 6  # seconds — was 10; keep sub-page fetches snappy
MAX_CONTEXT_CHARS = 8000  # was 20000 — smaller prompt = faster AI response
MAX_LINKS_TO_FOLLOW = 3  # was 8 — fewer sequential fetches per question
MBM_HOST_SUFFIX = "mbm.ac.in"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def detect_topic(question: str) -> str:
    """Return the topic key whose keywords best match the question."""
    q = question.lower()
    best_key = TOPICS_CONFIG.get("default_topic", "home")
    best_score = 0
    for key, cfg in TOPICS_CONFIG["topics"].items():
        score = 0
        for kw in cfg.get("keywords", []):
            if kw.lower() in q:
                score += len(kw.split()) + 1
        if score > best_score:
            best_score = score
            best_key = key
    return best_key


def _question_keywords(question: str) -> list[str]:
    return [w for w in re.findall(r"[a-zA-Zऀ-ॿ]{4,}", question.lower())]


def clean_html_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "header", "footer", "nav"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    return "\n".join(lines)


def _http_get(url: str) -> requests.Response | None:
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        return resp
    except requests.RequestException:
        return None


def _extract_pdf_text(raw: bytes) -> str:
    try:
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            parts = []
            # Cap pages so a giant PDF doesn't blow up context.
            for page in pdf.pages[:20]:
                t = page.extract_text() or ""
                if t.strip():
                    parts.append(t)
            return "\n".join(parts).strip()
    except Exception:
        return ""


def fetch_url_text(url: str) -> str | None:
    """Fetch a URL and return plain text. Handles HTML pages and PDFs."""
    with _cache_lock:
        if url in _page_cache:
            return _page_cache[url]

    resp = _http_get(url)
    if resp is None:
        return None

    content_type = (resp.headers.get("Content-Type") or "").lower()
    lower_url = url.lower()

    if "pdf" in content_type or lower_url.endswith(".pdf"):
        text = _extract_pdf_text(resp.content)
    else:
        text = clean_html_text(resp.text or "")

    if not text or len(text) < 40:
        return None

    with _cache_lock:
        _page_cache[url] = text
    return text


FILE_EXTENSIONS = (".pdf", ".doc", ".docx", ".xls", ".xlsx")


def extract_file_links(page_url: str, html: str) -> list[dict]:
    """Return ALL downloadable file links (PDFs etc.) found on a page, as
    [{label, url}], so the frontend can offer them as real attachments —
    separate from the relevance-scored link-following used for context."""
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return []

    links: list[dict] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href:
            continue
        full = urljoin(page_url, href)
        if not full.lower().endswith(FILE_EXTENSIONS):
            continue
        if full in seen:
            continue
        seen.add(full)
        label = a.get_text(" ", strip=True) or full.rsplit("/", 1)[-1]
        links.append({"label": label, "url": full})

    return links[:20]


def _extract_relevant_links(page_url: str, html: str, question: str) -> list[tuple[str, str]]:
    """Return [(url, anchor_text)] for on-page links likely to hold detail.

    We prefer:
    - Links whose anchor text overlaps with the question keywords.
    - PDF links (results, notices, timetables are almost always PDFs on MBM).
    - Links that stay on the mbm.ac.in domain.
    """
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return []

    q_words = _question_keywords(question)
    seen: set[str] = set()
    scored: list[tuple[int, str, str]] = []

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith("#") or href.startswith("mailto:") or href.startswith("tel:"):
            continue
        full = urljoin(page_url, href)
        parsed = urlparse(full)
        if parsed.scheme not in ("http", "https"):
            continue
        # Stay on MBM (or its subdomains) unless it's a PDF anywhere.
        is_pdf = parsed.path.lower().endswith(".pdf")
        on_mbm = parsed.netloc.endswith(MBM_HOST_SUFFIX)
        if not is_pdf and not on_mbm:
            continue
        if full == page_url or full in seen:
            continue
        seen.add(full)

        anchor = (a.get_text(" ", strip=True) or "").lower()
        score = 0
        for w in q_words:
            if w in anchor:
                score += 3
            if w in full.lower():
                score += 1
        if is_pdf:
            score += 4  # strongly prefer PDFs — these are the actual notices/documents
        if score <= 0:
            continue
        scored.append((score, full, anchor))

    scored.sort(key=lambda t: t[0], reverse=True)
    return [(url, anchor) for _score, url, anchor in scored[:MAX_LINKS_TO_FOLLOW]]


def fetch_topic_context(topic_cfg: dict, question: str) -> tuple[str, str, list[dict]] | None:
    """Fetch the topic page + relevant linked pages/PDFs. Returns (text, label, file_links)."""
    url = topic_cfg["url"]
    resp = _http_get(url)
    if resp is None:
        return None

    page_html = resp.text or ""
    page_text = clean_html_text(page_html)
    if not page_text or len(page_text) < 40:
        return None

    with _cache_lock:
        _page_cache[url] = page_text

    file_links = extract_file_links(url, page_html)

    combined_parts = [f"# {topic_cfg['label']}", page_text]
    used_labels = [topic_cfg["label"]]

    # Follow up to N most relevant links (PDFs and sub-pages) — fetched in
    # parallel since these are independent network calls, not sequential ones.
    relevant_links = _extract_relevant_links(url, page_html, question)
    if relevant_links:
        with ThreadPoolExecutor(max_workers=min(len(relevant_links), MAX_LINKS_TO_FOLLOW)) as pool:
            fetched = list(pool.map(lambda pair: (pair[1], fetch_url_text(pair[0])), relevant_links))
        for anchor, sub_text in fetched:
            if not sub_text:
                continue
            header = f"\n\n---\n# Linked source: {anchor or 'attachment'}\n"
            combined_parts.append(header + sub_text)
            used_labels.append(anchor or "linked source")
            if sum(len(p) for p in combined_parts) > MAX_CONTEXT_CHARS:
                break

    combined = "\n".join(combined_parts)
    label = topic_cfg["label"]
    if len(used_labels) > 1:
        # Show that we pulled in extra sources too.
        extras = len(used_labels) - 1
        label = f"{topic_cfg['label']} (+{extras} linked source{'s' if extras > 1 else ''})"
    return combined, label, file_links


def page_seems_relevant(question: str, page_text: str) -> bool:
    if not page_text:
        return False
    words = _question_keywords(question)
    if not words:
        return True
    lowered = page_text.lower()
    return any(w in lowered for w in words)


def search_pdfs(question: str) -> tuple[str, str] | None:
    with _pdf_lock:
        if not PDF_STORE:
            return None
        pdfs = list(PDF_STORE)

    words = _question_keywords(question)

    best: tuple[int, dict[str, str]] | None = None
    for pdf in pdfs:
        text_lower = pdf["text"].lower()
        score = sum(text_lower.count(w) for w in words) if words else 1
        if best is None or score > best[0]:
            best = (score, pdf)

    if best is None:
        return None
    _score, pdf = best
    return pdf["text"], f"uploaded PDF — {pdf['name']}"


def trim(text: str, limit: int = MAX_CONTEXT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n[… content truncated …]"

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")


@app.route("/api/context", methods=["POST"])
def api_context():
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "empty question"}), 400

    topic_key = detect_topic(question)
    topic_cfg = TOPICS_CONFIG["topics"][topic_key]

    # 1. Main topic page + linked notice/PDF pages.
    result = fetch_topic_context(topic_cfg, question)
    if result is not None:
        text, label, file_links = result
        if page_seems_relevant(question, text):
            return jsonify({
                "context": trim(text),
                "source": label,
                "topic": topic_key,
                "files": file_links,
            })

    # 2. Fall back to uploaded PDFs.
    pdf_hit = search_pdfs(question)
    if pdf_hit is not None:
        pdf_text, pdf_label = pdf_hit
        return jsonify({
            "context": trim(pdf_text),
            "source": pdf_label,
            "topic": "pdf",
            "files": [],  # uploaded PDFs aren't linkable URLs
        })

    # 3. If the page loaded but seemed irrelevant, still send it.
    if result is not None:
        text, label, file_links = result
        return jsonify({
            "context": trim(text),
            "source": label,
            "topic": topic_key,
            "files": file_links,
        })

    return jsonify({
        "context": "",
        "source": "no source available",
        "topic": topic_key,
        "files": [],
    })


@app.route("/api/chat", methods=["POST"])
def api_chat():
    if not GROQ_API_KEY or groq_client is None:
        return jsonify({
            "error": "GROQ_API_KEY is not configured on the server. "
                     "Set it as an environment variable and restart the app."
        }), 500

    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "empty prompt"}), 400

    try:
        response = groq_client.chat.completions.create(
            model=GROQ_MODEL_NAME,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
            temperature=0.3,
            max_tokens=1024,
            timeout=30,
        )
        answer = (response.choices[0].message.content or "").strip()
        if not answer:
            return jsonify({"error": "Groq API call failed: empty response"}), 502
        return jsonify({"text": answer})
    except GroqAPITimeoutError as exc:
        return jsonify({"error": f"Groq API call timed out: {exc}"}), 504
    except GroqAPIStatusError as exc:
        # Covers invalid API key, rate limits, quota errors, and any other
        # non-2xx response returned by the Groq server.
        status = exc.status_code or 502
        return jsonify({"error": f"Groq API call failed: {exc}"}), status
    except GroqAPIConnectionError as exc:
        return jsonify({"error": f"Groq API connection failed: {exc}"}), 502
    except Exception as exc:  # noqa: BLE001 - surface any other error to the client
        return jsonify({"error": f"Groq API call failed: {exc}"}), 500


@app.route("/api/upload_pdf", methods=["POST"])
def api_upload_pdf():
    if "file" not in request.files:
        return jsonify({"error": "no file provided"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "empty filename"}), 400
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "only PDF files are supported"}), 400

    raw = file.read()
    text = _extract_pdf_text(raw)
    if not text:
        return jsonify({"error": "no extractable text in PDF"}), 400

    with _pdf_lock:
        PDF_STORE.append({"name": file.filename, "text": text})
        count = len(PDF_STORE)

    return jsonify({"ok": True, "name": file.filename, "chars": len(text), "pdfs": count})


@app.route("/api/pdfs")
def api_pdfs():
    with _pdf_lock:
        items = [{"name": p["name"], "chars": len(p["text"])} for p in PDF_STORE]
    return jsonify({"pdfs": items})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    with _cache_lock:
        _page_cache.clear()
    return jsonify({"ok": True})


@app.route("/api/health")
def api_health():
    with _pdf_lock:
        n = len(PDF_STORE)
    return jsonify({"ok": True, "pdfs_loaded": n, "topics": list(TOPICS_CONFIG["topics"].keys())})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
