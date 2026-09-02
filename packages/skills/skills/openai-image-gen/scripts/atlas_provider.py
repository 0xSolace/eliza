"""Atlas Cloud adapter for the openai-image-gen skill."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

API_BASE_URL = "https://api.atlascloud.ai"
CATALOG_URL = f"{API_BASE_URL}/api/v1/models"
DEFAULT_MODEL = "black-forest-labs/flux-2-pro/text-to-image"
SUCCESS_STATUSES = {"completed", "succeeded"}
FAILURE_STATUSES = {"failed", "canceled", "cancelled"}
TRANSIENT_STATUS_CODES = {408, 429, 500, 502, 503, 504}


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, dict) and isinstance(payload.get("data"), (dict, list)):
        return payload["data"]
    return payload


def _read_json(response: Any) -> Any:
    return json.loads(response.read().decode("utf-8"))


def _validate(schema: dict[str, Any], payload: dict[str, Any]) -> None:
    input_schema = schema.get("components", {}).get("schemas", {}).get("Input", {})
    properties = input_schema.get("properties", {})
    unsupported = sorted(set(payload) - set(properties))
    if unsupported:
        raise ValueError(f"Unsupported Atlas input fields: {', '.join(unsupported)}")

    missing = [
        field for field in input_schema.get("required", []) if field not in payload
    ]
    if missing:
        raise ValueError(f"Missing Atlas input fields: {', '.join(missing)}")

    for field, value in payload.items():
        choices = properties.get(field, {}).get("enum")
        if choices and value not in choices:
            raise ValueError(
                f"Invalid {field!r}; expected one of: {', '.join(map(str, choices))}"
            )


def _discover(
    model: str,
    *,
    opener: Callable[..., Any],
    timeout: float,
    headers: dict[str, str],
) -> tuple[str, str, dict[str, Any]]:
    catalog_request = urllib.request.Request(CATALOG_URL, headers=headers)
    with opener(catalog_request, timeout=timeout) as response:
        catalog = _unwrap(_read_json(response))
    model_info = next((item for item in catalog if item.get("model") == model), None)
    if not model_info:
        raise ValueError(f"Atlas Cloud model is not available: {model}")

    schema_request = urllib.request.Request(model_info["schema"], headers=headers)
    with opener(schema_request, timeout=timeout) as response:
        schema = _read_json(response)

    run_path = None
    result_path = None
    for path, operations in schema.get("paths", {}).items():
        if operations.get("x-api-name") == "model_run":
            run_path = path
        elif operations.get("x-api-name") == "model_result":
            result_path = path
    if not run_path or not result_path:
        raise ValueError("Atlas schema is missing model_run or model_result")
    return run_path, result_path, schema


def _poll(
    url: str,
    *,
    headers: dict[str, str],
    opener: Callable[..., Any],
    sleep: Callable[[float], None],
    poll_interval: float,
    max_polls: int,
    timeout: float,
) -> dict[str, Any]:
    for attempt in range(max_polls):
        request = urllib.request.Request(url, headers=headers)
        try:
            with opener(request, timeout=timeout) as response:
                prediction = _unwrap(_read_json(response))
        except urllib.error.HTTPError as exc:
            if exc.code not in TRANSIENT_STATUS_CODES or attempt + 1 >= max_polls:
                raise
            sleep(min(poll_interval * (2**attempt), 10.0))
            continue
        except urllib.error.URLError:
            if attempt + 1 >= max_polls:
                raise
            sleep(min(poll_interval * (2**attempt), 10.0))
            continue

        status = str(prediction.get("status") or "").lower()
        if status in SUCCESS_STATUSES:
            return prediction
        if status in FAILURE_STATUSES:
            detail = prediction.get("error") or prediction.get("message") or status
            raise RuntimeError(f"Atlas Cloud generation failed: {detail}")
        if attempt + 1 < max_polls:
            sleep(min(poll_interval * (2**attempt), 10.0))

    raise TimeoutError(f"Atlas prediction did not complete after {max_polls} polls")


def request_image(
    api_key: str,
    prompt: str,
    model: str,
    size: str,
    output_format: str,
    *,
    poll_interval: float = 2.0,
    max_polls: int = 60,
    timeout: float = 60,
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Submit once to Atlas Cloud and return the completed image URL."""
    if not api_key:
        raise ValueError("ATLASCLOUD_API_KEY is required for the Atlas provider")

    public_headers = {
        "Accept": "application/json",
        "User-Agent": "eliza-openai-image-gen/1.0",
    }
    run_path, result_path, schema = _discover(
        model,
        opener=opener,
        timeout=timeout,
        headers=public_headers,
    )
    payload = {
        "model": model,
        "prompt": prompt,
        "size": size.replace("x", "*"),
        "output_format": output_format,
    }
    _validate(schema, payload)

    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{API_BASE_URL}{run_path}",
        method="POST",
        headers={
            **public_headers,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=body,
    )
    # Generation may be billable, so this POST is intentionally never retried.
    with opener(request, timeout=timeout) as response:
        prediction = _unwrap(_read_json(response))

    prediction_id = prediction.get("id")
    if not prediction_id:
        raise RuntimeError("Atlas Cloud response did not include a prediction id")

    auth_headers = {**public_headers, "Authorization": f"Bearer {api_key}"}
    if str(prediction.get("status") or "").lower() not in SUCCESS_STATUSES:
        encoded_id = quote(str(prediction_id), safe="")
        result_url = f"{API_BASE_URL}{result_path.replace('{request_id}', encoded_id)}"
        prediction = _poll(
            result_url,
            headers=auth_headers,
            opener=opener,
            sleep=sleep,
            poll_interval=poll_interval,
            max_polls=max_polls,
            timeout=timeout,
        )

    outputs = prediction.get("outputs") or []
    if (
        not outputs
        or not isinstance(outputs[0], str)
        or not outputs[0].startswith("https://")
    ):
        raise RuntimeError("Atlas Cloud completed without an HTTPS image output")
    return outputs[0]
