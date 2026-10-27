#!/usr/bin/env bash
set -e

PLUGIN_REPO="github:itsyasirkhandev/opencode-cline-free"
RAW_BUNDLE_URL="https://raw.githubusercontent.com/itsyasirkhandev/opencode-cline-free/main/dist/cline-free.js"

echo "==> Installing opencode-cline-free..."

# 1. Determine config directory
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

mkdir -p "$CONFIG_DIR"

# 2. Check for opencode CLI in PATH or macOS Desktop bundle
CLI_BIN=""
if command -v opencode >/dev/null 2>&1; then
  CLI_BIN="opencode"
elif command -v opencode-cli >/dev/null 2>&1; then
  CLI_BIN="opencode-cli"
elif [ -x "/Applications/OpenCode.app/Contents/Resources/opencode-cli" ]; then
  CLI_BIN="/Applications/OpenCode.app/Contents/Resources/opencode-cli"
fi

if [ -n "$CLI_BIN" ]; then
  echo "--> Found OpenCode CLI: $CLI_BIN"
  "$CLI_BIN" plugin add "$PLUGIN_REPO"
  echo "✓ Successfully installed via OpenCode CLI!"
else
  # 3. Direct config update for Desktop-only / no-CLI environments
  echo "--> OpenCode CLI not found in PATH; configuring for OpenCode Desktop directly..."

  UPDATED=0
  if [ -f "$CONFIG_FILE" ]; then
    # Try updating with node if available, else python3, else fallback to plugins directory
    if command -v node >/dev/null 2>&1; then
      node -e "
        const fs = require('fs');
        const file = process.argv[1];
        const pkg = process.argv[2];
        try {
          const content = fs.readFileSync(file, 'utf8');
          const json = JSON.parse(content);
          json.plugins = json.plugins || [];
          if (!json.plugins.includes(pkg)) {
            json.plugins.push(pkg);
            fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
            console.log('✓ Added ' + pkg + ' to ' + file);
          } else {
            console.log('✓ ' + pkg + ' is already configured in ' + file);
          }
        } catch (e) {
          process.exit(1);
        }
      " "$CONFIG_FILE" "$PLUGIN_REPO" && UPDATED=1 || true
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c "
import json, sys
f, p = sys.argv[1], sys.argv[2]
try:
    with open(f, 'r') as fp:
        data = json.load(fp)
    plugins = data.setdefault('plugins', [])
    if p not in plugins:
        plugins.append(p)
        with open(f, 'w') as fp:
            json.dump(data, fp, indent=2)
            fp.write('\n')
        print(f'✓ Added {p} to {f}')
    else:
        print(f'✓ {p} is already configured in {f}')
except Exception:
    sys.exit(1)
" "$CONFIG_FILE" "$PLUGIN_REPO" && UPDATED=1 || true
    fi
  else
    # Create new opencode.json
    cat <<EOF > "$CONFIG_FILE"
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    "$PLUGIN_REPO"
  ]
}
EOF
    echo "✓ Created $CONFIG_FILE with $PLUGIN_REPO"
    UPDATED=1
  fi

  # 4. If JSON couldn't be safely parsed (e.g. JSONC comments), install bundle directly to plugins/
  if [ "$UPDATED" -ne 1 ]; then
    mkdir -p "$PLUGINS_DIR"
    TARGET="$PLUGINS_DIR/cline-free.js"
    echo "--> Installing standalone plugin bundle to $TARGET..."
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$RAW_BUNDLE_URL" -o "$TARGET"
    elif command -v wget >/dev/null 2>&1; then
      wget -q "$RAW_BUNDLE_URL" -O "$TARGET"
    else
      echo "Error: neither curl nor wget available to download standalone bundle." >&2
      exit 1
    fi
    echo "✓ Installed standalone bundle to $TARGET"
  fi
fi

echo ""
echo "=========================================================="
echo "✓ opencode-cline-free installation complete!"
echo ""
echo "Next steps:"
echo "1. Launch OpenCode (or restart OpenCode Desktop)."
echo "2. Run /connect in chat (or go to Settings > Providers in Desktop)."
echo "3. Select 'Cline Free' to connect your account."
echo "=========================================================="
