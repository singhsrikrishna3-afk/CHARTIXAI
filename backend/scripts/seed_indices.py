import asyncio
import yfinance as yf
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select
from datetime import datetime

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import get_settings
from app.models.models import Instrument, OhlcvEod
import pandas as pd

settings = get_settings()

INDICES = {
    "NIFTY 50": ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS", "HUL.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS", "LT.NS", "ASIANPAINT.NS", "AXISBANK.NS", "MARUTI.NS", "SUNPHARMA.NS", "BAJFINANCE.NS", "TITAN.NS", "ULTRACEMCO.NS", "BAJAJFINSV.NS", "TATASTEEL.NS"],
    "NIFTY BANK": ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "AXISBANK.NS", "KOTAKBANK.NS", "INDUSINDBK.NS", "BANKBARODA.NS", "AUBANK.NS", "FEDERALBNK.NS", "IDFCFIRSTB.NS", "PNB.NS", "BANDHANBNK.NS"],
    "NIFTY IT": ["TCS.NS", "INFY.NS", "HCLTECH.NS", "WIPRO.NS", "TECHM.NS", "LTIM.NS", "COFORGE.NS", "MPHASIS.NS", "PERSISTENT.NS", "LTTS.NS"],
    "NIFTY AUTO": ["MARUTI.NS", "TATAMOTORS.NS", "M&M.NS", "BAJAJ-AUTO.NS", "EICHERMOT.NS", "HEROMOTOCO.NS", "TVSMOTOR.NS", "ASHOKLEY.NS", "BOSCHLTD.NS", "MRF.NS", "BALKRISIND.NS", "TIINDIA.NS"]
}

engine = create_async_engine(settings.DATABASE_URL)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def seed_data():
    async with AsyncSessionLocal() as session:
        for index_name, symbols in INDICES.items():
            print(f"Fetching data for {index_name} components...")
            for ticker in symbols:
                symbol_clean = ticker.replace('.NS', '')
                
                # Create or get instrument
                result = await session.execute(select(Instrument).where(Instrument.symbol == symbol_clean))
                instrument = result.scalar_one_or_none()
                if not instrument:
                    instrument = Instrument(
                        symbol=symbol_clean,
                        name=symbol_clean,
                        exchange="NSE",
                        segment="EQ",
                        is_active=True
                    )
                    session.add(instrument)
                    await session.flush()
                
                print(f"  Downloading {ticker}...")
                try:
                    df = yf.download(ticker, period="1y", interval="1d", progress=False)
                    if df.empty:
                        continue
                    
                    # Some versions of yf return MultiIndex columns
                    if isinstance(df.columns, pd.MultiIndex):
                        df.columns = df.columns.droplevel(1)

                    df = df.reset_index()
                    
                    for _, row in df.iterrows():
                        date_val = row["Date"].date() if "Date" in row else row.name.date()
                        # Check if eod exists
                        eod_res = await session.execute(
                            select(OhlcvEod).where(
                                OhlcvEod.instrument_id == instrument.id,
                                OhlcvEod.time == date_val
                            )
                        )
                        if eod_res.scalar_one_or_none():
                            continue
                            
                        eod = OhlcvEod(
                            time=date_val,
                            instrument_id=instrument.id,
                            open=float(row["Open"]),
                            high=float(row["High"]),
                            low=float(row["Low"]),
                            close=float(row["Close"]),
                            volume=int(row["Volume"]),
                            delivery_qty=0
                        )
                        session.add(eod)
                    await session.commit()
                except Exception as e:
                    print(f"Error for {ticker}: {e}")
                    await session.rollback()
        
        print("Done fetching back data.")

if __name__ == "__main__":
    asyncio.run(seed_data())
