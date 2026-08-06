{
    description = "harness for self-modifying agents that's not shit";

    inputs = {
	nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
	flake-utils.url = "github:numtide/flake-utils";
    };

    outputs = { self, nixpkgs, flake-utils }:
    let
	systemOutputs = flake-utils.lib.eachDefaultSystem (system:
	    let pkgs = nixpkgs.legacyPackages.${system};
	    in {
		packages.nano = pkgs.buildNpmPackage {
		    pname   = "nano";
		    version = "1.0.0";
		    src     = self;

		    nodejs = pkgs.nodejs_22;
		    # NOTE: regenerate after any package-lock change — run
		    # `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`,
		    # or `nix build` prints the correct value on mismatch.
		    npmDepsHash = "sha256-WPDTCbrDRaobvYFH68zW26ssEwkpVxQ5Jb9QTY2oSf8=";

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

		    # The app entry runs from src via tsx, but the workspace library packages
		    # (@nano/harness-*, @nano/*) are consumed through their package.json exports,
		    # which point at dist/. Compile those to dist so the runtime can import them.
		    npmBuildScript = "build:packages";

		    installPhase = ''
			runHook preInstall

			mkdir -p $out/lib/nano
			cp -r packages apps node_modules package.json tsconfig.json tsconfig.base.json \
			    $out/lib/nano/

			# Worker — one process per agent, reads its TOML from --config
			makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/nano \
			    --add-flags "$out/lib/nano/node_modules/.bin/tsx" \
			    --add-flags "$out/lib/nano/packages/nano-runtime/src/index.ts"

			# Control plane — spawns one worker per agent file
			makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/nano-server \
			    --add-flags "$out/lib/nano/node_modules/.bin/tsx" \
			    --add-flags "$out/lib/nano/apps/server/src/index.ts"

			# Executor — the tool-execution client. Runs shell/file/image
			# tools over an authenticated HTTP boundary. No LLM, no session.
			makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/nano-executor \
			    --add-flags "$out/lib/nano/node_modules/.bin/tsx" \
			    --add-flags "$out/lib/nano/apps/client/src/index.ts"

			# Bridge — same source, different entry point
			makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/llm-bridge \
			    --add-flags "$out/lib/nano/node_modules/.bin/tsx" \
			    --add-flags "$out/lib/nano/packages/llm-bridge/src/index.ts"

			runHook postInstall
		    '';
		};
	    });

	nixosModules.nano = { config, pkgs, lib, ... }:
	    let
		cfg            = config.services.nano;
		settingsFormat = pkgs.formats.toml {};
		oldContextSettings = [
		    "respect_cache"
		    "compaction_turn_age"
		    "compaction_min_chars"
		];
		defaultContextSettings = {
		    preserve_prompt_cache = true;
		    tool_result_compaction_min_age_turns = 5;
		    tool_result_compaction_min_chars = 2000;
		    tool_result_compaction_min_context_percent = 50;
		};
		settingsType = lib.types.submodule {
		    freeformType = settingsFormat.type;
		    options.context = lib.mkOption {
			type = lib.types.submodule {
			    freeformType = settingsFormat.type;
			    imports = [
				(lib.mkRenamedOptionModule [ "respect_cache" ] [ "preserve_prompt_cache" ])
				(lib.mkRenamedOptionModule [ "compaction_turn_age" ] [ "tool_result_compaction_min_age_turns" ])
				(lib.mkRenamedOptionModule [ "compaction_min_chars" ] [ "tool_result_compaction_min_chars" ])
			    ];
			    options = {
				preserve_prompt_cache = lib.mkOption {
				    type = lib.types.bool;
				    default = true;
				    description = "Preserve the prompt cache by disabling LLM compaction.";
				};
				tool_result_compaction_min_age_turns = lib.mkOption {
				    type = lib.types.ints.positive;
				    default = 5;
				    description = "Minimum age in assistant turns for proactive tool-result compaction.";
				};
				tool_result_compaction_min_chars = lib.mkOption {
				    type = lib.types.ints.positive;
				    default = 2000;
				    description = "Minimum tool-result size eligible for proactive compaction.";
				};
				tool_result_compaction_min_context_percent = lib.mkOption {
				    type = lib.types.addCheck lib.types.number (value: value >= 0 && value <= 100);
				    default = 50;
				    description = "Minimum active context usage percentage for proactive tool-result compaction.";
				};
			    };
			};
		    };
		};
		contextSettings = removeAttrs cfg.settings.context oldContextSettings;
		settingsForToml =
		    removeAttrs cfg.settings [ "context" ]
		    // lib.optionalAttrs (contextSettings != defaultContextSettings) {
			context = contextSettings;
		    };
	    in {
		options.services.nano = {
		    enable = lib.mkEnableOption "nano";

		    package = lib.mkOption {
			type        = lib.types.package;
			default     = self.packages.${pkgs.system}.nano;
			defaultText = lib.literalExpression "self.packages.\${pkgs.system}.nano";
		    };

		    user = lib.mkOption {
			type    = lib.types.str;
			default = "nano";
		    };
		    group = lib.mkOption {
			type    = lib.types.str;
			default = "users";
		    };
		    homeDir = lib.mkOption {
			type    = lib.types.str;
			default = "/home/nano";
		    };

		    settings = lib.mkOption {
			type    = settingsType;
			default = {};
			example = lib.literalExpression ''
			    {
				server.port = 3000;
				agent = {
				    name = "nano";
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
			    See config.example.toml in the nano repo for the full schema.

			    Ignored if `configFile` is set explicitly.
			'';
		    };

		    configFile = lib.mkOption {
			type    = lib.types.nullOr lib.types.path;
			default =
			    if settingsForToml == {}
			    then null
			    else settingsFormat.generate "nano-config.toml" settingsForToml;
			defaultText = lib.literalExpression ''
			    null when normalized settings are empty; otherwise generated TOML
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
		    agents = lib.mkOption {
			type    = lib.types.attrsOf settingsFormat.type;
			default = {};
			example = lib.literalExpression ''
			    {
				nano = { client = "local"; };
				mira  = {
				    client = "http://mira-macbook.local:3002";
				    config = [ "/etc/nano/mira-overrides.toml" ];
				};
			    }
			'';
			description = ''
			    Agents supervised by the control plane, keyed by agent id. Each
			    value is a freeform agent TOML file — see "Agent TOML
			    specification" in the nano README.

			    `config`, `secrets`, `home`, and `workspace` are filled in from
			    this module unless the agent sets them, so every agent shares
			    `settings` as its base runtime config. An agent that sets
			    `config` replaces that list, so include the shared file first
			    if you mean to layer on top of it.

			    `home` defaults to `''${homeDir}/agents/''${id}`. A single-agent
			    deployment migrating from the standalone worker was using
			    `homeDir` itself, so set `home = homeDir` for that agent (or
			    move its soul, memories, state, and nano.db) — otherwise it
			    wakes up with an empty home.

			    Leaving this empty runs a single standalone worker instead of
			    the control plane, which is the original behaviour.
			'';
		    };

		    controlPort = lib.mkOption {
			type    = lib.types.port;
			default = cfg.settings.server.port or 3000;
			defaultText = lib.literalExpression "settings.server.port or 3000";
			description = ''
			    Port the control plane listens on when `agents` is set. Workers
			    are assigned this port plus their file's sorted position unless
			    they declare a `port` of their own.
			'';
		    };

		    executorTokenFile = lib.mkOption {
			type    = lib.types.nullOr lib.types.str;
			default = null;
			description = ''
			    Path to a file holding the shared bearer token used to
			    authenticate to a remote executor (services.nano-executor).
			    Exposed to workers as NANO_EXECUTOR_TOKEN_FILE; the worker
			    sends it as `Authorization: Bearer <token>` when its agent
			    `client` points at an http(s):// executor. Null = local-only.
			'';
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

		    systemd.services.nano =
			let
			    configFlag  = lib.optionalString (cfg.configFile  != null) " --config ${lib.escapeShellArg cfg.configFile}";
			    secretsFlag = lib.optionalString (cfg.secretsFile != null) " --secrets ${lib.escapeShellArg cfg.secretsFile}";

			    # Every agent inherits the shared config and secrets; anything
			    # the agent declares itself wins. Homes must land outside the
			    # read-only store, so they default under the service home.
			    agentFile = id: agent: settingsFormat.generate "nano-agent-${id}.toml" ({
				home      = "${cfg.homeDir}/agents/${id}";
				workspace = cfg.homeDir;
			    }
			    // lib.optionalAttrs (cfg.configFile  != null) { config  = [ cfg.configFile ]; }
			    // lib.optionalAttrs (cfg.secretsFile != null) { secrets = cfg.secretsFile; }
			    // agent);

			    agentDirectory = pkgs.linkFarm "nano-agents" (lib.mapAttrsToList (id: agent: {
				name = "${id}.toml";
				path = agentFile id agent;
			    }) cfg.agents);

			    controlPlane = cfg.agents != {};
			    command =
				if controlPlane
				then "${cfg.package}/bin/nano-server --port ${toString cfg.controlPort} --agents ${agentDirectory}"
				else "${cfg.package}/bin/nano${configFlag}${secretsFlag}";
			in {
			    description = if controlPlane then "Nano control plane" else "Nano harness runner";
			    after    = [ "multi-user.target" ];
			    wants    = [ "multi-user.target" ];
			    wantedBy = [ "multi-user.target" ];

			    serviceConfig = {
				User             = cfg.user;
				Group            = cfg.group;
				WorkingDirectory = cfg.homeDir;
				ExecStart        = "${pkgs.bash}/bin/bash -lc '${command}'";
				Environment      = [
				    "NANO_MANAGED_WORKER=true"
				    "NANO_HOME=${cfg.homeDir}"
				    "NANO_CONTROL_HOME=${cfg.homeDir}/control"
				]
				++ lib.optional (cfg.executorTokenFile != null)
				    "NANO_EXECUTOR_TOKEN_FILE=${cfg.executorTokenFile}";
				Restart          = "always";
				RestartSec       = "10s";
			    };
			};
		};
	    };

nixosModules.nano-executor = { config, pkgs, lib, ... }:
    let
cfg = config.services.nano-executor;
    in {
options.services.nano-executor = {
    enable = lib.mkEnableOption "nano executor (remote tool-execution client)";

    package = lib.mkOption {
type        = lib.types.package;
default     = self.packages.${pkgs.system}.nano;
defaultText = lib.literalExpression "self.packages.\${pkgs.system}.nano";
description = "The nano package providing the nano-executor binary.";
    };

    user = lib.mkOption {
type    = lib.types.str;
default = "nano";
description = "User the executor runs as. Tools execute with this user's privileges.";
    };
    group = lib.mkOption {
type    = lib.types.str;
default = "users";
    };

    workspace = lib.mkOption {
type    = lib.types.str;
default = "/home/nano";
description = "Root directory the executor mounts for file/shell tools.";
    };

    listenAddress = lib.mkOption {
type    = lib.types.str;
default = "0.0.0.0";
description = ''
    Address the executor's HTTP server binds. Defaults to all
    interfaces; restrict to the control-plane-facing address in
    production (the network layer is managed externally).
'';
    };

    port = lib.mkOption {
type    = lib.types.port;
default = 3002;
description = "Port the executor's HTTP tool server listens on.";
    };

    tokenFile = lib.mkOption {
type    = lib.types.nullOr lib.types.str;
default = null;
description = ''
    Path to a file containing the shared bearer token (e.g. an
    agenix secret). When set, every request must present
    `Authorization: Bearer <token>` or it is rejected with 401.
    Leave null only for trusted-loopback dev — a remote executor
    without a token is an open shell.
'';
    };

    capabilities = lib.mkOption {
type    = lib.types.nullOr (lib.types.listOf lib.types.str);
default = null;
example = lib.literalExpression ''[ "shell" "file" "image" ]'';
description = "Tool capabilities the executor exposes. Null = all built-in client tools.";
    };

    hashline = lib.mkOption {
type    = lib.types.bool;
default = false;
description = "Enable hashline-annotated file reads/edits.";
    };

    extraGroups = lib.mkOption {
type    = lib.types.listOf lib.types.str;
default = [ "wheel" ];
description = "Supplementary groups for the executor user (wheel = passwordless sudo for shell tools).";
    };
};

config = lib.mkIf cfg.enable {
    assertions = [
{
    assertion = cfg.tokenFile != null || cfg.listenAddress == "127.0.0.1" || cfg.listenAddress == "localhost";
    message = "services.nano-executor: refusing to bind a tokenless executor to a non-loopback address (${cfg.listenAddress}). Set tokenFile or bind to 127.0.0.1.";
}
    ];

    environment.systemPackages = with pkgs; [ xdotool imagemagick ];

    users = {
users.${cfg.user} = {
    isNormalUser = true;
    group        = cfg.group;
    extraGroups  = cfg.extraGroups;
};
groups.${cfg.group} = {};
    };

    security.sudo = {
enable             = true;
wheelNeedsPassword = false;
    };

    systemd.services.nano-executor =
let
    capsFlag  = lib.optionalString (cfg.capabilities != null) " --capabilities ${lib.escapeShellArg (lib.concatStringsSep "," cfg.capabilities)}";
    tokenFlag = lib.optionalString (cfg.tokenFile != null) " --token-file ${lib.escapeShellArg cfg.tokenFile}";
    hashFlag  = lib.optionalString cfg.hashline " --hashline";
    command   = "${cfg.package}/bin/nano-executor"
+ " --workspace ${lib.escapeShellArg cfg.workspace}"
+ " --host ${lib.escapeShellArg cfg.listenAddress}"
+ " --port ${toString cfg.port}"
+ capsFlag + tokenFlag + hashFlag;
in {
    description = "Nano executor (remote tool-execution client)";
    after    = [ "network.target" ];
    wants    = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
User             = cfg.user;
Group            = cfg.group;
WorkingDirectory = cfg.workspace;
ExecStart        = "${pkgs.bash}/bin/bash -lc '${command}'";
Restart          = "always";
RestartSec       = "10s";
    };
};
};
    };

	nixosModules.llm-bridge = { config, pkgs, lib, ... }:
	    let
		cfg            = config.services.llm-bridge;
		settingsFormat = pkgs.formats.toml {};
	    in {
		options.services.llm-bridge = {
		    enable = lib.mkEnableOption "llm-bridge";

		    package = lib.mkOption {
			type        = lib.types.package;
			default     = self.packages.${pkgs.system}.nano;
			defaultText = lib.literalExpression "self.packages.\${pkgs.system}.nano";
			description = "Package providing the llm-bridge binary. Defaults to the nano package which includes it.";
		    };

		    user = lib.mkOption {
			type    = lib.types.str;
			default = "llm-bridge";
		    };
		    group = lib.mkOption {
			type    = lib.types.str;
			default = "llm-bridge";
		    };

		    settings = lib.mkOption {
			type    = settingsFormat.type;
			default = {};
			example = lib.literalExpression ''
			    {
				host = "0.0.0.0";
				port = 4040;
				providers.umans = {
				    api_key_file = "/run/agenix/umans-key";
				    base_url = "https://api.code.umans.ai/v1";
				};
				providers.openrouter = {
				    api_key_file = "/run/agenix/openrouter-key";
				    base_url = "https://openrouter.ai/api/v1";
				};
			    }
			'';
			description = ''
			    Freeform TOML settings for the bridge config file.
			    Providers are keyed by name as an attrset, e.g. providers.umans = { ... }.
			    Use api_key_file for secrets (NixOS path pattern).
			'';
		    };

		    configFile = lib.mkOption {
			type    = lib.types.nullOr lib.types.path;
			default =
			    if cfg.settings == {}
			    then null
			    else settingsFormat.generate "llm-bridge-config.toml" cfg.settings;
			defaultText = lib.literalExpression ''
			    if settings == {} then null
			    else (pkgs.formats.toml {}).generate "llm-bridge-config.toml" settings
			'';
			description = ''
			    Path to a TOML config file passed via --config.
			    Defaults to a file generated from `settings`.
			'';
		    };

		    keysFile = lib.mkOption {
			type    = lib.types.nullOr lib.types.path;
			default = null;
			description = "Path to a JSON file of API keys for bridge auth. If null, bridge runs open (no auth).";
		    };
		};

		config = lib.mkIf cfg.enable {
		    users = {
			users.${cfg.user} = {
			    isSystemUser = true;
			    group       = cfg.group;
			    home        = "/var/lib/llm-bridge";
			    createHome  = true;
			};
			groups.${cfg.group} = {};
		    };

		    systemd.services.llm-bridge =
			let
			    configFlag = lib.optionalString (cfg.configFile != null) " --config ${lib.escapeShellArg cfg.configFile}";
			    keysFlag   = lib.optionalString (cfg.keysFile   != null) " --keys ${lib.escapeShellArg cfg.keysFile}";
			in {
			    description = "LLM Bridge inference proxy";
			    after    = [ "network.target" ];
			    wantedBy = [ "multi-user.target" ];

			    serviceConfig = {
				User             = cfg.user;
				Group            = cfg.group;
				# OAuth credentials (anthropic, codex) are rotated in place on
				# every token refresh, so they cannot live in the nix store or
				# /run/agenix. StateDirectory gives the admin UI somewhere
				# writable that survives restarts; API keys stay immutable.
				StateDirectory     = "llm-bridge";
				StateDirectoryMode = "0700";
				WorkingDirectory = "/var/lib/llm-bridge";
				ExecStart        = "${pkgs.bash}/bin/bash -lc '${cfg.package}/bin/llm-bridge${configFlag}${keysFlag}'";
				Restart          = "always";
				RestartSec       = "10s";
			    };
			};
		};
	    };

    in systemOutputs // {
      nixosModules = nixosModules // {
        default = nixosModules.nano;
      };
    };
}
