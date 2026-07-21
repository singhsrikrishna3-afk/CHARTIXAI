#!/usr/bin/env python
"""PEESTOCK — Test Suite for Advanced Price Spike and Corporate Action Cleaner.

Creates a mock database with various price anomaly scenarios, runs the
vendor-free cleaner (no external API calls), and asserts that each
scenario is repaired the way a single-source-of-truth, ratio-rescale
approach should handle it:

- Weekend records: deleted outright (NSE never trades Sat/Sun).
- Isolated single-day glitches that don't fit a split ratio: deleted,
  since there is no second vendor to borrow a replacement value from.
- Split/bonus cliffs that do fit a clean ratio: pre-jump history is
  rescaled in place to match the post-jump basis.
- Ordinary large daily moves that don't fit a clean ratio: left
  untouched, since they're real price action, not a data error.
"""

import os
import sys
import sqlite3
import unittest

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import scripts.clean_spikes_advanced as cleaner


class TestCleanSpikes(unittest.TestCase):
    def setUp(self):
        self.db_path = "test_peestock.db"
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()

        self.cursor.execute("""
            CREATE TABLE instruments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                exchange TEXT DEFAULT 'NSE',
                segment TEXT DEFAULT 'EQ',
                is_active INTEGER DEFAULT 1
            )
        """)

        self.cursor.execute("""
            CREATE TABLE ohlcv_eod (
                time TEXT,
                instrument_id INTEGER,
                open REAL,
                high REAL,
                low REAL,
                close REAL,
                volume INTEGER,
                PRIMARY KEY (instrument_id, time)
            )
        """)

        # Instrument 1: Stock with an unadjusted Saturday spike (e.g. INFY mock)
        self.cursor.execute("INSERT INTO instruments (id, symbol, name, segment) VALUES (1, 'INFYMOCK', 'INFY Mock', 'EQ')")
        # Instrument 2: ETF with an isolated single-day glitch (e.g. NV20 mock)
        self.cursor.execute("INSERT INTO instruments (id, symbol, name, segment) VALUES (2, 'NV20MOCK', 'NV20 Mock', 'EQ')")
        # Instrument 3: Stock with an unadjusted 10:1 split cliff
        self.cursor.execute("INSERT INTO instruments (id, symbol, name, segment) VALUES (3, 'CLIFFMOCK', 'Cliff Mock', 'EQ')")
        # Instrument 4: Stock with an ordinary large move that is NOT a corporate action
        self.cursor.execute("INSERT INTO instruments (id, symbol, name, segment) VALUES (4, 'VOLMOCK', 'Volatile Mock', 'EQ')")

        # INFYMOCK: Weekdays are ~40. Saturday 2003-03-22 has an unadjusted spike of 3800.
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2003-03-20', 1, 39.38, 41.60, 39.38, 41.23, 71270784)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2003-03-21', 1, 41.29, 42.08, 40.92, 41.72, 55244672)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2003-03-22', 1, 3836.59, 3854.53, 3808.21, 3832.10, 310536)")  # Saturday spike
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2003-03-24', 1, 41.97, 42.14, 41.19, 41.39, 55051712)")

        # NV20MOCK: Weekdays are ~14, with real history on both sides so the
        # glitch is judged against a proper local window, not just its
        # immediate neighbors. Day 2026-06-23 has a glitched price of 11906
        # (raw index value leaking in, not the ETF price).
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-15', 2, 14.05, 14.10, 14.00, 14.08, 80000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-16', 2, 14.08, 14.15, 14.05, 14.10, 75000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-17', 2, 14.10, 14.18, 14.08, 14.12, 70000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-18', 2, 14.12, 14.20, 14.10, 14.13, 60000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-19', 2, 14.26, 14.26, 13.97, 14.13, 46083)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-22', 2, 14.13, 14.20, 14.12, 14.17, 89672)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-23', 2, 12017.45, 12029.50, 11884.70, 11906.05, 0)")  # Glitch
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-24', 2, 14.20, 14.25, 14.10, 14.18, 90000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-25', 2, 14.18, 14.22, 14.12, 14.19, 85000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2026-06-26', 2, 14.19, 14.24, 14.15, 14.20, 82000)")

        # CLIFFMOCK: 10:1 split occurred on 2025-05-12.
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-08', 3, 1000.0, 1010.0, 990.0, 1005.0, 50000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-09', 3, 1005.0, 1020.0, 1000.0, 1010.0, 60000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-12', 3, 101.0, 102.5, 99.8, 100.5, 600000)")  # Post-split

        # VOLMOCK: a genuine -40% single-day crash (e.g. a profit-warning gap down) on 2025-06-03,
        # with real history on both sides (so the day immediately before/after the crash is judged
        # against its own local trend, not just the crash bar itself). Big enough to trip the >30%
        # suspect scan, but not a clean split/bonus ratio, so it should be left exactly as-is.
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-27', 4, 198.0, 200.0, 196.0, 198.5, 38000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-28', 4, 198.5, 201.0, 197.0, 199.0, 39000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-29', 4, 199.0, 201.5, 197.5, 199.5, 40000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-05-30', 4, 199.5, 202.0, 198.0, 200.0, 41000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-06-02', 4, 200.0, 202.0, 198.0, 200.0, 40000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-06-03', 4, 200.0, 201.0, 119.0, 120.0, 900000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-06-04', 4, 120.0, 122.0, 118.0, 121.0, 300000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-06-05', 4, 121.0, 123.0, 119.0, 122.0, 280000)")
        self.cursor.execute("INSERT INTO ohlcv_eod VALUES ('2025-06-06', 4, 122.0, 124.0, 120.0, 123.0, 270000)")

        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_spike_and_cliff_cleanup(self):
        suspects = cleaner.find_suspect_instruments(self.conn)

        suspect_ids = {s[0] for s in suspects}
        self.assertIn(1, suspect_ids)  # INFYMOCK has Saturday record
        self.assertIn(2, suspect_ids)  # NV20MOCK has >30% price change (glitch)
        self.assertIn(3, suspect_ids)  # CLIFFMOCK has >30% price change (split cliff)
        self.assertIn(4, suspect_ids)  # VOLMOCK has >30% price change (genuine crash)

        for iid, symbol, segment in suspects:
            cleaner.repair_instrument(self.conn, iid, symbol, segment)

        # 1. INFYMOCK: Saturday record deleted, weekdays untouched.
        self.cursor.execute("SELECT COUNT(*) FROM ohlcv_eod WHERE instrument_id = 1 AND time = '2003-03-22'")
        self.assertEqual(self.cursor.fetchone()[0], 0, "Saturday spike record should be deleted.")
        self.cursor.execute("SELECT close FROM ohlcv_eod WHERE instrument_id = 1 AND time = '2003-03-21'")
        self.assertEqual(self.cursor.fetchone()[0], 41.72)

        # 2. NV20MOCK: isolated glitch (not a split ratio vs. either neighbor) is deleted, not guessed at.
        self.cursor.execute("SELECT COUNT(*) FROM ohlcv_eod WHERE instrument_id = 2 AND time = '2026-06-23'")
        self.assertEqual(self.cursor.fetchone()[0], 0, "Isolated glitch record should be deleted.")
        self.cursor.execute("SELECT close FROM ohlcv_eod WHERE instrument_id = 2 AND time = '2026-06-22'")
        self.assertAlmostEqual(self.cursor.fetchone()[0], 14.17)

        # 3. CLIFFMOCK: pre-split history rescaled in place by the detected ~10x ratio.
        self.cursor.execute("SELECT close, volume FROM ohlcv_eod WHERE instrument_id = 3 AND time = '2025-05-09'")
        row = self.cursor.fetchone()
        self.assertIsNotNone(row)
        self.assertAlmostEqual(row[0], 101.0, delta=0.5, msg="Pre-split price should be rescaled to ~101 (1010 * 0.1).")
        self.assertEqual(row[1], 600000, "Pre-split volume should be rescaled to 600000 (60000 / 0.1).")
        # Post-split row is untouched.
        self.cursor.execute("SELECT close FROM ohlcv_eod WHERE instrument_id = 3 AND time = '2025-05-12'")
        self.assertAlmostEqual(self.cursor.fetchone()[0], 100.5)

        # 4. VOLMOCK: genuine -40% move (not a clean split ratio) is left exactly as ingested.
        self.cursor.execute("SELECT close, volume FROM ohlcv_eod WHERE instrument_id = 4 AND time = '2025-06-03'")
        row = self.cursor.fetchone()
        self.assertEqual(row[0], 120.0, "Genuine crash day should not be touched.")
        self.assertEqual(row[1], 900000, "Genuine crash day volume should not be touched.")
        self.cursor.execute("SELECT close FROM ohlcv_eod WHERE instrument_id = 4 AND time = '2025-06-02'")
        self.assertEqual(self.cursor.fetchone()[0], 200.0, "Day before the crash should not be rescaled.")


if __name__ == "__main__":
    unittest.main()
