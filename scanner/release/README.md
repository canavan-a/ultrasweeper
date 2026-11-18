# scanner/release/

Local signing material and the guided release tool for the scanner Android
app — the same flow as super-badger's `release/`, with the `scanner-v` tag
prefix and `ULTRASCANNER_*` signing env the app's Gradle config reads.

Tracked in git: `release.sh`, `gen-keystore.sh`, `README.md`, `.gitignore`.
**Never** committed: `release.keystore`, `keystore.env`, or any built `.apk`.

## First-time setup

```
./release/gen-keystore.sh
```

Generates `release.keystore` (a real Android signing key, valid ~27 years)
and `keystore.env` (its passwords). Refuses to run again once these exist —
regenerating would produce a *different* key, and Android won't install an
update signed by a different key over an app installed from the old one, so
losing/replacing this keystore means every existing install of the app can
never again be updated in place (only uninstalled and reinstalled fresh).
**Back up `release.keystore` and `keystore.env` somewhere durable outside
this checkout.**

## Cutting a release

```
./release/release.sh
```

(or `npm run release` from `app/`, which just calls this)

The script: checks the toolchain, sources `keystore.env`, lists existing
`scanner-v*` tags, prompts for the new tag (e.g. `scanner-v0.1.0`) and a
`versionCode`, runs the real `./gradlew assembleRelease` with full output,
then — after a single confirmation — creates and pushes the tag and (when a
GitHub target exists) publishes a GitHub Release with the signed APK
attached, named `ultrascanner-<tag>.apk` so the in-app updater's
`APK_NAME` regex finds it.

Unlike super-badger, this repo's `origin` is currently the Super Matrix
relay rather than GitHub, so the GitHub half is conditional: set
`GITHUB_REPO=canavan-a/ultrasweeper` (or give the repo a GitHub remote)
to enable publishing; without it the script stops after the APK and local
tag, and `adb install -r` still gets you the update. A failed tag push to
the relay is a warning, not a stop — tags can be pushed with the normal
relay push incantation afterwards.

Assumes `git`, `java`, the Android SDK/build-tools, and (only when
publishing) `gh` (authenticated). The dev machine builds releases the same
way super-badger does: from a laptop with the Android SDK installed.
