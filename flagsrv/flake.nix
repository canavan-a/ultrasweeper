{
  # flagsrv — the static-flag/notes server (wire spec in ../FLAGS.md).
  # Same pattern as the hello-chud/swag flakes: pinned to this machine's
  # nixpkgs revision so the toolchain is already in the local store.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/ac588ef1c914865dad517b337ea0eb9694a4021c";

  outputs = { self, nixpkgs }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;

      # Go module closure of go.mod (15 modules — the pruned go1.17+
      # graph, not `go list -m all`), fetched from proxy.golang.org: a
      # vendor/ tree would blow the relay snapshot's 1 MiB-per-file
      # limit (modernc.org/sqlite has megabyte-scale source files).
      # The .info hashes are the proxy's, not a local module cache's —
      # the proxy stamps its own fetch time into them.
      proxyFiles = [
      { path = "github.com/dustin/go-humanize/@v/v1.1.0.info"; sha256 = "sha256-EZ16NEuqUZHpfeJXZ9ex2g2C0tXxGxkkE1tP33vJgnc="; }
      { path = "github.com/dustin/go-humanize/@v/v1.1.0.mod"; sha256 = "sha256-c+9SWQ5BIAoRPG+Pv/0QzF65DcDcEdebxdRthb3fnA0="; }
      { path = "github.com/dustin/go-humanize/@v/v1.1.0.zip"; sha256 = "sha256-uHr2YTv/MOm09+e450DqvNkh3uO/C9pWOvInjhvpqu0="; }
      { path = "github.com/google/uuid/@v/v1.6.0.info"; sha256 = "sha256-2Hu7xHU9VtxRvlU/k5Qh0tpc39PHM8iIzduvrvVtcGA="; }
      { path = "github.com/google/uuid/@v/v1.6.0.mod"; sha256 = "sha256-c9pHtjOLAKCC/UUao1oyc9OtwJuOm7qY2rAQkeQCr24="; }
      { path = "github.com/google/uuid/@v/v1.6.0.zip"; sha256 = "sha256-0PAvN3IX9CcC4lloTgZEHtv1FA3dzDS6m+pWA4s4pu0="; }
      { path = "github.com/mattn/go-isatty/@v/v0.0.24.info"; sha256 = "sha256-dqps7k1FS4VlKVEkqAjaquTIBSdaJ4fvR65IlobVDNE="; }
      { path = "github.com/mattn/go-isatty/@v/v0.0.24.mod"; sha256 = "sha256-QbiF9owvpN+yao/6MNCVqTGydpm2srGXSvOUlADcBg8="; }
      { path = "github.com/mattn/go-isatty/@v/v0.0.24.zip"; sha256 = "sha256-T8/+wLrgrUr3v5biSXqBfYXeZK8Z/+Mdgr2jYhSCNLg="; }
      { path = "github.com/mfridman/interpolate/@v/v0.2.0.info"; sha256 = "sha256-pFOLJg18D/ER+QPVgtSPkd2fLzDYLyIJTuQb0lJ9l1o="; }
      { path = "github.com/mfridman/interpolate/@v/v0.2.0.mod"; sha256 = "sha256-n0EZVccUzwWi1kEuD64OyWzqEAU89wYSoJdU5X4OlFU="; }
      { path = "github.com/mfridman/interpolate/@v/v0.2.0.zip"; sha256 = "sha256-jeRJ1qwxSoFqlyw4+5KnMRliGGS/EUMl0dqF2DEHZCA="; }
      { path = "github.com/ncruces/go-strftime/@v/v1.1.0.info"; sha256 = "sha256-CAHwniY7zYggvdd7cQ73EdeiM1jX9Iy+bTI3OQzUxqA="; }
      { path = "github.com/ncruces/go-strftime/@v/v1.1.0.mod"; sha256 = "sha256-r6zNNpBVsEkxesVXAY7W9et9VJkRcsF572WCv9cefsQ="; }
      { path = "github.com/ncruces/go-strftime/@v/v1.1.0.zip"; sha256 = "sha256-blQJPsz0BPskABUyephD24GIv9nkEA7JiDcuieoYOwg="; }
      { path = "github.com/pressly/goose/v3/@v/v3.30.1.info"; sha256 = "sha256-pQyD9nIhP5bCMDXqeF9VZBAA2tYeAdl2EqeHxtZmnsc="; }
      { path = "github.com/pressly/goose/v3/@v/v3.30.1.mod"; sha256 = "sha256-Kl5zzROnb+4nTgu/nX5zs8ipmcHv6D7/7GmuEm5Y/9c="; }
      { path = "github.com/pressly/goose/v3/@v/v3.30.1.zip"; sha256 = "sha256-085MyXXxAcgTZvIpXdaeHjYhdDQJmBV6+BDcaYNoI+U="; }
      { path = "github.com/remyoudompheng/bigfft/@v/v0.0.0-20230129092748-24d4a6f8daec.info"; sha256 = "sha256-HjA2Hlbrjiv9Ro/lQHU6jdPqQQuKBrfpVE8LoPvtuT4="; }
      { path = "github.com/remyoudompheng/bigfft/@v/v0.0.0-20230129092748-24d4a6f8daec.mod"; sha256 = "sha256-ZAHavO2OA3eWEI0oVZv/wG0TUwXNYiLDzqFTdn6pVoA="; }
      { path = "github.com/remyoudompheng/bigfft/@v/v0.0.0-20230129092748-24d4a6f8daec.zip"; sha256 = "sha256-m+FsMsOE1V0Pe9ewPx/x6aTkuRsADwqoelZ6Abm4I5g="; }
      { path = "github.com/sethvargo/go-retry/@v/v0.5.0.info"; sha256 = "sha256-yzIH2hWoVv/PBsc86nfTpwItD9bIDW8jORd4CF9sO5I="; }
      { path = "github.com/sethvargo/go-retry/@v/v0.5.0.mod"; sha256 = "sha256-Z2aL6nzuyMFgYzvoo3oQnVJvK9iONvZUO9127seZwrk="; }
      { path = "github.com/sethvargo/go-retry/@v/v0.5.0.zip"; sha256 = "sha256-lIxCSkMHDqH0xKNDckZU5kNG4Ua7Rnhxxo4gYk+idc4="; }
      { path = "golang.org/x/sync/@v/v0.25.0.info"; sha256 = "sha256-Tz6bWjI3+Z2HPWPYNxwY80T6NDj6IrliB9ZhS4z5daM="; }
      { path = "golang.org/x/sync/@v/v0.25.0.mod"; sha256 = "sha256-/r9P7V3BLA3iRSj3Blvwccx0okJAcBlKryRhe5EGbNo="; }
      { path = "golang.org/x/sync/@v/v0.25.0.zip"; sha256 = "sha256-wn2hfX4hfewML4xxXlziuSgV+nb8CNoTxBpz3Wpn3+A="; }
      { path = "golang.org/x/sys/@v/v0.50.0.info"; sha256 = "sha256-ZtILZrTnk2C3ckd64dz03llARYPgEFIZL3QA+s0DwF0="; }
      { path = "golang.org/x/sys/@v/v0.50.0.mod"; sha256 = "sha256-lSL0yYBtHCZYbqgPpWKSkpvSlYZecZgZJ/UplsaxyDE="; }
      { path = "golang.org/x/sys/@v/v0.50.0.zip"; sha256 = "sha256-sRXooUSnydHfP/uK8gsoPhYoRLW2JKl+40KVXMppueY="; }
      { path = "go.uber.org/multierr/@v/v1.11.0.info"; sha256 = "sha256-YdsRHCuNsHAoUaFwivHoJtO8amvQMiKNurwsEA6cXJw="; }
      { path = "go.uber.org/multierr/@v/v1.11.0.mod"; sha256 = "sha256-WKMN3nMKuldXZxXZCEF3T2NEqHn+xWM6LGazfsMMEfA="; }
      { path = "go.uber.org/multierr/@v/v1.11.0.zip"; sha256 = "sha256-Ikm10v3OYfbuZhpnnYVSWZrwhKdhy7yHHad2Qb3c4MM="; }
      { path = "modernc.org/libc/@v/v1.80.2.info"; sha256 = "sha256-dyQfSavXv+ezmscTYa/3+jRdNJmY2tCJ3TkM/nqRj/o="; }
      { path = "modernc.org/libc/@v/v1.80.2.mod"; sha256 = "sha256-cBqG0ouLT8B3lc1RDZVv3bfLZ7WAcE4kf+jrOzK1vJA="; }
      { path = "modernc.org/libc/@v/v1.80.2.zip"; sha256 = "sha256-FOcsJOFmqIOSLzS59v4qGf4Kurld1qOJVHQFVEMCqkE="; }
      { path = "modernc.org/mathutil/@v/v1.7.1.info"; sha256 = "sha256-HNNroknGW4/nil7LKnLlZMeVrOquU7Jgo4RZgftc2LY="; }
      { path = "modernc.org/mathutil/@v/v1.7.1.mod"; sha256 = "sha256-aGgzhSA/4CBNhTuuYAA8M2cW0lJucUm/WPUYFaJHn9g="; }
      { path = "modernc.org/mathutil/@v/v1.7.1.zip"; sha256 = "sha256-W+DaGOtVehGYv+Nw43Ai8tvbnNxdYxMPyOgzCrJAvS4="; }
      { path = "modernc.org/memory/@v/v1.12.1.info"; sha256 = "sha256-q1ju3taMLWDG2Eby78lDRoSuLi/bhP0yERMHQIsnado="; }
      { path = "modernc.org/memory/@v/v1.12.1.mod"; sha256 = "sha256-6YkNO5eU1Ao3A6qYCe3E4THLtVooMbYCMUB26Rxazpc="; }
      { path = "modernc.org/memory/@v/v1.12.1.zip"; sha256 = "sha256-4lWI8QDZdvt1/5HtuLTqbtg31n/1ql1C5qiJP7MHkKw="; }
      { path = "modernc.org/sqlite/@v/v1.63.0.info"; sha256 = "sha256-/rRJBuTw/mCqL11AjYKKVTxS5YD5LKvdzth3VaUQ1c4="; }
      { path = "modernc.org/sqlite/@v/v1.63.0.mod"; sha256 = "sha256-XPeCnn+ZhTFm+Ho9aaoqLleCjdiumDUvAPy6ub7XCtc="; }
      { path = "modernc.org/sqlite/@v/v1.63.0.zip"; sha256 = "sha256-uUVUz7Vh2l9SECAoyFidXnVIPNDeqnXuIZWhGbgl1BI="; }
      ];

      goproxy = pkgs.runCommand "flagsrv-goproxy" { } (''
        mkdir -p $out
      '' + pkgs.lib.concatMapStrings (f: ''
        mkdir -p "$out/$(dirname '${f.path}')"
        cp ${pkgs.fetchurl { url = "https://proxy.golang.org/${f.path}"; sha256 = f.sha256; }} "$out/${f.path}"
      '') proxyFiles);
    in
    {
      packages.x86_64-linux.default = pkgs.stdenvNoCC.mkDerivation {
        pname = "flagsrv";
        version = "0.1.0";
        src = ./.;
        nativeBuildInputs = [ pkgs.go_1_26 ];

        buildPhase = ''
          runHook preBuild
          GOCACHE=$(mktemp -d) GOMODCACHE=$(mktemp -d) \
          GOPROXY="file://${goproxy}" GOFLAGS=-mod=mod GOSUMDB=off \
          CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o flagsrv .
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin
          cp flagsrv $out/bin/flagsrv-real
          cat > $out/bin/flagsrv <<'EOF'
#!/bin/sh
# Defaults for this host. FLAGSRV_UPLOAD_KEY comes from supermatrix-relay
# nix --env (--env replaces the whole environment, so everything else
# lives here). The -base-path prefix is the flags-CRUD access control:
# guessing the unguessable path is the only gate (FLAGS.md).
exec ''${0%/*}/flagsrv-real \
  -db /var/lib/smx/flagsrv/flags.db \
  -uploads /var/lib/smx/flagsrv/uploads \
  -base-path /a56d555ad143bc7c \
  "$@"
EOF
          chmod +x $out/bin/flagsrv
          runHook postInstall
        '';

        # bin/ has flagsrv + flagsrv-real (the wrapper execs the real one),
        # so the runner needs to be told which is the program.
        meta.mainProgram = "flagsrv";
      };

      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = [ pkgs.go_1_26 ];
      };
    };
}
