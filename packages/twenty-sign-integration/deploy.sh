#!/bin/bash
set -e

echo "========================================="
echo "  Umbak Sign + Integration Deploy"
echo "========================================="
echo ""

cd /opt/twenty

# Step 1: Pull integration service code
echo "[1/7] Pulling sign integration code..."
if [ -d "./twenty-sign-integration" ]; then
  sudo rm -rf twenty-sign-integration
fi
sudo git clone --depth 1 --branch umbak-prod https://github.com/Muneebshaikh37/UmbakCRM.git /tmp/umbakcrm-sign
sudo cp -r /tmp/umbakcrm-sign/packages/twenty-sign-integration ./twenty-sign-integration
sudo rm -rf /tmp/umbakcrm-sign
echo "  Done."

# Step 2: Environment variables
echo ""
echo "[2/7] Environment setup"
if grep -q "DOCUSEAL_API_KEY" .env 2>/dev/null; then
  echo "  DocuSeal env vars already in .env, skipping."
else
  echo "  You need:"
  echo "    - Umbak Sign API key (Settings > API in Umbak Sign)"
  echo "    - Webhook secret (Settings > Webhooks in Umbak Sign)"
  echo ""
  read -p "  Umbak Sign API key (or Enter to skip): " SIGN_KEY
  read -p "  Webhook secret (or Enter to skip): " WEBHOOK_SECRET
  sudo tee -a .env > /dev/null <<EOF

# Umbak Sign integration
DOCUSEAL_API_KEY=${SIGN_KEY}
DOCUSEAL_WEBHOOK_SECRET=${WEBHOOK_SECRET}
EOF
  echo "  Added to .env"
fi

# Step 3: Add DocuSeal (Umbak Sign) to docker-compose.yml
echo ""
echo "[3/7] Adding Umbak Sign to docker-compose.yml..."
if grep -q "umbak-sign" docker-compose.yml 2>/dev/null; then
  echo "  umbak-sign already in docker-compose.yml, skipping."
else
  sudo cp docker-compose.yml docker-compose.yml.backup
  sudo sed -i '/^volumes:/i\
  umbak-sign:\
    image: docuseal/docuseal:latest\
    volumes:\
      - sign-data:/data\
    environment:\
      FORCE_SSL: "false"\
      HOST: crm.irishpayments.ie\
    restart: unless-stopped\
    networks:\
      - default\
' docker-compose.yml

  echo "  sign-data:" | sudo tee -a docker-compose.yml > /dev/null

  echo "  Added Umbak Sign container."
fi

# Step 4: Add integration bridge to docker-compose.yml
echo ""
echo "[4/7] Adding sign integration bridge..."
if grep -q "twenty-sign-bridge" docker-compose.yml 2>/dev/null; then
  echo "  twenty-sign-bridge already in docker-compose.yml, skipping."
else
  sudo sed -i '/^volumes:/i\
  twenty-sign-bridge:\
    build: ./twenty-sign-integration\
    environment:\
      TWENTY_API_URL: http://twenty-server:3000/api\
      TWENTY_API_KEY: ${TWENTY_FORM_API_KEY}\
      DOCUSEAL_API_URL: http://umbak-sign:3000\
      DOCUSEAL_API_KEY: ${DOCUSEAL_API_KEY}\
      DOCUSEAL_WEBHOOK_SECRET: ${DOCUSEAL_WEBHOOK_SECRET}\
      PORT: "4001"\
    restart: unless-stopped\
    depends_on:\
      - twenty-server\
      - umbak-sign\
    networks:\
      - default\
' docker-compose.yml
  echo "  Added sign integration bridge."
fi

# Step 5: Update Caddy config
echo ""
echo "[5/7] Updating Caddy config..."
CADDY_FILE=""
for f in Caddyfile caddy/Caddyfile config/Caddyfile; do
  if [ -f "$f" ]; then
    CADDY_FILE="$f"
    break
  fi
done

if [ -z "$CADDY_FILE" ]; then
  echo "  Could not find Caddyfile. Add these blocks BEFORE the existing 'handle' block:"
  echo ""
  echo "    handle /sign* {"
  echo "        reverse_proxy umbak-sign:3000"
  echo "    }"
  echo ""
  echo "    handle /sign-webhook* {"
  echo "        reverse_proxy twenty-sign-bridge:4001"
  echo "    }"
else
  if grep -q "umbak-sign" "$CADDY_FILE" 2>/dev/null; then
    echo "  Sign routes already in $CADDY_FILE, skipping."
  else
    sudo cp "$CADDY_FILE" "${CADDY_FILE}.backup"
    sudo sed -i '/handle {/i\    handle /sign-webhook* {\n        reverse_proxy twenty-sign-bridge:4001\n    }\n\n    handle /sign* {\n        reverse_proxy umbak-sign:3000\n    }\n' "$CADDY_FILE"
    echo "  Added sign routes to $CADDY_FILE."
  fi
fi

# Step 6: Build and start
echo ""
echo "[6/7] Building and starting services..."
sudo docker compose pull umbak-sign
sudo docker compose build twenty-sign-bridge
sudo docker compose up -d umbak-sign twenty-sign-bridge

if sudo docker compose ps caddy 2>/dev/null | grep -q "running"; then
  echo "  Reloading Caddy..."
  sudo docker compose restart caddy
fi

# Step 7: Health checks
echo ""
echo "[7/7] Health checks..."
sleep 10

echo -n "  Umbak Sign: "
if curl -sf http://localhost:3000 > /dev/null 2>&1; then
  echo "OK"
else
  echo "WAITING (DocuSeal takes ~30s to boot, check: sudo docker compose logs umbak-sign)"
fi

echo -n "  Integration bridge: "
if curl -sf http://localhost:4001/health > /dev/null 2>&1; then
  echo "OK"
else
  echo "FAILED (check: sudo docker compose logs twenty-sign-bridge)"
fi

echo ""
echo "========================================="
echo "  Deploy complete!"
echo ""
echo "  Umbak Sign:  https://crm.irishpayments.ie/sign"
echo "  Webhook URL:  https://crm.irishpayments.ie/sign-webhook/webhook/docuseal"
echo ""
echo "  Next steps:"
echo "  1. Open Umbak Sign and complete initial setup"
echo "  2. Go to Settings > API and create an API key"
echo "  3. Go to Settings > Webhooks and add:"
echo "     URL: https://crm.irishpayments.ie/sign-webhook/webhook/docuseal"
echo "     Events: form.completed, form.started, form.viewed, form.declined"
echo "  4. Update .env with the API key and webhook secret"
echo "  5. Restart: sudo docker compose restart twenty-sign-bridge"
echo "========================================="
