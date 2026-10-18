import os
import tempfile

# Every test session gets a fresh database unless DATABASE_URL points somewhere explicit (e.g. Postgres in CI).
os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/test.db")
os.environ.setdefault("ADMIN_TOKEN", "secret")
os.environ.setdefault("TRUST_PROXY", "1")  # tests simulate distinct client networks via X-Forwarded-For

_net = iter(range(1, 10**6))


def other_net() -> dict:
    """Headers for a request from a fresh /24 network (an independent source for crowd confirmation)."""
    n = next(_net)
    return {"X-Forwarded-For": f"10.{n // 250 % 250}.{n % 250}.7"}


from fastapi.testclient import TestClient as _TestClient  # noqa: E402


class NetClient(_TestClient):
    """TestClient whose crowd observations each arrive from a different network (independent sources)."""

    def post(self, url, *args, **kwargs):
        if "/observations" in str(url) and "headers" not in kwargs:
            kwargs["headers"] = other_net()
        return super().post(url, *args, **kwargs)
