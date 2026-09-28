# Nix is the source format; JSON is generated for the worker.
# services.nano.settings = import ./config.example.nix;
# Standalone: nix eval --json --file config.example.nix > config.json
# Keep credentials in a separate secrets.json file, outside the Nix store.
# See docs/config.md for optional settings and cache-warming configuration.
{
  models = {
    umans = {
      provider = "openai";
      model = "umans-glm-5.2";
      base_url = "https://api.code.umans.ai/v1";
      tool_choice = "required";
      enable_thinking = true;
      thinking_effort = "low";
    };
    glm_openrouter = {
      provider = "openrouter";
      model = "zai-org/glm-4.7-flash";
      base_url = "";
      tool_choice = "required";
      referer = "";
      title = "";
      n_ctx = 4096;
      context_margin = 256;
      hard_overflow_tokens = 1024;
    };
    gemini_embedding = {
      provider = "openai";
      model = "google/gemini-embedding-2-preview";
      base_url = "https://openrouter.ai/api/v1";
      dimensions = 3072;
      referer = "";
      title = "";
    };
  };
  server = {
    port = 3000;
    listen = "127.0.0.1";
  };
  agent = {
    name = "nano";
    env = "default";
  };
  frontend = {
    enable = false;
  };
  container = {
    name = "";
    user = "";
  };
  ssh = {
    target = "";
    identity = "";
  };
  model = {
    preset = "umans";
  };
  fallback = {
    preset = "glm_openrouter";
  };
  summary = {
    preset = "glm_openrouter";
  };
  embeddings = {
    preset = "gemini_embedding";
  };
  context = {
    compact_target_tokens = 65000;
    compact_recent_messages = 80;
    compact_chunk_messages = 32;
    compact_summary_max_chars = 16000;
    tool_result_compaction_min_age_turns = 5;
    tool_result_compaction_min_chars = 2000;
    tool_result_compaction_min_context_percent = 50;
  };
  runner = {
    max_turns = 120;
    max_identical_tool_turns = 6;
  };
  image_tool = {
    max_bytes = 150000;
    root = "";
  };
  context_images = {
    markdown = true;
    max_bytes = 5000000;
    max_per_message = 8;
  };
  discord = {
    attach_emoji_bitmap = true;
    wake_on_reaction = true;
    include_user_avatars = false;
    include_bot_avatar = false;
    gateway_enabled = true;
    typing_enabled = true;
    gateway_trace = false;
    gateway_raw_fallback = true;
    gateway_raw_fallback_all = false;
    owner_id = "";
    voice_enabled = false;
    voice_model = "gpt-live-1-codex";
    voice = "juniper";
    scan_channel_ids = [  ];
    wake_on_event = false;
    wake_on_dm = true;
    channel_poll = true;
    batch_interval_ms = 60000;
    batch_only_configured = true;
    pending_auto_seen_minutes = 10;
    batch_scan = true;
    batch_max_messages = 40;
    rest_max_attempts = 3;
    rest_retry_base_ms = 1000;
    bot_user_id = "";
  };
  metrics = {
    retention_days = 3;
  };
}
