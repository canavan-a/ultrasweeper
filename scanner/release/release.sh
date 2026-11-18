#!/usr/bin/env bash
#
# release.sh — guided scanner-app APK release.
#
# Same flow as super-badger's release/release.sh, adapted: tag prefix
# "scanner-v" (app/src/appUpdater.ts TAG_PREFIX — several tools share this
# repo's Releases), ULTRASCANNER_* signing env, and an APK named
# ultrascanner-<tag>.apk so appUpdater.ts's APK_NAME regex finds it.
#
# One deliberate difference: this repo's `origin` is currently the Super
# Matrix relay, not GitHub. Publishing to GitHub Releases is therefore
# conditional — it needs a GitHub URL as origin or GITHUB_REPO set (e.g.
# GITHUB_REPO=canavan-a/ultrasweeper) — and a failed tag push is a warning
# with the relay push hint, not a hard stop. The signed APK is always left
# on disk regardless, so sideloading works even with no remote at all.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
APP_ANDROID="$APP_DIR/android"
ENV_FILE="$SCRIPT_DIR/keystore.env"
KEYSTORE_FILE="$SCRIPT_DIR/release.keystore"
APK_BUILT="$APP_ANDROID/app/build/outputs/apk/release/app-release.apk"
TAG_PREFIX="scanner-v"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
	local prompt="$1" reply
	read -r -p "$prompt [y/N] " reply
	[[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]]
}

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
bold "==> Preflight"

for bin in git java; do
	command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH"
done
[[ -x "$APP_ANDROID/gradlew" ]] || die "missing $APP_ANDROID/gradlew"
[[ -f "$ENV_FILE" ]]            || die "missing $ENV_FILE — run release/gen-keystore.sh first"
[[ -f "$KEYSTORE_FILE" ]]       || die "missing $KEYSTORE_FILE — run release/gen-keystore.sh first"
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO_ROOT"

# GitHub publishing is optional (see header note): a GitHub origin URL or
# GITHUB_REPO=<owner>/<repo> enables it; `gh` is only required then.
GH_REPO="${GITHUB_REPO:-}"
ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
if [[ -z "$GH_REPO" && "$ORIGIN_URL" == *"github.com"* ]]; then
	GH_REPO="$(printf '%s' "$ORIGIN_URL" | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
fi
if [[ -n "$GH_REPO" ]]; then
	command -v gh >/dev/null 2>&1 || die "GitHub publishing targeted at $GH_REPO but 'gh' is not on PATH (or unset GITHUB_REPO to skip publishing)"
fi

info "toolchain ok  ($(java -version 2>&1 | head -1))"

# ---------------------------------------------------------------------------
# 2. Load signing env
# ---------------------------------------------------------------------------
bold "==> Signing material"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# The env file carries an absolute path that may be stale on another machine.
export ULTRASCANNER_KEYSTORE_FILE="$KEYSTORE_FILE"

placeholder_re='^(|\.\.\.|CHANGME|CHANGEME|fill.*|<.*>)$'
for var in ULTRASCANNER_KEYSTORE_PASSWORD ULTRASCANNER_KEY_ALIAS ULTRASCANNER_KEY_PASSWORD; do
	val="${!var:-}"
	if [[ -z "$val" || "$val" =~ $placeholder_re ]]; then
		die "$var is unset/placeholder in $ENV_FILE — run release/gen-keystore.sh first"
	fi
done
info "keystore: $ULTRASCANNER_KEYSTORE_FILE  alias: $ULTRASCANNER_KEY_ALIAS"

# ---------------------------------------------------------------------------
# 3. Show existing tags
# ---------------------------------------------------------------------------
bold "==> Existing $TAG_PREFIX* tags"

git -C "$REPO_ROOT" fetch --tags --quiet 2>/dev/null || warn "could not fetch tags (offline? relay needs the push incantation?) — showing local only"

mapfile -t TAGS < <(git -C "$REPO_ROOT" tag --sort=-v:refname -l "${TAG_PREFIX}*")
if [[ ${#TAGS[@]} -eq 0 ]]; then
	warn "no ${TAG_PREFIX}* tags yet"
	LATEST_TAG=""
else
	LATEST_TAG="${TAGS[0]}"
	for i in "${!TAGS[@]}"; do
		if [[ $i -eq 0 ]]; then
			printf '  %s  \033[32m<- latest\033[0m\n' "${TAGS[$i]}"
		else
			printf '  %s\n' "${TAGS[$i]}"
		fi
	done
	if command -v fzf >/dev/null 2>&1; then
		if confirm "Browse tags in fzf?"; then
			printf '%s\n' "${TAGS[@]}" | fzf --prompt='tag> ' --height=40% --reverse || true
		fi
	fi
fi

# ---------------------------------------------------------------------------
# 4. Prompt for new tag + versionCode
# ---------------------------------------------------------------------------
bold "==> New release"

suggest_tag=""
if [[ -n "$LATEST_TAG" && "$LATEST_TAG" =~ ^${TAG_PREFIX}([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
	suggest_tag="${TAG_PREFIX}${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
fi

while :; do
	read -r -p "New release tag${suggest_tag:+ [$suggest_tag]}: " TAG
	TAG="${TAG:-$suggest_tag}"
	[[ -n "$TAG" ]] || { warn "tag required"; continue; }
	if [[ ! "$TAG" =~ ^${TAG_PREFIX}[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		warn "tag must look like ${TAG_PREFIX}1.2.3"; continue
	fi
	if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
		warn "tag $TAG already exists locally"; continue
	fi
	if [[ -n "$ORIGIN_URL" ]] && git -C "$REPO_ROOT" ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
		warn "tag $TAG already exists on origin"; continue
	fi
	break
done

versionName="${TAG#"$TAG_PREFIX"}"
suggest_code=$(( ${#TAGS[@]} + 1 ))

while :; do
	read -r -p "versionCode [$suggest_code]: " versionCode
	versionCode="${versionCode:-$suggest_code}"
	[[ "$versionCode" =~ ^[0-9]+$ ]] && break
	warn "versionCode must be an integer"
done

# Signing cert fingerprint for the summary (best effort).
cert_sha1="$(keytool -list -v \
	-keystore "$ULTRASCANNER_KEYSTORE_FILE" \
	-storepass "$ULTRASCANNER_KEYSTORE_PASSWORD" \
	-alias "$ULTRASCANNER_KEY_ALIAS" 2>/dev/null | grep -m1 'SHA1:' | sed 's/.*SHA1: //')"

print_summary() {
	bold "-------- release summary --------"
	printf '  tag          %s\n' "$TAG"
	printf '  versionName  %s\n' "$versionName"
	printf '  versionCode  %s\n' "$versionCode"
	printf '  keystore     %s\n' "$ULTRASCANNER_KEYSTORE_FILE"
	printf '  cert SHA1    %s\n' "${cert_sha1:-<unavailable>}"
	printf '  github repo  %s\n' "${GH_REPO:-<none — APK stays local>}"
	printf '  HEAD         %s\n' "$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	bold "--------------------------------"
}
print_summary

confirm "Proceed with build?" || { info "aborted."; exit 0; }

# ---------------------------------------------------------------------------
# 5. Build
# ---------------------------------------------------------------------------
bold "==> Building signed release APK"

if [[ ! -d "$APP_DIR/node_modules" ]]; then
	info "node_modules missing — running npm ci"
	( cd "$APP_DIR" && npm ci )
fi

(
	cd "$APP_ANDROID"
	./gradlew --no-daemon assembleRelease \
		-PversionName="$versionName" \
		-PversionCode="$versionCode"
)

# ---------------------------------------------------------------------------
# 6. Verify artifact
# ---------------------------------------------------------------------------
bold "==> Artifact"

[[ -f "$APK_BUILT" ]] || die "expected APK not found at $APK_BUILT"

# appUpdater.ts's APK_NAME regex (/^ultrascanner.*\.apk$/) matches on this
# uploaded asset's filename, not the raw gradle output name — must start with
# "ultrascanner" or the in-app updater will never find it in the release.
APK_OUT="$SCRIPT_DIR/ultrascanner-$TAG.apk"
cp "$APK_BUILT" "$APK_OUT"
info "copied to $APK_OUT ($(du -h "$APK_OUT" | cut -f1))"

if command -v apksigner >/dev/null 2>&1; then
	apksigner verify --print-certs "$APK_OUT" || warn "apksigner verify reported problems"
else
	warn "apksigner not on PATH — skipping signature verification"
	unzip -l "$APK_OUT" | tail -n +1 | grep -qE 'META-INF/.*\.(RSA|EC|DSA)|META-INF/MANIFEST.MF' \
		&& info "APK contains a signature block" \
		|| warn "no signature block visible in APK"
fi

# ---------------------------------------------------------------------------
# 7. Tag + publish
# ---------------------------------------------------------------------------
bold "==> Publish"
print_summary

if ! confirm "Tag $TAG, push it, and publish the GitHub Release?"; then
	info "not published. Signed APK is at: $APK_OUT"
	exit 0
fi

git -C "$REPO_ROOT" tag -a "$TAG" -m "Scanner app release $versionName"
if [[ -n "$ORIGIN_URL" ]]; then
	if ! git -C "$REPO_ROOT" push origin "$TAG"; then
		warn "could not push tag $TAG to origin (the relay needs the push incantation with SUPERMATRIX_TOKEN)"
		warn "the tag exists locally; the release below still proceeds"
	fi
else
	warn "no git origin — tag kept locally only"
fi

if [[ -z "$GH_REPO" ]]; then
	warn "no GitHub remote and GITHUB_REPO unset — skipping GitHub publish."
	info "The signed APK and local tag are ready. To publish later:"
	info "  gh release create $TAG \"$APK_OUT\" --repo <owner>/<repo> --title \"$TAG\""
	info "To sideload right now: adb install -r $APK_OUT"
	exit 0
fi

if ! gh release create "$TAG" "$APK_OUT" \
	--repo "$GH_REPO" \
	--title "$TAG" \
	--notes "Scanner app release $versionName (versionCode $versionCode)"; then
	warn "gh release create failed — the tag $TAG is pushed; retry with:"
	warn "  gh release create $TAG \"$APK_OUT\" --repo $GH_REPO --title \"$TAG\" --notes \"Scanner app release $versionName (versionCode $versionCode)\""
	exit 1
fi

url="$(gh release view "$TAG" --repo "$GH_REPO" --json url -q .url 2>/dev/null || true)"
bold "==> Done"
info "${url:-release published}"
