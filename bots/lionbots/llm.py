"""One place every bot calls Claude from.

Optional by design: without the `anthropic` package or credentials the bots
that need it return `blocked` naming what is missing, and every other bot
keeps working.
"""

from __future__ import annotations

import os
from typing import Any

from .bot import BotError

MODEL = os.getenv("LIONBOTS_MODEL", "claude-opus-5-5")
EFFORT = os.getenv("LIONBOTS_EFFORT", "medium")


class LLMUnavailable(Exception):
    def __init__(self, reason: str, gate: str):
        super().__init__(reason)
        self.reason, self.gate = reason, gate


class LLMRefused(Exception):
    pass


_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    try:
        import anthropic
    except ImportError as exc:
        raise LLMUnavailable("the anthropic package is not installed", "pip install -r bots/requirements.txt") from exc
    try:
        # Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
        _client = anthropic.Anthropic()
    except anthropic.AnthropicError as exc:
        raise LLMUnavailable(f"no Anthropic credentials: {exc}", "ANTHROPIC_API_KEY or `ant auth login`") from exc
    return _client


def ask(prompt: str, *, system: str | None = None, schema: dict | None = None,
        max_tokens: int = 16000, effort: str | None = None) -> dict[str, Any]:
    """Return {'text', 'json' (when schema given), 'model', 'usage'}."""
    client = _get_client()  # raises LLMUnavailable before anything else can fail
    import anthropic
    output_config: dict[str, Any] = {"effort": effort or EFFORT}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs: dict[str, Any] = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
        "output_config": output_config,
        # Server-side fallback: if the model declines on policy grounds, the API
        # retries on a suitable model inside the same call.
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    }
    if system:
        kwargs["system"] = system
    try:
        resp = client.beta.messages.create(**kwargs)
    except TypeError as exc:
        # The SDK resolves credentials lazily and raises TypeError at request time.
        if "authentication" in str(exc).lower():
            raise LLMUnavailable("no Anthropic credentials found",
                                 "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or `ant auth login`") from exc
        raise
    except anthropic.AuthenticationError as exc:
        raise LLMUnavailable("Anthropic rejected the credentials", "ANTHROPIC_API_KEY") from exc
    except anthropic.PermissionDeniedError as exc:
        raise LLMUnavailable(f"credentials lack access: {exc.message}", "Anthropic workspace permissions") from exc
    except anthropic.BadRequestError:
        raise
    except (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError) as exc:
        raise BotError(f"Claude temporarily unavailable: {exc}") from exc

    if resp.stop_reason == "refusal":
        details = getattr(resp, "stop_details", None)
        raise LLMRefused(getattr(details, "explanation", None) or "the model declined this request")
    text = "".join(b.text for b in resp.content if b.type == "text")
    out = {"text": text, "model": resp.model,
           "usage": {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}}
    if resp.stop_reason == "max_tokens":
        out["truncated"] = True
    if schema:
        import json
        try:
            out["json"] = json.loads(text)
        except json.JSONDecodeError as exc:
            raise BotError(f"model returned invalid JSON: {exc}") from exc
    return out
