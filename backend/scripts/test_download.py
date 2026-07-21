import httpx
from datetime import date
import io
import pandas as pd
from zipfile import ZipFile

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://www.nseindia.com/",
}

def test_download_equity(dt: date):
    date_str = dt.strftime("%Y%m%d")
    url = f"https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{date_str}_F_0000.csv.zip"
    print(f"Downloading CM bhavcopy from {url}")
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            # First get cookies
            client.get("https://www.nseindia.com/", headers=NSE_HEADERS)
            resp = client.get(url, headers=NSE_HEADERS)
            print("Status code:", resp.status_code)
            resp.raise_for_status()
            with ZipFile(io.BytesIO(resp.content)) as zf:
                csv_name = zf.namelist()[0]
                with zf.open(csv_name) as f:
                    df = pd.read_csv(f)
            print("Successfully downloaded. Row count:", len(df))
            print("Columns:", list(df.columns))
    except Exception as e:
        print("Error downloading CM bhavcopy:", e)

def test_download_indices(dt: date):
    date_str = dt.strftime("%d%m%Y")
    url = f"https://nsearchives.nseindia.com/content/indices/ind_close_all_{date_str}.csv"
    print(f"Downloading index bhavcopy from {url}")
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            client.get("https://www.nseindia.com/", headers=NSE_HEADERS)
            resp = client.get(url, headers=NSE_HEADERS)
            print("Status code:", resp.status_code)
            resp.raise_for_status()
            print("Successfully downloaded. Content length:", len(resp.text))
            print("First lines:")
            print("\n".join(resp.text.splitlines()[:5]))
    except Exception as e:
        print("Error downloading index bhavcopy:", e)

if __name__ == "__main__":
    test_download_equity(date(2026, 6, 19))
    test_download_indices(date(2026, 6, 19))
