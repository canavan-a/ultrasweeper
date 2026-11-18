{
  description = "ultrasweeper - constant-carrier RF sweepers on ESP32 + nRF24L01 (monorepo)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Firmware builds through PlatformIO rather than Nix derivations: the
      # espressif32 platform and its toolchains are fetched by pio itself.
      # The dev shell is the only setup step; entering it, `pio run -e
      # sweeper` (or listener / publisher) must just work from a clean
      # checkout.
      #
      # The Android app (scanner/app) builds through npm/gradle from this
      # same shell. Like super-badger's flake, the Android SDK stays
      # system-provided rather than in the shell: gradle expects an
      # installed SDK + accepted licenses, and a release build happens on
      # the laptop that has one. nodejs_22 + watchman are all the JS side
      # needs.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            platformio
            nodejs_22
            watchman
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
