"""Helpers for provider API URLs."""

KNOWN_ENDPOINT_SUFFIXES = (
    "/images/generations",
    "/images/edits",
    "/images/variations",
    "/chat/completions",
    "/contents/generations/tasks",
    "/embeddings",
)


def normalize_provider_base_url(url: str | None) -> str:
    """Strip a pasted endpoint path so clients can append it themselves.

    A full endpoint such as ``.../api/v3/images/generations`` used as the
    OpenAI SDK base_url becomes ``.../images/generations/images/generations``.
    """
    normalized = str(url or "").strip().rstrip("/")
    stripped = True
    while stripped:
        stripped = False
        lowered = normalized.lower()
        for suffix in KNOWN_ENDPOINT_SUFFIXES:
            if lowered.endswith(suffix):
                normalized = normalized[: -len(suffix)].rstrip("/")
                stripped = True
                break
    return normalized
