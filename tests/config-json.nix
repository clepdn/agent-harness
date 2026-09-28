# Build generated configuration without evaluating or rebuilding a host.
# nix-build tests/config-json.nix --arg nixpkgs <path> --no-out-link
{ nixpkgs }:
let
  pkgs = import nixpkgs { system = builtins.currentSystem; };
  lib = pkgs.lib;
  outputs = (import ../flake.nix).outputs {
    self = {};
    nixpkgs = {};
    flake-utils.lib.eachDefaultSystem = _: {};
  };
  result = lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      outputs.nixosModules.nano
      ({ lib, ... }: {
        # Only the service's output options are needed for this isolated test.
        options = {
          systemd.services = lib.mkOption { type = lib.types.attrsOf lib.types.anything; };
          users.users = lib.mkOption { type = lib.types.attrsOf lib.types.anything; };
          users.groups = lib.mkOption { type = lib.types.attrsOf lib.types.anything; };
          security.sudo = lib.mkOption { type = lib.types.anything; };
          environment.systemPackages = lib.mkOption { type = lib.types.listOf lib.types.package; };
        };
      })
      {
        services.nano = {
          enable = true;
          package = pkgs.emptyDirectory;
          settings = {
            server.listen = "127.0.0.1";
            agent.env = "local";
            models.primary = {
              model = "test-model";
              idle_compaction_minutes = 30;
              cache_warming = false;
            };
            model.preset = "primary";
            subagents = [ { name = "explore"; model = "primary"; } ];
            optional = null;
          };
          secretsFile = "/run/agenix/test-json-secret";
          agents = {
            main.client = "local";
            remote = { client = "https://executor.example.test"; home = "/custom/home"; };
          };
        };
      }
    ];
  };
  configFile = result.config.services.nano.configFile;
  command = result.config.systemd.services.nano.serviceConfig.ExecStart;
  # Matching strips string context; retain the command's derivation dependencies.
  agentDirectory = builtins.appendContext
    (builtins.head (builtins.match ".* --agents ([^ ']+).*" command))
    (builtins.getContext command);
in pkgs.runCommand "nano-json-config-test" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p "$out"
  ln -s ${configFile} "$out/config.json"
  ln -s ${agentDirectory} "$out/agents"
  python - "$out" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
config = json.loads((root / "config.json").read_text())
assert config["models"]["primary"] == {
    "model": "test-model", "cache_lifetime_minutes": 30,
    "respect_prompt_cache": True, "cache_warming": False,
}
assert config["subagents"] == [{"name": "explore", "model": "primary"}]
assert config["optional"] is None
assert sorted(p.name for p in (root / "agents").iterdir()) == ["main.json", "remote.json"]
for name in ["main", "remote"]:
    agent = json.loads((root / "agents" / (name + ".json")).read_text())
    assert agent["config"] == [str((root / "config.json").resolve())]
    assert agent["secrets"] == "/run/agenix/test-json-secret"
assert json.loads((root / "agents/remote.json").read_text())["home"] == "/custom/home"
PY
''
