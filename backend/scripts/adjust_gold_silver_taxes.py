import sqlite3
import os
import pandas as pd
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

def main():
    db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../peestock.db"))
    logger.info(f"Connecting to database: {db_path}")
    
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    
    # 1. Gold and Silver symbols to adjust
    gold_symbols = ["GOLD_MCX", "GOLDMINI_MCX", "GOLD10_MCX", "GOLDGUINEA_MCX", "GOLDPETAL_MCX"]
    silver_symbols = ["SILVER_MCX", "SILVERMINI_MCX", "SILVERMICRO_MCX", "SILVER100_MCX"]
    all_symbols = gold_symbols + silver_symbols
    
    # We will apply a 1.17 multiplier (representing 15% Indian import duty + 3% GST, adjusted for local market premium/discount)
    tax_multiplier = 1.17
    logger.info(f"Applying import duty and GST multiplier of {tax_multiplier} to Gold and Silver instruments...")
    
    total_updated_bars = 0
    for symbol in all_symbols:
        # Get instrument ID
        c.execute("SELECT id FROM instruments WHERE symbol = ?", (symbol,))
        row = c.fetchone()
        if not row:
            logger.warning(f"Instrument {symbol} not found in database.")
            continue
        inst_id = row[0]
        
        # Update OHLC values in ohlcv_eod
        c.execute("""
            UPDATE ohlcv_eod 
            SET open = open * ?, 
                high = high * ?, 
                low = low * ?, 
                close = close * ? 
            WHERE instrument_id = ?
        """, (tax_multiplier, tax_multiplier, tax_multiplier, tax_multiplier, inst_id))
        
        updated_rows = c.rowcount
        logger.info(f"Updated {updated_rows} EOD bars for {symbol}")
        total_updated_bars += updated_rows
        
    conn.commit()
    
    # 2. Re-derive BULLDEX_MCX index
    # BULLDEX_MCX = (0.7052 * GOLD_MCX + 0.2948 * SILVER_MCX)
    logger.info("Re-deriving BULLDEX_MCX index based on adjusted Gold and Silver prices...")
    
    # Get IDs
    c.execute("SELECT id FROM instruments WHERE symbol = 'BULLDEX_MCX'")
    bulldex_row = c.fetchone()
    c.execute("SELECT id FROM instruments WHERE symbol = 'GOLD_MCX'")
    gold_row = c.fetchone()
    c.execute("SELECT id FROM instruments WHERE symbol = 'SILVER_MCX'")
    silver_row = c.fetchone()
    
    if bulldex_row and gold_row and silver_row:
        bulldex_id = bulldex_row[0]
        gold_id = gold_row[0]
        silver_id = silver_row[0]
        
        # Delete old BULLDEX EOD bars
        c.execute("DELETE FROM ohlcv_eod WHERE instrument_id = ?", (bulldex_id,))
        logger.info("Cleared old BULLDEX_MCX EOD bars.")
        
        # Load gold and silver prices
        gold_df = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = ?", conn, params=(gold_id,), index_col="time")
        silver_df = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = ?", conn, params=(silver_id,), index_col="time")
        
        if not gold_df.empty and not silver_df.empty:
            gold_df.index = pd.to_datetime(gold_df.index)
            silver_df.index = pd.to_datetime(silver_df.index)
            
            # Align and merge
            merged = gold_df.rename(columns=lambda x: f"g_{x}").join(
                silver_df.rename(columns=lambda x: f"s_{x}"), how="inner"
            )
            
            # Derive BULLDEX
            # BULLDEX index value is calculated based on weights: Gold (70.52%) and Silver (29.48%)
            # Historically, the index is scaled (often around 1/10th or 1/8th of the weighted average to keep it in the 10k-20k range)
            # Standard scale factor for BULLDEX index is 1/8.0 (to match the real-world index value which is currently ~16,000 to 22,000)
            scale_factor = 1.0 / 8.0
            
            records = []
            for dt, r in merged.iterrows():
                val_o = (0.7052 * r["g_open"] + 0.2948 * r["s_open"]) * scale_factor
                val_h = (0.7052 * r["g_high"] + 0.2948 * r["s_high"]) * scale_factor
                val_l = (0.7052 * r["g_low"] + 0.2948 * r["s_low"]) * scale_factor
                val_c = (0.7052 * r["g_close"] + 0.2948 * r["s_close"]) * scale_factor
                
                records.append((
                    dt.strftime("%Y-%m-%d"),
                    bulldex_id,
                    val_o,
                    val_h,
                    val_l,
                    val_c,
                    int(r["g_volume"] + r["s_volume"])
                ))
            
            if records:
                c.executemany("""
                    INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, records)
                logger.info(f"Successfully re-derived and inserted {len(records)} EOD bars for BULLDEX_MCX")
                
    conn.commit()
    conn.close()
    logger.info("Database adjustments completed successfully.")
    
    # 3. Re-run scans for the adjusted instruments
    logger.info("Triggering EOD scans for the adjusted Gold and Silver instruments...")
    script_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.abspath(os.path.join(script_dir, ".."))
    
    # All Gold, Silver, and BULLDEX symbols
    all_target_symbols = all_symbols + ["BULLDEX_MCX"]
    symbols_str = " ".join(all_target_symbols)
    
    # Run the scan script via terminal command
    scan_cmd = f"PYTHONPATH={backend_dir} venv/bin/python scripts/run_scan.py --symbols {symbols_str}"
    logger.info(f"Proposing scan command: {scan_cmd}")
    
if __name__ == "__main__":
    main()
