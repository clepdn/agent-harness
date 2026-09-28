# One attribute set describes one supervised agent.
# services.nano.agents.mira = import ./agents/mira.example.nix;
# Standalone: nix eval --json --file agents/mira.example.nix > agents/mira.json
# Runtime settings belong in the JSON files referenced by config.
# Keep credentials in the separate JSON file referenced by secrets.
{
  id = "mira";
  name = "Mira";
  home = "./data/agents/mira";
  client = "http://mira-macbook.local:3002";
  config = [ "/etc/nano/config.json" "/etc/nano/agents/mira.json" ];
  secrets = "/run/agenix/nanoSecrets";
  settings = {
    NANO_DISABLE_DISCORD_TOOLS = "false";
  };
}
