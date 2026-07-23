import base64
import json
import os
from pathlib import Path
from urllib import parse, request

GMAIL_TOKEN = os.getenv("GMAIL_ACCESS_TOKEN", "")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_REPO = os.getenv("GITHUB_REPO", "lionelite/lion-elite-os")
GITHUB_BRANCH = os.getenv("GITHUB_BRANCH", "marketing/autonomous-quality-loop")
SOURCE_FILE = Path(__file__).with_name("vial_asset_sources.json")
MANIFEST_PATH = "assets/vials/manifest.json"


def gmail_get(url: str) -> dict:
    if not GMAIL_TOKEN:
        raise RuntimeError("GMAIL_ACCESS_TOKEN is missing")
    req = request.Request(url, headers={"Authorization": f"Bearer {GMAIL_TOKEN}"})
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def github_api(method: str, path: str, body: dict | None = None) -> dict:
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN is missing")
    data = json.dumps(body).encode() if body else None
    req = request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        if getattr(exc, "code", None) == 404:
            return {}
        raise


def github_put_file(path: str, raw: bytes, message: str) -> str:
    current = github_api("GET", f"/contents/{parse.quote(path)}?ref={parse.quote(GITHUB_BRANCH)}")
    payload = {
        "message": message,
        "content": base64.b64encode(raw).decode(),
        "branch": GITHUB_BRANCH,
    }
    if current.get("sha"):
        payload["sha"] = current["sha"]
    result = github_api("PUT", f"/contents/{parse.quote(path)}", payload)
    return result.get("content", {}).get("html_url", "")


def get_message(message_id: str) -> dict:
    return gmail_get(
        f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}?format=full"
    )


def attachment_parts(payload: dict):
    stack = [payload]
    while stack:
        part = stack.pop()
        stack.extend(part.get("parts", []))
        filename = part.get("filename") or ""
        body = part.get("body") or {}
        if filename and body.get("attachmentId"):
            yield filename, part.get("mimeType", "application/octet-stream"), body["attachmentId"]


def download_attachment(message_id: str, attachment_id: str) -> bytes:
    data = gmail_get(
        f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}/attachments/{attachment_id}"
    )
    encoded = data.get("data", "")
    if not encoded:
        raise RuntimeError(f"No attachment data for {attachment_id}")
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in name)


def run() -> dict:
    sources = json.loads(SOURCE_FILE.read_text())
    manifest = {"assets": [], "rules": sources["rules"]}

    for source in sources["gmail_sources"]:
        message_id = source.get("message_id")
        if not message_id:
            continue
        message = get_message(message_id)
        allowed = set(source.get("attachments", []))
        for filename, mime_type, attachment_id in attachment_parts(message.get("payload", {})):
            if allowed and filename not in allowed:
                continue
            if not (mime_type.startswith("image/") or mime_type.startswith("video/")):
                continue
            raw = download_attachment(message_id, attachment_id)
            path = f"assets/vials/inbox/{message_id}/{safe_name(filename)}"
            html_url = github_put_file(path, raw, f"Sync vial asset {filename} from Gmail")
            manifest["assets"].append({
                "source_subject": source["subject"],
                "source_message_id": message_id,
                "filename": filename,
                "mime_type": mime_type,
                "github_path": path,
                "github_url": html_url,
                "product_name": None,
                "quantity": None,
                "approved": False,
                "needs_product_mapping": True,
            })

    github_put_file(
        MANIFEST_PATH,
        json.dumps(manifest, indent=2).encode(),
        "Update vial asset manifest from Gmail",
    )
    return manifest


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
