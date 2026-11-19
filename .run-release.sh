#!/usr/bin/env bash
# Runner for the scanner app release, launched under tmux on framework16.
cd "$HOME/canavan-a/ultrasweeper"
printf 'scanner-v0.1.0\n1\ny\ny\n' | scanner/release/release.sh > /tmp/release.log 2>&1
echo "EXIT=$?" >> /tmp/release.log
touch /tmp/release.done
