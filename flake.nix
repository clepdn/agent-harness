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

		    nodejs = pkgs.nodejs_22;
		    npmDepsHash = "sha256-n7X29VQQGG98vBOKXGvYVTOsyyHeZGBHK8lbFZoOcpE=";

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
			cp -r packages pi apps node_modules package.json tsconfig.json tsconfig.base.json \
			    $out/lib/coral/

			makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/coral \
			    --add-flags "$out/lib/coral/node_modules/.bin/tsx" \
			    --add-flags "$out/lib/coral/packages/niri-runtime/src/index.ts"

			runHook postInstall
		    '';
		};
	    });

	nixosModules.default = { config, pkgs, lib, ... }:
	    let
		cfg            = config.services.coral;
		settingsFormat = pkgs.formats.toml {};
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

		    settings = lib.mkOption {
			type    = settingsFormat.type;
			default = {};
			example = lib.literalExpression ''
			    {
				server.port = 3000;
				agent = {
				    name = "niri";
				    env  = "default";
				};
				discord = {
				    gateway_enabled = true;
				    wake_on_dm      = true;
				    scan_channel_ids = [ "123" "456" ];
				};
			    }
			'';
			description = ''
			    Freeform TOML settings serialized to config.toml and passed via --config.
			    Keys map directly to TOML — use snake_case throughout (e.g. `discord.gateway_enabled`).
			    See config.example.toml in the coral repo for the full schema.

			    Ignored if `configFile` is set explicitly.
			'';
		    };

		    configFile = lib.mkOption {
			type    = lib.types.nullOr lib.types.path;
			default =
			    if cfg.settings == {}
			    then null
			    else settingsFormat.generate "coral-config.toml" cfg.settings;
			defaultText = lib.literalExpression ''
			    if settings == {} then null
			    else (pkgs.formats.toml {}).generate "coral-config.toml" settings
			'';
			description = ''
			    Path to a TOML config file passed via --config.
			    Defaults to a file generated from `settings`; set explicitly to bypass `settings`.
			'';
		    };
		    secretsFile = lib.mkOption {
			type    = lib.types.nullOr lib.types.str;
			default = null;
			description = "Path to a TOML secrets file passed via --secrets.";
		    };
		};

		config = lib.mkIf cfg.enable {
		    environment.systemPackages = with pkgs; [
			xdotool
			imagemagick
		    ];

		    users = {
			users.${cfg.user} = {
			    isNormalUser = true;
			    group        = cfg.group;
			    extraGroups  = [ "wheel" ];
			};
			groups.${cfg.group} = {};
		    };

		    security.sudo = {
			enable             = true;
			wheelNeedsPassword = false;
		    };

		    systemd.services.coral =
			let
			    configFlag  = lib.optionalString (cfg.configFile  != null) " --config ${lib.escapeShellArg cfg.configFile}";
			    secretsFlag = lib.optionalString (cfg.secretsFile != null) " --secrets ${lib.escapeShellArg cfg.secretsFile}";
			in {
			    description = "Coral harness runner";
			    after    = [ "multi-user.target" ];
			    wants    = [ "multi-user.target" ];
			    wantedBy = [ "multi-user.target" ];

			    serviceConfig = {
				User             = cfg.user;
				Group            = cfg.group;
				WorkingDirectory = cfg.homeDir;
				ExecStart        = "${pkgs.bash}/bin/bash -lc '${cfg.package}/bin/coral${configFlag}${secretsFlag}'";
				Restart          = "on-failure";
				RestartSec       = "10s";
			    };
			};
		};
	    };

    in systemOutputs // { inherit nixosModules; };
}
