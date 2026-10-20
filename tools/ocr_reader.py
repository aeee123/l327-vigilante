"""Optional free OCR reader. Uses Tesseract + Poppler; no paid API or X cookie."""
import csv
import io
import ipaddress
import json
import os
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ALLOWED = {"s3.pagegear.co", "pbs.twimg.com", "goo.su", "bit.ly", "drive.google.com", "docs.google.com", "drive.usercontent.google.com", "www.eneeutcd.hn", "eneeutcd.hn"}
MAX_BYTES = 20 * 1024 * 1024


def public_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.hostname not in ALLOWED or parsed.port not in (None, 443):
        raise ValueError("host de documento no permitido")
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("destino de red no público")
    return url


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, public_url(newurl))


def download(url, depth=0):
    if depth > 3:
        raise ValueError("demasiados enlaces de documento")
    public_url(url)
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname in {"drive.google.com", "docs.google.com"} and "/file/d/" in parsed.path:
        file_id = parsed.path.split("/file/d/", 1)[1].split("/", 1)[0]
        url = "https://drive.google.com/uc?export=download&id=" + urllib.parse.quote(file_id)
    request = urllib.request.Request(url, headers={"User-Agent": "L327-Vigilante-OCR/2.0"})
    opener = urllib.request.build_opener(PublicRedirect())
    with opener.open(request, timeout=25) as response:
        data = response.read(MAX_BYTES + 1)
        final_url = response.url
        mime = response.headers.get_content_type()
    if len(data) > MAX_BYTES:
        raise ValueError("documento supera 20 MB")
    if data.startswith(b"%PDF-"):
        return data, "pdf"
    if mime.startswith("image/") and mime != "image/svg+xml":
        return data, "image"
    if mime == "text/html":
        text = data.decode("utf-8", errors="replace")
        links = re.findall(r'(?:href|src)=[\"\']([^\"\']+)[\"\']', text, re.I)
        for link in links:
            target = urllib.parse.urljoin(final_url, link.replace("&amp;", "&"))
            if re.search(r"\.pdf(?:\?|$)|drive\.google\.com/file/d/", target, re.I):
                return download(target, depth + 1)
    raise ValueError("contenido no es imagen/PDF; revisar enlace manualmente")


def recognize(path):
    result = subprocess.run(["tesseract", str(path), "stdout", "-l", "spa+eng", "--psm", "11", "tsv"], capture_output=True, text=True, encoding="utf-8", timeout=60, check=True)
    lines = {}
    scores = []
    for row in csv.DictReader(io.StringIO(result.stdout), delimiter="\t", quoting=csv.QUOTE_NONE):
        word = (row.get("text") or "").strip()
        if not word:
            continue
        score = float(row["conf"])
        key = tuple(row[k] for k in ("page_num", "block_num", "par_num", "line_num"))
        lines.setdefault(key, []).append(word)
        if score >= 0:
            scores.append(score)
    text = "\n".join(" ".join(words) for words in lines.values())
    return {"text": text, "confidence": round(sum(scores) / len(scores), 1) if scores else 0}


def extract(data, kind):
    with tempfile.TemporaryDirectory(prefix="l327-ocr-") as temp:
        root = Path(temp)
        if kind == "pdf":
            source = root / "input.pdf"
            source.write_bytes(data)
            info = subprocess.run(["pdfinfo", str(source)], capture_output=True, text=True, timeout=15, check=True).stdout
            count = re.search(r"^Pages:\s*(\d+)", info, re.M)
            if not count or int(count[1]) > 20:
                raise ValueError("PDF supera 20 páginas; dividir o revisar manualmente")
            subprocess.run(["pdftoppm", "-scale-to", "2400", "-png", str(source), str(root / "page")], capture_output=True, timeout=120, check=True)
            pages = sorted(root.glob("page-*.png"))
        else:
            source = root / "image"
            source.write_bytes(data)
            pages = [source]
        units = [recognize(page) for page in pages]
        if sum(len(u["text"]) for u in units) > 60000:
            raise ValueError("texto OCR demasiado extenso")
        return units


def api(base, token, path, payload=None):
    request = urllib.request.Request(base + path, data=json.dumps(payload).encode() if payload is not None else None, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "L327-Vigilante-OCR/2.0", "Accept": "application/json"})
    # No redirect may forward the administration secret to a different host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=50) as response:
        return json.load(response)


def main():
    base = os.environ.get("BOT_URL", "").rstrip("/")
    token = os.environ.get("ADMIN_TOKEN", "")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError("BOT_URL debe ser el origen HTTPS del Worker")
    if not token:
        raise ValueError("falta ADMIN_TOKEN")
    items = api(base, token, "/media")["items"]
    failures = 0
    for item in items:
        try:
            data, kind = download(item["url"])
            units = extract(data, kind)
            result = api(base, token, "/ingest", {"id": item["id"], "units": units})
            if result.get("reason", "").startswith("OCR"):
                failures += 1
            print(item["id"][:12], json.dumps(result, ensure_ascii=False))
        except Exception as error:
            failures += 1
            # Never print exception URLs or response bodies: they may contain secrets.
            category = type(error).__name__
            print(item["id"][:12], "OCR pendiente:", category)
            api(base, token, "/ingest", {"id": item["id"], "error": category})
        time.sleep(1.2)
    if failures:
        raise SystemExit(f"{failures} documentos pendientes; consultar el estado protegido del bot")


if __name__ == "__main__":
    main()
