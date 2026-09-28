# Evaluate option migration and the exact settings passed to the JSON generator.
# nix-instantiate --eval --strict --json tests/cache-policy.nix --arg nixpkgs <path>
{ nixpkgs }:
let
  pkgs = import nixpkgs { system = builtins.currentSystem; };
  lib = pkgs.lib;
  outputs = (import ../flake.nix).outputs {
    self = {};
    nixpkgs = {};
    flake-utils.lib.eachDefaultSystem = _: {};
  };
  testPkgs = pkgs // {
    formats = pkgs.formats // {
      json = args: (pkgs.formats.json args) // {
        # Encode the generator input as an absolute path, without building.
        generate = _: value: "/" + builtins.toJSON value;
      };
    };
  };
  evaluate = settings:
    let result = lib.evalModules {
      specialArgs.pkgs = testPkgs;
      modules = [
        (args: {
          # Evaluate the production options without requiring a full NixOS host.
          options.services.nano = let declared = (outputs.nixosModules.nano args).options.services.nano;
            in { inherit (declared) settings configFile; };
        })
        { services.nano.settings = settings; }
      ];
    };
    path = result.config.services.nano.configFile;
    in if path == null then {} else builtins.fromJSON (lib.removePrefix "/" path);
  migrated = evaluate {
    model.idle_compaction_minutes = 30;
    models.frontend = { idle_compaction_minutes = 50; model = "gpt-6-sol"; };
  };
  modern = evaluate {
    model = { cache_lifetime_minutes = 30; respect_prompt_cache = false; };
    models.frontend = { cache_lifetime_minutes = 30; cache_warming = false; };
  };
  legacyDisabled = evaluate { model.idle_compaction_minutes = 0; };
  priority = evaluate {
    model = { idle_compaction_minutes = lib.mkDefault 50; cache_lifetime_minutes = 30; };
  };
  untouched = evaluate { models.plain.model = "test"; };
in
assert migrated.model == { cache_lifetime_minutes = 30; respect_prompt_cache = true; };
assert migrated.models.frontend == { cache_lifetime_minutes = 50; respect_prompt_cache = true; model = "gpt-6-sol"; };
assert modern.model.respect_prompt_cache == false;
assert modern.models.frontend == { cache_lifetime_minutes = 30; cache_warming = false; };
assert legacyDisabled.model == { cache_lifetime_minutes = 0; respect_prompt_cache = true; };
assert priority.model.cache_lifetime_minutes == 30;
assert untouched == { models.plain.model = "test"; };
assert evaluate {} == {};
{ passed = true; inherit migrated modern legacyDisabled priority untouched; }
