{
  description = "Kaidong Hu — GitHub profile language card";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            gh
            git
            jq
            nixfmt
          ];

          shellHook = ''
            echo "language-card dev shell — node $(node --version)"
            echo "  node scripts/language-card.mjs --out profile/top-langs.svg"
            echo "  node scripts/language-card.mjs --limit 6 --json   # smoke test"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
