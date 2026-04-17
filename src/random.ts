/**
 * Returns a cryptographically secure random float between 0 (inclusive) and 1 (exclusive).
 * This is a drop-in replacement for Math.random().
 */
export function secureRandom(): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  // 4294967296 is 2^32
  return arr[0] / 4294967296;
}

/**
 * Returns a cryptographically secure random integer between min (inclusive) and max (inclusive).
 * Uses rejection sampling to completely eliminate modulo bias.
 */
export function secureRandomInt(min: number, max: number): number {
  const range = max - min + 1;
  // Calculate the maximum value that provides a fair distribution
  // 0xffffffff is the max value of a 32-bit unsigned integer (2^32 - 1)
  const maxValid = 0xffffffff - (0xffffffff % range);

  const arr = new Uint32Array(1);
  let val: number;

  do {
    crypto.getRandomValues(arr);
    val = arr[0];
  } while (val >= maxValid); // Reject values that would cause modulo bias

  return min + (val % range);
}

/**
 * Shuffles an array in-place using a cryptographically secure Fisher-Yates algorithm.
 * Eliminates modulo bias present in simple `arr[i] % (i + 1)` implementations.
 */
export function shuffle<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i);
    [array[i], array[j]] = [array[j], array[i]];
  }
}
