{
    description = "harness for self-modifying agents that's not shit";

    inputs = {
	nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
	flake-utils.url = "github:numtide/flake-utils";
	pi = {
	    url = "git+https://codeberg.org/cowie/tau";
	    flake = false;
	};
    };

    outputs = { self, nixpkgs, flake-utils, pi }:
    let
	systemOutputs = flake-utils.lib.eachDefaultSystem (system:
	    let pkgs = nixpkgs.legacyPackages.${system};
	    in {
		packages.coral = pkgs.buildNpmPackage {
		    pname   = "coral";
		    version = "1.0.0";
		    src     = self;

		    npmDepsHash = "sha256-5v0gD10GzYYlv9vvjNw2nKDS432rLaB40YfRkqdU3KQ=";

		    postPatch = ''
			rm -rf pi
			cp -r ${pi} pi
			chmod -R u+w pi

			# Patch pi-ai to use src instead of dist (tsx handles TS)
			substituteInPlace pi/packages/ai/package.json \
			    --replace-fail './dist/index.js' './src/index.ts' \
			    --replace-fail './dist/index.d.ts' './src/index.ts' \
			    --replace-fail './dist/' './src/'
		    '';

		    nativeBuildInputs = with pkgs; [
			python3      # node-gyp (better-sqlite3, node-pty)
			pkg-config
			makeWrapper
		    ];

		    buildInputs = with pkgs; [
			cairo
			pango
			libjpeg
			giflib
			librsvg
			pixman
		    ];

		    # No build script — ship src and run via tsx.
		    dontNpmBuild = true;

		    installPhase = ''
			runHook preInstall

			mkdir -p $out/lib/coral
			cp -r src packages pi apps node_modules package.json tsconfig.json \
			    $out/lib/coral/

			makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/coral \
			    --add-flags "$out/lib/coral/node_modules/.bin/tsx" \
			    --add-flags "$out/lib/coral/src/index.ts"

			runHook postInstall
		    '';
		};
	    });

	nixosModules.default = { config, pkgs, lib, ... }:
	    let cfg = config.services.coral;
	    in {
		options.services.coral = {
		    enable = lib.mkEnableOption "coral";

		    package = lib.mkOption {
			type        = lib.types.package;
			default     = self.packages.${pkgs.system}.coral;
			defaultText = lib.literalExpression "self.packages.\${pkgs.system}.coral";
		    };

		    user = lib.mkOption {
			type    = lib.types.str;
			default = "coral";
		    };
		    group = lib.mkOption {
			type    = lib.types.str;
			default = "users";
		    };
		    homeDir = lib.mkOption {
			type    = lib.types.str;
			default = "/home/coral";
		    };

		    envFile = lib.mkOption { type = lib.types.str; };
		};

		config = lib.mkIf cfg.enable {
		    users = {
			users.${cfg.user} = {
			    isNormalUser = true;
			    group        = cfg.group;
			};
			groups.${cfg.group} = {};
		    };

		    systemd.services.coral = {
			description = "Coral harness runner";
			after    = [ "multi-user.target" ];
			wants    = [ "multi-user.target" ];
			wantedBy = [ "multi-user.target" ];

			serviceConfig = {
			    User             = cfg.user;
			    Group            = cfg.group;
			    WorkingDirectory = cfg.homeDir;
			    ExecStart        = "${cfg.package}/bin/coral";
			    EnvironmentFile  = cfg.envFile;
			    Restart          = "on-failure";
			    RestartSec       = "10s";
			};
		    };
		};
	    };

    in systemOutputs // { inherit nixosModules; };
}
