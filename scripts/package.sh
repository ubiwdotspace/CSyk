#!/bin/sh
# Builds a standalone CSyk for one platform: the npm package with its
# dependencies installed for that platform, the official Node.js binary to
# run it, and bin/csyk to start it. Nothing else needs to be installed.
#
#   scripts/package.sh <darwin|linux> <arm64|x64>    writes packages/csyk-<os>-<arch>.tar.gz
set -eu
os=$1
arch=$2
root=$(cd "$(dirname "$0")/.." && pwd)
node_version=$(node -p 'process.versions.node')
name=csyk-$os-$arch
work=$root/packages/$name
rm -rf "$work"
mkdir -p "$work/bin" "$work/lib" "$work/node/bin"

# The package as npm publishes it, with the dependencies of the target platform.
cd "$root"
npm pack --silent --pack-destination "$root/packages" > /dev/null
tar -xzf "$root"/packages/*csyk-*.tgz -C "$work/lib"
rm "$root"/packages/*csyk-*.tgz
mv "$work/lib/package" "$work/lib/csyk"
cp package-lock.json "$work/lib/csyk/"
(cd "$work/lib/csyk" && npm ci --omit=dev --ignore-scripts --os="$os" --cpu="$arch" --no-audit --no-fund --silent)
rm "$work/lib/csyk/package-lock.json"

# Node.js, the same version that built the package.
curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-$os-$arch.tar.gz" | tar -xz -C "$work" \
  "node-v$node_version-$os-$arch/bin/node" "node-v$node_version-$os-$arch/LICENSE"
mv "$work/node-v$node_version-$os-$arch/bin/node" "$work/node/bin/node"
mv "$work/node-v$node_version-$os-$arch/LICENSE" "$work/node/LICENSE"
rmdir "$work/node-v$node_version-$os-$arch/bin" "$work/node-v$node_version-$os-$arch"

cat > "$work/bin/csyk" <<'EOF'
#!/bin/sh
# Starts CSyk with the Node.js that ships beside it, through any symlink to this file.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
home=$(cd "$(dirname "$self")/.." && pwd)
exec "$home/node/bin/node" "$home/lib/csyk/dist/cli.js" "$@"
EOF
chmod +x "$work/bin/csyk"

tar -czf "$root/packages/$name.tar.gz" -C "$root/packages" "$name"
echo "$root/packages/$name.tar.gz"
