/** Hashline configuration — simplified for niri-runtime (no pi-coding-agent dep). */

export type HashlineConfig = {
	hashLength: 2 | 3 | 4;
	grep: boolean;
	replaceText: boolean;
};

export const HASH_LENGTH_MIN = 2;
export const HASH_LENGTH_MAX = 4;

const DEFAULT_CONFIG: HashlineConfig = {
	hashLength: 2,
	grep: false,
	replaceText: true,
};

let _config: HashlineConfig = { ...DEFAULT_CONFIG };

export function getHashLength(): number {
	return _config.hashLength;
}

export function getConfig(): HashlineConfig {
	return _config;
}

export function setConfig(cfg: Partial<HashlineConfig>): void {
	_config = { ...DEFAULT_CONFIG, ...cfg };
}

/** Return example anchor strings for error messages. */
export function exampleAnchor(): string {
	return "9#KT";
}
