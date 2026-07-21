import sqlite3
import pandas as pd

def fix_archive_gap():
    conn = sqlite3.connect('peestock.db')
    cursor = conn.cursor()
    
    # Get all active instruments
    cursor.execute("SELECT id, symbol FROM instruments WHERE is_active = 1")
    instruments = cursor.fetchall()
    
    total_updates = 0
    
    for iid, symbol in instruments:
        # Find the last price before 2021-05-12 (the unadjusted data)
        cursor.execute("SELECT time, close FROM ohlcv_eod WHERE instrument_id = ? AND time < '2021-05-12' ORDER BY time DESC LIMIT 1", (iid,))
        row_unadj = cursor.fetchone()
        
        # Find the first price on or after 2021-05-12 (the YF adjusted data)
        cursor.execute("SELECT time, close FROM ohlcv_eod WHERE instrument_id = ? AND time >= '2021-05-12' ORDER BY time ASC LIMIT 1", (iid,))
        row_adj = cursor.fetchone()
        
        if not row_unadj or not row_adj:
            continue
            
        unadj_price = row_unadj[1]
        adj_price = row_adj[1]
        
        # If the gap is less than 5%, we don't need to adjust (no major splits)
        if unadj_price == 0:
            continue
            
        ratio = adj_price / unadj_price
        
        if abs(1 - ratio) < 0.05:
            continue
            
        print(f"[{symbol}] Huge gap detected! Unadjusted ({row_unadj[0]}): {unadj_price:.2f} | Adjusted ({row_adj[0]}): {adj_price:.2f} | Ratio: {ratio:.4f}")
        
        # Update all data before 2021-05-12 for this instrument
        cursor.execute("""
            UPDATE ohlcv_eod 
            SET open = open * ?,
                high = high * ?,
                low = low * ?,
                close = close * ?,
                volume = volume / ?
            WHERE instrument_id = ? AND time < '2021-05-12'
        """, (ratio, ratio, ratio, ratio, ratio, iid))
        
        updated_rows = cursor.rowcount
        total_updates += updated_rows
        print(f"  -> Adjusted {updated_rows} historical rows.")
        
    conn.commit()
    conn.close()
    print(f"Done! Successfully smoothed out {total_updates} rows of historical archive data.")

if __name__ == "__main__":
    fix_archive_gap()
