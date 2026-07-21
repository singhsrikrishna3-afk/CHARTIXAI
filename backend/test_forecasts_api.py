"""Test GET /api/forecasts/{symbol} endpoint.
Run directly: python test_forecasts_api.py
Requires: PEESTOCKS_TEST_ADMIN_PASSWORD env var set to a valid admin password
(forecasts data should already exist in peestock.db from a prior training run).
"""
import os
from fastapi.testclient import TestClient
from app.main import app

failures = []

def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"PASS: {label}")

client = TestClient(app)

admin_email = os.environ.get("PEESTOCKS_TEST_ADMIN_EMAIL", "admin@peestocks.com")
admin_password = os.environ.get("PEESTOCKS_TEST_ADMIN_PASSWORD")
if not admin_password:
    print("Set PEESTOCKS_TEST_ADMIN_PASSWORD env var to run this test (no hardcoded passwords).")
    raise SystemExit(1)

login_res = client.post("/api/auth/login", json={"email": admin_email, "password": admin_password})
check("login succeeds", login_res.status_code == 200)
token = login_res.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

# Pick a symbol known to have forecast data from the training run (ADANIPORTS was confirmed earlier)
res = client.get("/api/forecasts/ADANIPORTS", headers=headers)
check("known symbol with forecast data returns 200", res.status_code == 200)
if res.status_code == 200:
    body = res.json()
    check("response has correct symbol", body.get("symbol") == "ADANIPORTS")
    check("response has 'days' list", isinstance(body.get("days"), list))
    check("days list has up to 10 entries", 0 < len(body["days"]) <= 10)
    check("predicted_close values are positive floats", all(d["predicted_close"] > 0 for d in body["days"]))

res_missing = client.get("/api/forecasts/NOTASYMBOL123", headers=headers)
check("unknown symbol returns 404", res_missing.status_code == 404)

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
