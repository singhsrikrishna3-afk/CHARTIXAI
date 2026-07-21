"""PEESTOCK — Test querying nse_holidays table directly from SQLite."""

import os
import sqlite3

def main():
    db_path = "peestock.db"
    if not os.path.exists(db_path):
        db_path = "../peestock.db"
        if not os.path.exists(db_path):
            print("Database file not found.")
            return

    print(f"Connecting to database: {db_path}")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='nse_holidays';")
        table_exists = cursor.fetchone()
        if not table_exists:
            print("Table 'nse_holidays' does not exist.")
            return

        cursor.execute("SELECT COUNT(*) FROM nse_holidays;")
        count = cursor.fetchone()[0]
        print(f"Total holidays in database: {count}")

        cursor.execute("SELECT id, trading_date, week_day, description FROM nse_holidays ORDER BY trading_date LIMIT 5;")
        rows = cursor.fetchall()
        print("\nFirst 5 holidays:")
        for r in rows:
            print(f"ID: {r[0]} | Date: {r[1]} | Day: {r[2]} | Occasion: {r[3]}")

    except Exception as e:
        print(f"Error querying table: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
