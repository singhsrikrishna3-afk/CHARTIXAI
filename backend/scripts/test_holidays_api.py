"""PEESTOCK — Test holiday API endpoints using FastAPI TestClient."""

import os
import sys
from fastapi.testclient import TestClient

# Add backend directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.main import app
from app.auth import get_current_user
from app.models.models import User

# Mock authentication to return a dummy admin user
dummy_user = User(email="admin@peestocks.com", is_admin=True)
app.dependency_overrides[get_current_user] = lambda: dummy_user

client = TestClient(app)


def test_get_holidays():
    print("🧪 Testing GET /api/instruments/holidays...")
    response = client.get("/api/instruments/holidays")
    print(f"Response Status: {response.status_code}")
    assert response.status_code == 200
    
    data = response.json()
    print(f"Total Holidays Retrieved: {len(data)}")
    assert len(data) > 0
    print("First Holiday:", data[0])
    print("Last Holiday:", data[-1])


def test_sync_holidays():
    print("\n🧪 Testing POST /api/instruments/holidays/sync...")
    response = client.post("/api/instruments/holidays/sync")
    print(f"Response Status: {response.status_code}")
    assert response.status_code == 200
    
    data = response.json()
    print(f"Sync Status: {data.get('status')}")
    print(f"Message: {data.get('message')}")
    print(f"Source: {data.get('source')}")
    print(f"Holidays Count in Sync Response: {len(data.get('holidays', []))}")
    assert len(data.get('holidays', [])) > 0


if __name__ == "__main__":
    try:
        test_get_holidays()
        test_sync_holidays()
        print("\n✅ All holiday API tests passed successfully!")
    except AssertionError as e:
        print(f"\n❌ Test assertion failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        sys.exit(1)
    finally:
        # Clear dependency overrides
        app.dependency_overrides.clear()
