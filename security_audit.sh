#!/usr/bin/env bash
set -u

echo "========================================"
echo " MEMECOIN BOT — SECURITY AUDIT"
echo "========================================"

echo
echo "=== 1. ARCHIVOS DEL REPO ==="
find . -type f \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  | sort

echo
echo "=== 2. RED / URLS / HTTP / WS ==="
grep -RniE \
'https?://|wss?://|fetch\(|WebSocket|axios|request\(|http\.|https\.' \
. --exclude-dir=node_modules --exclude-dir=.git || true

echo
echo "=== 3. CREDENCIALES / KEYS / SECRETS ==="
grep -RniE \
'privateKey|secretKey|secret|mnemonic|seedPhrase|seed phrase|auth_token|api[_-]?key|Bearer|authorization|credentials|password' \
. --exclude-dir=node_modules --exclude-dir=.git || true

echo
echo "=== 4. LECTURA DE ARCHIVOS SENSIBLES ==="
grep -RniE \
'readFile|readFileSync|readdir|readdirSync|createReadStream|glob\(|\.json|\.env|process\.cwd|HOME|homedir' \
src scripts package.json 2>/dev/null || true

echo
echo "=== 5. EJECUCION DE COMANDOS ==="
grep -RniE \
'child_process|exec\(|execSync|spawn\(|spawnSync|fork\(|eval\(|new Function|vm\.|shell=True|system\(' \
. --exclude-dir=node_modules --exclude-dir=.git || true

echo
echo "=== 6. POSIBLE OFUSCACION ==="
grep -RniE \
'Buffer\.from\(.*base64|atob\(|btoa\(|fromCharCode|charCodeAt|decodeURIComponent|unescape\(' \
src scripts 2>/dev/null || true

echo
echo "=== 7. UPLOADS / POST / EXFILTRACION ==="
grep -RniE \
'method:[[:space:]]*['"'"'"]POST|method:[[:space:]]*['"'"'"]PUT|method:[[:space:]]*['"'"'"]PATCH|body:[[:space:]]*JSON\.stringify|FormData|multipart|upload' \
src scripts 2>/dev/null || true

echo
echo "=== 8. WALLET / FIRMAS ==="
grep -RniE \
'Keypair|fromSecretKey|sign\(|signAllTransactions|sendRawTransaction|sendAndConfirm|wallet\.keypair|wallet\.pubkey' \
src --exclude-dir=node_modules || true

echo
echo "=== 9. DEPENDENCIAS ==="
npm ls --depth=0 2>&1 || true

echo
echo "=== 10. NPM AUDIT ==="
npm audit --omit=dev 2>&1 || true

echo
echo "=== 11. SCRIPTS NPM ==="
node -e "console.log(require('./package.json').scripts)"

echo
echo "=== 12. ARCHIVOS OCULTOS / POSIBLES EJECUTABLES ==="
find . -type f \
  \( -name '*.sh' -o -name '*.bash' -o -name '*.ps1' -o -name '*.bat' -o -name '*.exe' -o -name '*.bin' \) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -print

echo
echo "========================================"
echo " AUDIT COMPLETE"
echo "========================================"
