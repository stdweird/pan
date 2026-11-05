"""Open a dependency trace in the adjacent viewer over protected loopback HTTP."""

import argparse
import logging
import os
import secrets
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO, cast
from urllib.parse import quote

LOGGER = logging.getLogger("depviewer")
CHUNK_SIZE = 64 * 1024


def make_handler(page: Path, trace: Path, token: str) -> type[BaseHTTPRequestHandler]:
    """Build a handler exposing exactly two files under a secret route prefix."""

    class ViewerHandler(BaseHTTPRequestHandler):
        """Serve allowlisted assets while enforcing the loopback origin boundary."""

        def log_message(self, format: str, *args: object) -> None:
            """Suppress HTTP logs, which otherwise expose the secret route token."""

        def do_GET(self) -> None:
            """Validate request metadata and stream the selected asset unchanged."""
            host = f"127.0.0.1:{cast(ThreadingHTTPServer, self.server).server_port}"
            if (
                self.headers.get_all("Host") != [host]
                or self.headers.get_all("Origin", [f"http://{host}"])
                != [f"http://{host}"]
                or self.headers.get_all("Sec-Fetch-Site", ["same-origin"])
                not in (["same-origin"], ["none"])
            ):
                self.send_error(403)
                return
            if self.path == f"/{token}/depviewer.html":
                asset, content_type = page, "text/html; charset=utf-8"
            elif self.path == f"/{token}/trace":
                asset, content_type = trace, "application/octet-stream"
            else:
                self.send_error(404)
                return
            try:
                with asset.open("rb") as source:
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header(
                        "Content-Length", str(os.fstat(source.fileno()).st_size)
                    )
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    self.stream(source)
            except (BrokenPipeError, ConnectionResetError):
                LOGGER.debug("Viewer client disconnected during asset transfer")
            except OSError as error:
                LOGGER.error("Viewer asset transfer failed (%s)", type(error).__name__)
                self.close_connection = True

        def stream(self, source: BinaryIO) -> None:
            """Copy an asset in bounded chunks without decoding gzip input."""
            while chunk := source.read(CHUNK_SIZE):
                self.wfile.write(chunk)

        def do_POST(self) -> None:
            """Reject unsupported methods without reading request bodies."""
            self.send_error(405)
            self.close_connection = True

        do_HEAD = do_POST
        do_PUT = do_POST
        do_DELETE = do_POST
        do_OPTIONS = do_POST
        do_PATCH = do_POST

    return ViewerHandler


def main() -> int:
    """Validate the trace, launch the browser, and serve until interrupted."""
    logging.basicConfig(level=logging.INFO, format="depviewer: %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "trace", type=Path, help="trace.depx.json or trace.depx.json.gz"
    )
    args = parser.parse_args()
    trace: Path = args.trace
    if not trace.name.endswith((".depx.json", ".depx.json.gz")):
        parser.error("trace must end in .depx.json or .depx.json.gz")
    page = Path(__file__).resolve().with_name("depviewer.html")
    for asset, label in ((trace, "trace"), (page, "viewer page")):
        try:
            if not asset.is_file():
                parser.error(f"{label} is missing or is not a regular file")
            with asset.open("rb"):
                pass
        except OSError:
            parser.error(f"{label} is not readable")
    token = secrets.token_urlsafe(32)
    try:
        with ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(page, trace, token)
        ) as server:
            LOGGER.info("Viewer server started on loopback port %s", server.server_port)
            url = (
                f"http://127.0.0.1:{server.server_port}/{token}/depviewer.html"
                f"#filename={quote(trace.name, safe='')}"
            )
            try:
                subprocess.run(
                    ["xdg-open", url],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except (OSError, subprocess.CalledProcessError) as error:
                LOGGER.error(
                    "Browser launch failed (%s); check xdg-open and your desktop browser",
                    type(error).__name__,
                )
                return 1
            LOGGER.info("Browser launched; press Ctrl+C to stop the viewer")
            server.serve_forever()
    except KeyboardInterrupt:
        return 0
    except OSError as error:
        LOGGER.error("Viewer server failed (%s)", type(error).__name__)
        return 1
    finally:
        LOGGER.info("Viewer server shutdown")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
