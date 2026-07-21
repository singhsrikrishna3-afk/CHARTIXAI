import sqlite3
import os

def main():
    db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../peestock.db"))
    print(f"Connecting to database: {db_path}")
    
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    
    # Define mapping of index symbol to global futures symbols
    mappings = {
        "BULLION": ["GC=F", "SI=F"],
        "BASE_METALS": ["HG=F", "ALI=F", "ZNC=F", "LED=F"],
        "ENERGY": ["CL=F", "NG=F"]
    }
    
    total_added = 0
    for index_sym, future_syms in mappings.items():
        # Get index ID
        c.execute("SELECT id FROM instruments WHERE symbol = ? AND segment = 'IND'", (index_sym,))
        index_row = c.fetchone()
        if not index_row:
            print(f"Index {index_sym} not found in database.")
            continue
        index_id = index_row[0]
        
        for fut_sym in future_syms:
            # Get future instrument ID
            c.execute("SELECT id FROM instruments WHERE symbol = ?", (fut_sym,))
            fut_row = c.fetchone()
            if not fut_row:
                print(f"Future instrument {fut_sym} not found in database.")
                continue
            fut_id = fut_row[0]
            
            # Check if already mapped
            c.execute("SELECT 1 FROM index_constituents WHERE index_id = ? AND instrument_id = ?", (index_id, fut_id))
            if c.fetchone():
                print(f"Mapping already exists: {index_sym} -> {fut_sym}")
            else:
                c.execute("INSERT INTO index_constituents (index_id, instrument_id) VALUES (?, ?)", (index_id, fut_id))
                print(f"Created mapping: {index_sym} -> {fut_sym}")
                total_added += 1
                
    conn.commit()
    conn.close()
    print(f"Successfully added {total_added} new global futures mappings.")

if __name__ == "__main__":
    main()
