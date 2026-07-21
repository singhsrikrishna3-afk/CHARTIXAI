import sys
import os
from fastapi.testclient import TestClient

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.main import app

def test_sync():
    client = TestClient(app)
    # Log in
    resp = client.post("/api/auth/login", json={"email": "admin@peestocks.com", "password": "admin123"})
    print("Login status:", resp.status_code)
    print("Login response:", resp.json())
    if resp.status_code != 200:
        return
    token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    
    # Post to sync
    resp = client.post("/api/instruments/sync", headers=headers)
    print("Sync status:", resp.status_code)
    print("Sync response:", resp.json())

if __name__ == "__main__":
    test_sync()
