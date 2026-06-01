{
    description = "harness for self-modifying agents that's not shit";

    inputs = {
	nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
	flake-utils.url = "github:numtile/flake-utils";
    };

    outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system: 
	let pkgs = nixpkgs.legacyPackages.${system};
	    lib = nixpkgs.lib;

	    coral = pkgs.buildNpmPackage {
		pname   = "coral";
		version = "1.0.0";
		src     = ./.;

		# Run `nix build` once; the error will give you the correct hash.
		npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

		nativeBuildInputs = with pkgs; [
		    python3      # node-gyp (better-sqlite3, node-pty)
		    pkg-config
		    makeWrapper
		];

		# Don't run a npm build script — there isn't one; we ship src + tsx.
		dontNpmBuild = true;

		installPhase = ''
		    runHook preInstall

		    mkdir -p $out/lib/coral
		    cp -r src packages pi node_modules package.json tsconfig.json \
			$out/lib/coral/

		    # Wrapper: node <tsx-bin> <entrypoint>
		    makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/coral \
			--add-flags "$out/lib/coral/node_modules/.bin/tsx" \
			--add-flags "$out/lib/coral/src/index.ts"

		    runHook postInstall
		'';
	    };

	in {
	packages.coral = coral;

	nixosModules.default = { config, pkgs, lib }:
	    let cfg = config.services.coral;
	    in {
		options.services.coral = {
		    enable = lib.mkEnableOption "coral";

		    package = lib.mkOption {
			type        = lib.types.package;
			default     = coral;
			description = "The coral package to run.";
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

		    envFile = lib.mkOption {
			type        = lib.types.str;
			description = "Path to the environment file that holds secrets (e.g. /run/secrets/coral.env).";
			example     = "/run/secrets/coral.env";
		    };
		};

		config = lib.mkIf cfg.enable {
		    users = {
			users.${cfg.user} = {
			    isSystemUser = false;
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
    });
}
