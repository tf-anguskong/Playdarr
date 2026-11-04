#!/usr/bin/env bash
# Build the Playdarr Docker image for x86-64 and ARM64 on this machine and publish it to GHCR.
#
#   scripts/release.sh             build + push ghcr.io/tf-anguskong/playdarr:<version>, :<major.minor>, :latest,
#                                  then tag the commit v<version> and push the tag
#   scripts/release.sh --dry-run   build both architectures but push nothing and tag nothing
#
# The version comes from package.json — bump it first (npm version patch|minor|major --no-git-tag-version, commit).
# Needs: Docker with buildx (Docker Desktop has it; ARM is built under QEMU emulation), and `docker login ghcr.io`
# with a token that has the write:packages scope.
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/tf-anguskong/playdarr}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="playdarr-builder"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$(dirname "$0")/.."
die() { echo "✕ $*" >&2; exit 1; }

# ── Release from a clean, up-to-date master ──
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$DRY_RUN" = 0 ]; then
  [ "$branch" = "master" ] || die "Releases are built from master (you're on $branch)."
  git diff --quiet && git diff --cached --quiet || die "Uncommitted changes to tracked files — commit or stash them first."
  git fetch -q origin master
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || die "master isn't the same as origin/master — pull or push first."
fi

version="$(node -p "require('./package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json version '$version' isn't x.y.z."
tag="v$version"
minor="${version%.*}"
revision="$(git rev-parse HEAD)"
if [ "$DRY_RUN" = 0 ] && git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  die "Tag $tag already exists — bump the version in package.json first."
fi

# ── A buildx builder that can build several architectures at once ──
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "→ Creating buildx builder $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

echo "→ Building $IMAGE:$version for $PLATFORMS ($branch @ ${revision:0:7})"
output=(--push)
[ "$DRY_RUN" = 1 ] && output=()   # multi-arch images can't be loaded locally; the build just lands in the cache
docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" \
  --build-arg VERSION="$version" --build-arg REVISION="$revision" \
  -t "$IMAGE:$version" -t "$IMAGE:$minor" -t "$IMAGE:latest" \
  "${output[@]}" .

if [ "$DRY_RUN" = 1 ]; then
  echo "✓ Dry run: both architectures built. Nothing was pushed or tagged."
  exit 0
fi

git tag -a "$tag" -m "Playdarr $version"
git push -q origin "$tag"
echo "✓ Published $IMAGE:$version (also :$minor and :latest) and pushed tag $tag"
