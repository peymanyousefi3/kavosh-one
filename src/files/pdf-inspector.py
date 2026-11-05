"""Read-only unsigned-source screen, not a renderer, antivirus or safety proof.

Only stdin bytes enter; only bounded structural metadata leaves. Never save,
repair, flatten, execute actions, fetch URLs, or expose document text/warnings.
qpdf syntax checks do NOT establish semantic correctness or safe rendering:
https://pikepdf.readthedocs.io/en/latest/api/main.html#pikepdf.Pdf.check_pdf_syntax
Known active features below follow the upstream PDF sanitization guidance, but
are REJECTED here rather than silently rewriting legally reviewed bytes:
https://pikepdf.readthedocs.io/en/latest/topics/sanitize.html
This killable process still requires independent OS/container isolation.
"""
import hashlib
import io
import json
import math
import resource
import sys
from decimal import Decimal
from urllib.parse import unquote, urlsplit

if sys.platform == "linux":
    resource.setrlimit(resource.RLIMIT_AS, (536870912, 536870912))
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))

import pikepdf

if pikepdf.__version__ != "10.17.0" or pikepdf.__libqpdf_version__ != "12.4.2":
    sys.exit(1)

MAX_BYTES, MAX_PAGES, MAX_OBJECTS, MAX_DEPTH = 10485760, 1000, 50000, 64
BLOCKED_ACTIONS = {
    "/JavaScript", "/Launch", "/GoToR", "/GoToE", "/SubmitForm", "/ImportData",
    "/ResetForm", "/Hide", "/SetOCGState", "/Rendition", "/Movie", "/Sound",
    "/RichMediaExecute", "/GoTo3DView", "/Thread", "/Named", "/Trans",
}
BLOCKED_ANNOTATIONS = {"/FileAttachment", "/RichMedia", "/Movie", "/Sound", "/Screen", "/3D"}


class Rejected(Exception):
    pass


def reject(reason):
    raise Rejected(reason)


def name(obj, key):
    value = obj.get(key)
    # Never stringify arbitrary attacker-controlled dictionaries/arrays just to
    # compare a PDF name; that can recursively expand a large shared graph.
    return str(value) if isinstance(value, pikepdf.Name) else None


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        reject("GEOMETRY_INVALID")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        reject("GEOMETRY_INVALID")
    if not math.isfinite(result):
        reject("GEOMETRY_INVALID")
    return result


def box(value):
    if not isinstance(value, pikepdf.Array) or len(value) != 4:
        reject("GEOMETRY_INVALID")
    values = [number(v) for v in value]
    if any(abs(v) > 20000 for v in values) or values[0] >= values[2] or values[1] >= values[3]:
        reject("GEOMETRY_INVALID")
    return values


def link(value):
    if not isinstance(value, pikepdf.String):
        reject("ACTIVE_CONTENT")
    value = str(value)
    if not value or len(value) > 2048 or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        reject("ACTIVE_CONTENT")
    try:
        decoded = unquote(value, errors="strict")
        if "\\" in decoded or any(ord(c) < 32 or ord(c) == 127 for c in decoded):
            reject("ACTIVE_CONTENT")
        parsed = urlsplit(value)
        if parsed.scheme in ("https", "http") and parsed.hostname and parsed.username is None and parsed.password is None:
            return
        if parsed.scheme in ("mailto", "tel") and parsed.path and not parsed.netloc and not parsed.query and not parsed.fragment:
            return
    except ValueError:
        pass
    reject("ACTIVE_CONTENT")


def screen(pdf):
    if pdf.is_encrypted:
        reject("ENCRYPTED")
    count = len(pdf.pages)
    if count < 1 or count > MAX_PAGES:
        reject("PAGE_LIMIT")
    if len(pdf.objects) > MAX_OBJECTS:
        reject("STRUCTURE_LIMIT")
    root = pdf.Root
    if root.get("/Collection") is not None:
        reject("EMBEDDED_FILE")
    names = root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and names.get("/JavaScript") is not None:
        reject("ACTIVE_CONTENT")
    opening = root.get("/OpenAction")
    if opening is not None and not isinstance(opening, pikepdf.Array):
        if not isinstance(opening, pikepdf.Dictionary) or name(opening, "/S") != "/GoTo":
            reject("ACTIVE_CONTENT")
    # ObjectSet tracks BOTH direct and indirect object identity correctly. Do not
    # deduplicate on objgen: all direct objects have the same (0,0) pair.
    # Scan unreferenced objects too; do not assume another viewer ignores them.
    seen, stack, visited = pikepdf.ObjectSet(), [(pdf.trailer, 0)], 0
    for top in pdf.objects:
        stack.append((top, 0))
    while stack:
        obj, depth = stack.pop()
        visited += 1
        if visited > MAX_OBJECTS:
            reject("STRUCTURE_LIMIT")
        if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)) or not seen.add(obj):
            continue
        if depth > MAX_DEPTH:
            reject("STRUCTURE_LIMIT")
        if isinstance(obj, pikepdf.Array):
            for value in obj:
                if visited + len(stack) >= MAX_OBJECTS:
                    reject("STRUCTURE_LIMIT")
                stack.append((value, depth + 1))
            continue
        kind, action = name(obj, "/Type"), name(obj, "/S")
        if kind == "/Sig" or ("/ByteRange" in obj and "/Contents" in obj):
            reject("EXISTING_SIGNATURE")
        if kind in ("/Filespec", "/EmbeddedFile") or "/EF" in obj or name(obj, "/Subtype") in BLOCKED_ANNOTATIONS:
            reject("EMBEDDED_FILE")
        if "/XFA" in obj:
            reject("XFA_FORM")
        if "/AA" in obj or action in BLOCKED_ACTIONS or (kind == "/Action" and action not in ("/GoTo", "/URI")):
            reject("ACTIVE_CONTENT")
        if action in ("/GoTo", "/URI") and "/Next" in obj:
            reject("ACTIVE_CONTENT")
        if action == "/URI":
            link(obj.get("/URI"))
        if isinstance(obj, pikepdf.Stream) and any(k in obj for k in ("/F", "/FFilter", "/FDecodeParms")):
            reject("EXTERNAL_STREAM")
        for _, value in obj.items():
            if visited + len(stack) >= MAX_OBJECTS:
                reject("STRUCTURE_LIMIT")
            stack.append((value, depth + 1))
    pages = []
    for page in pdf.pages:
        media, crop = box(page.mediabox), box(page.cropbox)
        unit, rotation = number(page.obj.get("/UserUnit", 1)), number(page.obj.get("/Rotate", 0))
        if unit <= 0 or unit > 75000 or rotation % 90 or any((b - a) * unit > 20000 for a, b in ((media[0], media[2]), (media[1], media[3]))):
            reject("GEOMETRY_INVALID")
        if crop[0] < media[0] or crop[1] < media[1] or crop[2] > media[2] or crop[3] > media[3]:
            reject("GEOMETRY_INVALID")
        pages.append({"mediaBox": media, "cropBox": crop, "rotation": int(rotation % 360), "userUnit": unit})
    if pdf.get_warnings() or pdf.check_pdf_syntax():
        reject("MALFORMED_PDF")
    return {"outcome": "screened", "pageCount": count, "objectCount": visited, "pages": pages,
            "interactiveForms": root.get("/AcroForm") is not None, "coordinateSpace": "pdf-default-user-space"}


data = sys.stdin.buffer.read(MAX_BYTES + 1)
if not data or len(data) > MAX_BYTES:
    sys.exit(1)
result = {"validator": "pikepdf@10.17.0", "qpdf": "12.4.2", "policyVersion": 1,
          "inputBytes": len(data), "inputSha256": hashlib.sha256(data).hexdigest(),
          "maximumPages": MAX_PAGES, "maximumObjects": MAX_OBJECTS, "maximumDepth": MAX_DEPTH}
try:
    # No file paths, passwords, external resources or automatic recovery.
    with pikepdf.Pdf.open(io.BytesIO(data), attempt_recovery=False, suppress_warnings=True) as pdf:
        result.update(screen(pdf))
except pikepdf.PasswordError:
    result.update(outcome="rejected", reason="ENCRYPTED")
except Rejected as error:
    result.update(outcome="rejected", reason=str(error))
except pikepdf.PdfError:
    result.update(outcome="rejected", reason="MALFORMED_PDF")
except MemoryError:
    result.update(outcome="rejected", reason="STRUCTURE_LIMIT")
except Exception:
    sys.exit(1)
usage = resource.getrusage(resource.RUSAGE_SELF)
result["resources"] = {"peakRssKiB": max(1, math.ceil(usage.ru_maxrss / (1024 if sys.platform == "darwin" else 1))),
                       "userCpuMicros": int(usage.ru_utime * 1000000), "systemCpuMicros": int(usage.ru_stime * 1000000)}
sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")))
