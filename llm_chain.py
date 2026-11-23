"""
LLM fallback chain: best cloud models first, local Ollama models last.

Every agent call goes through FallbackLLM.invoke(). It tries each model in
order and moves to the next one when a model fails (rate limit, request too
large, network error, Ollama not running...). Default order:

  1. Groq  openai/gpt-oss-120b   - best quality
  2. Groq  openai/gpt-oss-20b    - fast; has its own separate rate limit
  3. Groq  qwen/qwen3.8-27b      - fast; has its own separate rate limit
  4. Ollama qwen3:8b             - local, slower, works offline
  5. Ollama llama3.2:3b          - local, fast, weakest

Configure in .env (comma-separated, in order):
  GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b
  OLLAMA_MODELS=qwen3:8b,llama3.2:3b
  OLLAMA_BASE_URL=http://localhost:11434
Set either list to empty (e.g. OLLAMA_MODELS=) to turn that provider off.
"""

import os
import threading
import time
from typing import Any

from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent / ".env")

DEFAULT_GROQ_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b"
DEFAULT_OLLAMA_MODELS = "qwen3:8b,llama3.2:3b"

# After a rate-limit error, skip that model for this many seconds instead of
# waiting on it, so the next model answers immediately.
RATE_LIMIT_COOLDOWN_SECONDS = 30

# Default answer length. Longer agents (draft, final plan) ask for more.
DEFAULT_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", os.getenv("GROQ_MAX_TOKENS", "2500")))


def _model_list(name: str, default: str) -> list[str]:
    raw = os.getenv(name)
    if raw is None:
        # Backward compatible: a single GROQ_MODEL still works.
        if name == "GROQ_MODELS" and os.getenv("GROQ_MODEL"):
            raw = os.getenv("GROQ_MODEL", "")
        else:
            raw = default
    return [item.strip() for item in raw.split(",") if item.strip()]


GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODELS = _model_list("GROQ_MODELS", DEFAULT_GROQ_MODELS) if GROQ_API_KEY else []
OLLAMA_MODELS = _model_list("OLLAMA_MODELS", DEFAULT_OLLAMA_MODELS)
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

if not GROQ_MODELS and not OLLAMA_MODELS:
    raise RuntimeError(
        "No LLM configured. Add GROQ_API_KEY to .env, or install Ollama and "
        "set OLLAMA_MODELS (e.g. OLLAMA_MODELS=qwen3:8b)."
    )


def _groq_model(model: str, max_tokens: int):
    from langchain_groq import ChatGroq

    options: dict[str, Any] = {}
    if "gpt-oss" in model:
        options["reasoning_effort"] = "low"  # keep hidden "thinking" short
    elif "qwen" in model or "deepseek" in model:
        options["reasoning_format"] = "hidden"  # no <think> text in answers

    return ChatGroq(
        model=model,
        api_key=GROQ_API_KEY,
        max_tokens=max_tokens,
        max_retries=0,  # fall through to the next model instead of waiting
        **options,
    )


def _ollama_model(model: str, max_tokens: int):
    from langchain_ollama import ChatOllama

    options: dict[str, Any] = {}
    if model.startswith(("qwen3", "deepseek-r1", "gpt-oss")):
        options["reasoning"] = False  # answer directly, no <think> text

    return ChatOllama(
        model=model,
        base_url=OLLAMA_BASE_URL,
        num_ctx=8192,  # our prompts + answers need more than the 4k default
        num_predict=max_tokens,
        **options,
    )


def chain_labels() -> list[str]:
    return [f"groq:{m}" for m in GROQ_MODELS] + [f"ollama:{m}" for m in OLLAMA_MODELS]


_cooldown_until: dict[str, float] = {}
_cooldown_lock = threading.Lock()


def _is_rate_limit(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    text = str(exc).lower()
    return status == 429 or "rate limit" in text or "rate_limit" in text


def _short_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {' '.join(str(exc).split())[:160]}"


class FallbackLLM:
    """Drop-in replacement for a chat model's .invoke() / .bind(max_tokens=...)."""

    def __init__(self, max_tokens: int = DEFAULT_MAX_TOKENS):
        self.max_tokens = max_tokens
        self._models: list[tuple[str, Any]] | None = None

    def _chain(self) -> list[tuple[str, Any]]:
        if self._models is None:
            models = [(f"groq:{m}", _groq_model(m, self.max_tokens)) for m in GROQ_MODELS]
            models += [(f"ollama:{m}", _ollama_model(m, self.max_tokens)) for m in OLLAMA_MODELS]
            self._models = models
        return self._models

    def bind(self, max_tokens: int | None = None, **_: Any) -> "FallbackLLM":
        return _llm_for(max_tokens or self.max_tokens)

    def invoke(self, messages: Any, **_: Any):
        errors: list[str] = []
        chain = self._chain()

        for position, (label, model) in enumerate(chain):
            is_last = position == len(chain) - 1
            with _cooldown_lock:
                cooling = _cooldown_until.get(label, 0) > time.time()
            if cooling and not is_last:
                errors.append(f"{label}: skipped (rate-limited recently)")
                continue

            try:
                response = model.invoke(messages)
            except Exception as exc:
                errors.append(f"{label}: {_short_error(exc)}")
                if _is_rate_limit(exc):
                    with _cooldown_lock:
                        _cooldown_until[label] = time.time() + RATE_LIMIT_COOLDOWN_SECONDS
                print(f"LLM {label} failed, trying next model -> {_short_error(exc)}", flush=True)
                continue

            if not str(response.content).strip():
                errors.append(f"{label}: empty answer")
                print(f"LLM {label} returned an empty answer, trying next model", flush=True)
                continue

            response.response_metadata["answered_by"] = label
            if position > 0:
                print(f"LLM answered by {label} (fallback #{position})", flush=True)
            return response

        raise RuntimeError("All LLMs failed:\n" + "\n".join(errors))


_instances: dict[int, FallbackLLM] = {}
_instances_lock = threading.Lock()


def _llm_for(max_tokens: int) -> FallbackLLM:
    with _instances_lock:
        if max_tokens not in _instances:
            _instances[max_tokens] = FallbackLLM(max_tokens)
        return _instances[max_tokens]


def make_llm() -> FallbackLLM:
    return _llm_for(DEFAULT_MAX_TOKENS)
