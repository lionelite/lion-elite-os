import json
import os
from urllib import request

QUEUE_FILE = os.getenv("MARKETING_QUEUE_FILE", "/data/marketing_queue.json")
PUBLISH_WEBHOOK_URL = os.getenv("PUBLISH_WEBHOOK_URL", "")
AUTO_PUBLISH = os.getenv("AUTO_PUBLISH", "false").lower() == "true"


def post_json(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def publish_approved():
    if not AUTO_PUBLISH or not PUBLISH_WEBHOOK_URL or not os.path.exists(QUEUE_FILE):
        return 0

    with open(QUEUE_FILE, "r", encoding="utf-8") as f:
        queue = json.load(f)

    published = 0
    for item in queue:
        result = item.get("result") or {}
        qa = result.get("qa") or {}
        if item.get("status") != "approved":
            continue
        if not qa.get("publish_ready"):
            continue
        if int(qa.get("score", 0)) < 90:
            continue
        if not all((qa.get("gates") or {}).values()):
            continue

        payload = {
            "asset": result.get("asset"),
            "quality": qa,
            "revision_count": result.get("revision_count", 0),
            "source": "lion-elite-marketing-intelligence",
        }
        publisher_result = post_json(PUBLISH_WEBHOOK_URL, payload)
        item["status"] = "published"
        item["publisher_result"] = publisher_result
        published += 1

    if published:
        with open(QUEUE_FILE + ".tmp", "w", encoding="utf-8") as f:
            json.dump(queue, f, indent=2)
        os.replace(QUEUE_FILE + ".tmp", QUEUE_FILE)
    return published


if __name__ == "__main__":
    print(json.dumps({"published": publish_approved()}))
