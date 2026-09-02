import base64
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import gen
from atlas_provider import DEFAULT_MODEL, request_image


def response(payload):
    return FakeResponse(json.dumps(payload).encode("utf-8"))


def schema():
    return {
        "paths": {
            "/api/v1/model/generateImage": {"x-api-name": "model_run"},
            "/api/v1/model/prediction/{request_id}": {"x-api-name": "model_result"},
        },
        "components": {
            "schemas": {
                "Input": {
                    "required": ["model", "prompt"],
                    "properties": {
                        "model": {"type": "string"},
                        "prompt": {"type": "string"},
                        "size": {"type": "string"},
                        "output_format": {"enum": ["jpeg", "png"]},
                    },
                }
            }
        },
    }


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeOpener:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, request, **kwargs):
        self.calls.append((request, kwargs))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def discovery_results(*remaining):
    return (
        response(
            {
                "data": [
                    {
                        "model": DEFAULT_MODEL,
                        "schema": "https://schema.test/model.json",
                    }
                ]
            }
        ),
        response(schema()),
        *remaining,
    )


class AtlasProviderTests(unittest.TestCase):
    def test_discovers_schema_submits_once_and_polls_result(self):
        opener = FakeOpener(
            *discovery_results(
                response({"data": {"id": "pred-1", "status": "processing"}}),
                response(
                    {
                        "data": {
                            "id": "pred-1",
                            "status": "completed",
                            "outputs": ["https://cdn.test/image.png"],
                        }
                    }
                ),
            )
        )

        image_url = request_image(
            "atlas-test",
            "a lighthouse",
            DEFAULT_MODEL,
            "1024x1024",
            "png",
            opener=opener,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(image_url, "https://cdn.test/image.png")
        post_calls = [call for call in opener.calls if call[0].get_method() == "POST"]
        self.assertEqual(len(post_calls), 1)
        payload = json.loads(post_calls[0][0].data.decode("utf-8"))
        self.assertEqual(payload["size"], "1024*1024")

    def test_generation_post_failure_is_not_retried(self):
        opener = FakeOpener(
            *discovery_results(urllib.error.URLError("connection lost"))
        )

        with self.assertRaises(urllib.error.URLError):
            request_image(
                "atlas-test",
                "a lighthouse",
                DEFAULT_MODEL,
                "1024x1024",
                "png",
                opener=opener,
            )

        post_calls = [call for call in opener.calls if call[0].get_method() == "POST"]
        self.assertEqual(len(post_calls), 1)

    def test_transient_prediction_get_is_retried(self):
        transient = urllib.error.HTTPError(
            "https://api.atlascloud.ai/prediction/pred-2",
            503,
            "Service Unavailable",
            {},
            io.BytesIO(),
        )
        opener = FakeOpener(
            *discovery_results(
                response({"data": {"id": "pred-2", "status": "processing"}}),
                transient,
                response(
                    {
                        "data": {
                            "id": "pred-2",
                            "status": "completed",
                            "outputs": ["https://cdn.test/image.png"],
                        }
                    }
                ),
            )
        )
        sleep = mock.Mock()

        request_image(
            "atlas-test",
            "a lighthouse",
            DEFAULT_MODEL,
            "1024x1024",
            "png",
            opener=opener,
            sleep=sleep,
        )

        sleep.assert_called_once_with(2.0)
        post_calls = [call for call in opener.calls if call[0].get_method() == "POST"]
        self.assertEqual(len(post_calls), 1)

    def test_invalid_output_format_fails_before_generation_post(self):
        opener = FakeOpener(*discovery_results())

        with self.assertRaisesRegex(ValueError, "Invalid 'output_format'"):
            request_image(
                "atlas-test",
                "a lighthouse",
                DEFAULT_MODEL,
                "1024x1024",
                "webp",
                opener=opener,
            )

        self.assertFalse(any(call[0].get_method() == "POST" for call in opener.calls))


class ProviderSelectionTests(unittest.TestCase):
    def test_openai_remains_the_default_provider_and_model(self):
        png = b"\x89PNG\r\n\x1a\nimage-data"
        with tempfile.TemporaryDirectory() as directory:
            with (
                mock.patch.dict(os.environ, {"OPENAI_API_KEY": "openai-test"}),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "gen.py",
                        "--prompt",
                        "a lighthouse",
                        "--count",
                        "1",
                        "--out-dir",
                        directory,
                    ],
                ),
                mock.patch.object(
                    gen,
                    "request_images",
                    return_value={
                        "data": [{"b64_json": base64.b64encode(png).decode("ascii")}]
                    },
                ) as request_images,
            ):
                exit_code = gen.main()

            self.assertEqual(exit_code, 0)
            self.assertEqual(request_images.call_args.args[2], "gpt-image-1")
            self.assertTrue((Path(directory) / "index.html").is_file())


if __name__ == "__main__":
    unittest.main()
