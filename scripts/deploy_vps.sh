#!/bin/bash
# ==============================================================================
# PEESTOCKS / ChartixAI — Automated Production VPS Deployment Script
# Target OS: Ubuntu 22.04 / 24.04 LTS (Hetzner / DigitalOcean / Linode)
# ==============================================================================

set -e

DOMAIN="api.chartixai.com"
APP_DIR="/var/www/peestocks"
REPO_URL="https://github.com/singhsrikrishna3-afk/CHARTIXAI.git"

echo "🚀 [1/6] Updating system packages & dependencies..."
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y python3-pip python3-venv nginx certbot python3-certbot-nginx redis-server git curl

echo "📦 [2/6] Setting up project directory..."
sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR

if [ -d "$APP_DIR/.git" ]; then
    echo "Updating existing repository..."
    cd $APP_DIR && git pull origin main
else
    echo "Cloning repository..."
    git clone $REPO_URL $APP_DIR
fi

cd $APP_DIR/backend

echo "🐍 [3/6] Setting up Python virtual environment..."
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "⚙️ [4/6] Creating Systemd Service..."
sudo tee /etc/systemd/system/chartixai-backend.service > /dev/null <<EOF
[Unit]
Description=ChartixAI FastAPI Production Service
After=network.target redis-server.service

[Service]
User=$USER
WorkingDirectory=$APP_DIR/backend
ExecStart=$APP_DIR/backend/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 4
Restart=always
RestartSec=5
Environment="PATH=$APP_DIR/backend/venv/bin"
Environment="JWT_SECRET=chartixai_super_secret_jwt_key_2026"
Environment="CORS_ORIGINS=https://chartixai.com,https://www.chartixai.com,http://localhost:3000"
Environment="DEBUG=false"

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable chartixai-backend
sudo systemctl restart chartixai-backend

echo "🌐 [5/6] Configuring Nginx Reverse Proxy..."
sudo tee /etc/nginx/sites-available/chartixai > /dev/null <<EOF
server {
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/chartixai /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

echo "✅ [6/6] Production VPS setup complete!"
echo "👉 Next: Point DNS A record for api.chartixai.com to this server IP, then run:"
echo "   sudo certbot --nginx -d api.chartixai.com"
