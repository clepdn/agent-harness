/** JSON configuration loading and layering shared by workers and the control plane. */
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigObject
export type ConfigObject = { [key: string]: ConfigValue }

export function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseConfig(text: string): ConfigObject {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Native parser messages can quote the input, including secrets.
    throw new Error("Invalid JSON configuration")
  }
  if (!isConfigObject(value)) throw new Error("Configuration must be a JSON object")
  validateNumbers(value)
  return value
}

function validateNumbers(value: ConfigValue): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Configuration numbers must be finite")
  if (Array.isArray(value)) value.forEach(validateNumbers)
  else if (isConfigObject(value)) Object.values(value).forEach(validateNumbers)
}

/** Objects merge recursively; arrays, nulls, and scalars replace earlier values. */
export function deepMerge(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const result = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const previous = Object.hasOwn(result, key) ? result[key] : undefined
    Object.defineProperty(result, key, {
      value: isConfigObject(previous) && isConfigObject(value) ? deepMerge(previous, value) : value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return result
}
