#!/bin/sh
# brain installer — downloads the latest release binary for this platform.
#
#   curl -fsSL https://github.com/indiealvin/brain/releases/latest/download/install.sh | sh
#
# Options (environment):
#   BRAIN_INSTALL_DIR   where to put the binary (default: ~/.local/bin)
#   BRAIN_VERSION       a tag like v0.1.0 (default: latest)
set -eu

REPO="indiealvin/brain"
INSTALL_DIR="${BRAIN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${BRAIN_VERSION:-latest}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
  darwin) os="darwin" ;;
  linux) os="linux" ;;
  *) echo "brain: unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "brain: unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="brain-${os}-${arch}.tar.gz"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "brain: downloading ${asset} (${VERSION})"
curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}"
curl -fsSL "${base}/${asset}.sha256" -o "${tmp}/${asset}.sha256"

cd "$tmp"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "${asset}.sha256" >/dev/null
elif command -v shasum >/dev/null 2>&1; then
  expected=$(cut -d' ' -f1 "${asset}.sha256")
  actual=$(shasum -a 256 "$asset" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "brain: checksum mismatch" >&2; exit 1; }
fi

tar -xzf "$asset"
mkdir -p "$INSTALL_DIR"
mv brain "$INSTALL_DIR/brain"
chmod +x "$INSTALL_DIR/brain"

echo "brain: installed to $INSTALL_DIR/brain"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "brain: add $INSTALL_DIR to your PATH, e.g.  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
echo "brain: next:  brain setup   then   brain init ~/notes && cd ~/notes && brain chat"
