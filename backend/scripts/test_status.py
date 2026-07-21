import sys
import os
from fastapi.testclient import TestClient

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.main import app

def test_get_eod():
    client = TestClient(app)
    # Log in
    resp = client.post("/api/auth/login", json={"email": "admin@peestocks.com", "password": "admin123"})
    token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    
    # Get EOD for NIFTY_50
    resp = client.get("/api/instruments/NIFTY_50/eod", headers=headers)
    print("EOD status code:", resp.status_code)
    if resp.status_code == 200:
        data = resp.json()
        print("NIFTY_50 EOD count:", len(data))
        print("Last 5 rows:")
        print(data[-5:])

if __name__ == "__main__":
    test_get_eod()
