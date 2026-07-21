#!/bin/bash
# PEESTOCKS — Quick Seed Script

ARCHIVE_DIR="/Users/srikrishnasingh/AG1 BB/PEESTOCKS/archive"

echo "🚀 Starting PEESTOCK Data Seed..."
echo "📂 Source: $ARCHIVE_DIR"

if [ ! -d "$ARCHIVE_DIR" ]; then
    echo "❌ Error: Archive directory not found at $ARCHIVE_DIR"
    exit 1
fi

# Set environment variables for local DB if not in docker
export DATABASE_URL="postgresql://peestock:peestock_dev@localhost:5432/peestock"

# Run the seed script using venv
echo "🔧 Using backend virtual environment..."
./backend/venv/bin/python3 -m backend.scripts.seed_archive "$ARCHIVE_DIR"

echo "✅ Seeding complete. Now log in to the dashboard and click 'Scan Market Now' to generate patterns!"
