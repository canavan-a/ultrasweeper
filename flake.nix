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
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            platformio
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
