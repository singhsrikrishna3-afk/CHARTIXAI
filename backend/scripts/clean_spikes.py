"""PEESTOCK — Clean database EOD price wicks/spikes from Yahoo Finance data errors."""
import sqlite3

DB_PATH = "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db"
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# 0. Clean non-positive prices (<= 0) by flooring them to 0.01
cursor.execute("""
    SELECT COUNT(*) FROM ohlcv_eod
    WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
""")
zero_neg_count = cursor.fetchone()[0]
print(f"Flooring {zero_neg_count} rows with price <= 0 to 0.01...")

cursor.execute("""
    UPDATE ohlcv_eod
    SET open = CASE WHEN open <= 0 THEN 0.01 ELSE open END,
        high = CASE WHEN high <= 0 THEN 0.01 ELSE high END,
        low = CASE WHEN low <= 0 THEN 0.01 ELSE low END,
        close = CASE WHEN close <= 0 THEN 0.01 ELSE close END
    WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
""")
if zero_neg_count > 0:
    print("Non-positive prices cleaned.")


# 1. Cap high wicks where high > 1.25 * max(open, close)
# We set high = max(open, close) * 1.05
cursor.execute("""
    SELECT instrument_id, time, open, high, low, close
    FROM ohlcv_eod
    WHERE high > 1.25 * close AND high > 1.25 * open AND open > 0 AND close > 0
""")
high_glitches = cursor.fetchall()
print(f"Cleaning {len(high_glitches)} high spikes...")

high_updates = []
for inst_id, t, o, h, l, c in high_glitches:
    new_h = max(o, c) * 1.05
    high_updates.append((new_h, inst_id, t))

if high_updates:
    cursor.executemany("UPDATE ohlcv_eod SET high = ? WHERE instrument_id = ? AND time = ?", high_updates)
    print("High spikes cleaned.")

# 2. Repair low wicks where low < 0.75 * min(open, close)
# We set low = min(open, close) * 0.95
cursor.execute("""
    SELECT instrument_id, time, open, high, low, close
    FROM ohlcv_eod
    WHERE low < 0.75 * close AND low < 0.75 * open AND low > 0 AND open > 0 AND close > 0
""")
low_glitches = cursor.fetchall()
print(f"Cleaning {len(low_glitches)} low spikes...")

low_updates = []
for inst_id, t, o, h, l, c in low_glitches:
    new_l = min(o, c) * 0.95
    new_l = min(new_l, o, c)
    new_l = max(new_l, 0.01)
    low_updates.append((new_l, inst_id, t))

if low_updates:
    cursor.executemany("UPDATE ohlcv_eod SET low = ? WHERE instrument_id = ? AND time = ?", low_updates)
    print("Low spikes cleaned.")

conn.commit()
conn.close()
print("Database cleanup complete!")
